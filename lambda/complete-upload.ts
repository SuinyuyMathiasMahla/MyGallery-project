import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,Authorization',
  'Access-Control-Allow-Methods': 'OPTIONS,POST',
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const claims = event.requestContext.authorizer?.claims;
    const userId = claims?.sub;
    const userEmail = claims?.email;

    if (!userId) {
      return { statusCode: 401, headers, body: JSON.stringify({ message: 'Unauthorized' }) };
    }

    const id = event.pathParameters?.id;
    if (!id || !event.body) {
      return { statusCode: 400, headers, body: JSON.stringify({ message: 'Missing ID or body' }) };
    }

    const { name, description, key, visibility } = JSON.parse(event.body);

    if (!name || !description || !key) {
      return { statusCode: 400, headers, body: JSON.stringify({ message: 'name, description, and key are required' }) };
    }

    // Default to private on anything missing/invalid — a safe default
    // beats accidentally publishing an image.
    const safeVisibility = visibility === 'public' ? 'public' : 'private';

    const item = {
      id,
      name,
      description,
      s3Key: key,
      ownerId: userId,
      ownerEmail: userEmail || 'unknown',
      visibility: safeVisibility,
      createdAt: new Date().toISOString(),
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      })
    );

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({ message: 'Image recorded successfully', item }),
    };
  } catch (error: any) {
    console.error('Error completing upload:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: error.message || 'Internal Server Error' }),
    };
  }
};
