import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);
const s3Client = new S3Client({});

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,Authorization',
  'Access-Control-Allow-Methods': 'OPTIONS,DELETE',
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userId = event.requestContext.authorizer?.claims?.sub;
    if (!userId) {
      return { statusCode: 401, headers, body: JSON.stringify({ message: 'Unauthorized' }) };
    }

    const id = event.pathParameters?.id;
    if (!id) {
      return { statusCode: 400, headers, body: JSON.stringify({ message: 'Missing image ID' }) };
    }

    const getResult = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { id },
      })
    );

    if (!getResult.Item) {
      return { statusCode: 404, headers, body: JSON.stringify({ message: 'Image record not found' }) };
    }

    // Ownership check — without this, any logged-in user could delete
    // anyone else's image just by knowing its id.
    if (getResult.Item.ownerId !== userId) {
      return { statusCode: 403, headers, body: JSON.stringify({ message: 'You do not own this image' }) };
    }

    const s3Key = getResult.Item.s3Key;

    if (s3Key) {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: BUCKET_NAME,
          Key: s3Key,
        })
      );
    }

    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { id },
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: 'Image deleted successfully' }),
    };
  } catch (error: any) {
    console.error('Error deleting image:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: error.message || 'Internal Server Error' }),
    };
  }
};
