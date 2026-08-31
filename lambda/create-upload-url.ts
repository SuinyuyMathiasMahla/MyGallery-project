import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

const s3 = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME!;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,Authorization',
  'Access-Control-Allow-Methods': 'OPTIONS,POST',
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Populated by the API Gateway Cognito authorizer from the caller's
    // ID token — this route is protected, so this will always be present.
    const userId = event.requestContext.authorizer?.claims?.sub;
    if (!userId) {
      return { statusCode: 401, headers, body: JSON.stringify({ message: 'Unauthorized' }) };
    }

    if (!event.body) {
      return { statusCode: 400, headers, body: JSON.stringify({ message: 'Missing request body' }) };
    }

    const { fileName, contentType } = JSON.parse(event.body);

    if (!fileName || !contentType) {
      return { statusCode: 400, headers, body: JSON.stringify({ message: 'fileName and contentType are required' }) };
    }

    const id = randomUUID();
    const fileExtension = fileName.split('.').pop() || 'png';
    // Namespaced by user so ownership is visible directly in S3, not just
    // in DynamoDB — makes future per-user bucket policies easy to add.
    const key = `uploads/${userId}/${id}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ id, key, uploadUrl }),
    };
  } catch (error: any) {
    console.error('Error generating presigned URL:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: error.message || 'Internal Server Error' }),
    };
  }
};
