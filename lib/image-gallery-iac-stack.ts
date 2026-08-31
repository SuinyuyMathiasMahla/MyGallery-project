import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as path from 'path';

export class ImageGalleryIacStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // 1. Cognito — this IS the user table. No separate DynamoDB table
    //    for accounts: Cognito already stores email, password hash,
    //    and confirmation state per user.
    // ------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, 'GalleryUserPool', {
      userPoolName: 'image-gallery-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: false,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Public client (browser JS), no secret, plain USER_PASSWORD_AUTH so
    // the frontend can call Cognito's JSON API directly without the
    // Amplify SDK or a build step.
    const userPoolClient = new cognito.UserPoolClient(this, 'GalleryUserPoolClient', {
      userPool,
      generateSecret: false,
      authFlows: {
        userPassword: true,
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // ------------------------------------------------------------------
    // 2. S3 bucket — stores the actual image files
    // ------------------------------------------------------------------
    const bucket = new s3.Bucket(this, 'ImageGalleryBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      cors: [
        {
          allowedOrigins: ['*'], // tighten to your Amplify domain in production
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.DELETE],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });

    // ------------------------------------------------------------------
    // 3. DynamoDB — image metadata, now with an owner and a visibility
    //    flag, plus two GSIs so "my gallery" and "public gallery" are
    //    cheap Query calls instead of a full-table Scan.
    // ------------------------------------------------------------------
    const table = new dynamodb.Table(this, 'ImageVaultTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    });

    table.addGlobalSecondaryIndex({
      indexName: 'OwnerIndex',
      partitionKey: { name: 'ownerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });

    table.addGlobalSecondaryIndex({
      indexName: 'VisibilityIndex',
      partitionKey: { name: 'visibility', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });

    // ------------------------------------------------------------------
    // 4. Lambda functions
    // ------------------------------------------------------------------
    const commonLambdaProps: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        BUCKET_NAME: bucket.bucketName,
        TABLE_NAME: table.tableName,
      },
      bundling: {
        // Bundle every dependency — the managed Lambda runtime does not
        // guarantee @aws-sdk/lib-dynamodb or @aws-sdk/s3-request-presigner,
        // so marking them external crashes every cold start.
        externalModules: [],
        minify: true,
      },
    };

    const createUploadUrlLambda = new nodejs.NodejsFunction(this, 'CreateUploadUrlFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/create-upload-url.ts'),
      handler: 'handler',
    });

    const completeUploadLambda = new nodejs.NodejsFunction(this, 'CompleteUploadFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/complete-upload.ts'),
      handler: 'handler',
    });

    const listPublicImagesLambda = new nodejs.NodejsFunction(this, 'ListPublicImagesFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/list-public-images.ts'),
      handler: 'handler',
    });

    const listMyImagesLambda = new nodejs.NodejsFunction(this, 'ListMyImagesFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/list-my-images.ts'),
      handler: 'handler',
    });

    const deleteImageLambda = new nodejs.NodejsFunction(this, 'DeleteImageFunction', {
      ...commonLambdaProps,
      entry: path.join(__dirname, '../lambda/delete-image.ts'),
      handler: 'handler',
    });

    // ------------------------------------------------------------------
    // 5. IAM — least privilege per function. grantReadData/grantWriteData
    //    automatically cover the table's GSIs too, no extra grants needed.
    // ------------------------------------------------------------------
    bucket.grantPut(createUploadUrlLambda);
    bucket.grantRead(listPublicImagesLambda);
    bucket.grantRead(listMyImagesLambda);
    bucket.grantDelete(deleteImageLambda);

    table.grantWriteData(completeUploadLambda);
    table.grantReadData(listPublicImagesLambda);
    table.grantReadData(listMyImagesLambda);
    table.grantReadWriteData(deleteImageLambda);

    // ------------------------------------------------------------------
    // 6. REST API Gateway — stage, CORS, usage plan, API key, and a
    //    Cognito User Pool authorizer for the protected routes.
    // ------------------------------------------------------------------
    const api = new apigateway.RestApi(this, 'ImageGalleryApi', {
      restApiName: 'Image Gallery Service',
      description: 'API for uploading, listing, and deleting gallery images',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key'],
      },
    });

    api.addGatewayResponse('Default4xxCors', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
        'Access-Control-Allow-Headers': "'*'",
      },
    });
    api.addGatewayResponse('Default5xxCors', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
        'Access-Control-Allow-Headers': "'*'",
      },
    });

    const apiKey = api.addApiKey('ClientApiKey');

    const plan = api.addUsagePlan('UsagePlan', {
      name: 'StandardUsagePlan',
      throttle: { rateLimit: 10, burstLimit: 20 },
      quota: { limit: 10000, period: apigateway.Period.MONTH },
    });
    plan.addApiKey(apiKey);
    plan.addApiStage({ stage: api.deploymentStage });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'GalleryAuthorizer', {
      cognitoUserPools: [userPool],
      identitySource: 'method.request.header.Authorization',
    });

    // Shared method options for routes that require a logged-in user.
    // NOTE: send the raw Cognito ID token in the Authorization header —
    // no "Bearer " prefix — this authorizer's default identity source
    // expects the token value alone.
    const authedMethodOptions: apigateway.MethodOptions = {
      apiKeyRequired: true,
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer,
    };

    const openMethodOptions: apigateway.MethodOptions = {
      apiKeyRequired: true,
    };

    // ------------------------------------------------------------------
    // 7. Routes
    //    POST   /images/upload          (auth) -> presigned S3 upload URL
    //    POST   /images/{id}/complete   (auth) -> save metadata to DynamoDB
    //    GET    /images/public          (open) -> public images, any visitor
    //    GET    /images/mine            (auth) -> caller's own images (public+private)
    //    DELETE /images/{id}            (auth) -> delete, owner-checked
    // ------------------------------------------------------------------
    const imagesResource = api.root.addResource('images');
    const uploadResource = imagesResource.addResource('upload');
    const publicResource = imagesResource.addResource('public');
    const mineResource = imagesResource.addResource('mine');
    const imageItemResource = imagesResource.addResource('{id}');
    const completeResource = imageItemResource.addResource('complete');

    uploadResource.addMethod('POST', new apigateway.LambdaIntegration(createUploadUrlLambda), authedMethodOptions);
    completeResource.addMethod('POST', new apigateway.LambdaIntegration(completeUploadLambda), authedMethodOptions);
    publicResource.addMethod('GET', new apigateway.LambdaIntegration(listPublicImagesLambda), openMethodOptions);
    mineResource.addMethod('GET', new apigateway.LambdaIntegration(listMyImagesLambda), authedMethodOptions);
    imageItemResource.addMethod('DELETE', new apigateway.LambdaIntegration(deleteImageLambda), authedMethodOptions);

    // ------------------------------------------------------------------
    // 8. Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'ApiKeyId', { value: apiKey.keyId });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
  }
}
