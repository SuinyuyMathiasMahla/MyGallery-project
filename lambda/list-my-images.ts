import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);
const s3Client = new S3Client({});

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,Authorization',
  'Access-Control-Allow-Methods': 'OPTIONS,GET',
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userId = event.requestContext.authorizer?.claims?.sub;
    if (!userId) {
      return { statusCode: 401, headers, body: JSON.stringify({ message: 'Unauthorized' }) };
    }

    const queryOutput = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'OwnerIndex',
        KeyConditionExpression: 'ownerId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ScanIndexForward: false,
      })
    );

    const items = queryOutput.Items || [];

    const images = await Promise.all(
      items.map(async (item) => {
        let imageUrl = '';
        if (item.s3Key) {
          const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: item.s3Key,
          });
          imageUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        }

        return {
          id: item.id,
          name: item.name,
          description: item.description,
          createdAt: item.createdAt,
          visibility: item.visibility,
          imageUrl,
        };
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ images }),
    };
  } catch (error: any) {
    console.error('Error listing my images:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: error.message || 'Internal Server Error' }),
    };
  }
};
