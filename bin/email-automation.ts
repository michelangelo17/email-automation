#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { EmailAutomationStack } from '../lib/email-automation-stack'
import * as dotenv from 'dotenv'
import { EmailAutomationFragmentStack } from '../lib/email-automation-fragment-stack'
import { SecretReviewStack } from '../lib/secret-review-stack'

// Load environment variables from .env file (used by sr propose and local dev)
dotenv.config()

const app = new cdk.App()

const secretReviewStack = new SecretReviewStack(app, 'SecretReviewStack')
const secret = secretReviewStack.secretReview.getSecret(
  'email-automation',
  'production'
)
const encryptionKey = secretReviewStack.secretReview.encryptionKey

new EmailAutomationStack(app, 'EmailAutomationStack', {
  secret,
  encryptionKey,
})
new EmailAutomationFragmentStack(app, 'EmailAutomationFragmentStack', {
  secret,
  encryptionKey,
})
