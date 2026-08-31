#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImageGalleryIacStack } from '../lib/image-gallery-iac-stack';

const app = new cdk.App();

new ImageGalleryIacStack(app, 'ImageGalleryIacStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});
