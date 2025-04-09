#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { EmailAutomationStack } from '../lib/email-automation-stack'
import * as dotenv from 'dotenv'
import { EmailAutomationFragmentStack } from '../lib/email-automation-fragment-stack'

// Load environment variables from .env file
dotenv.config()

// Verify environment variables are loaded
if (
  !process.env.GMAIL_CLIENT_ID ||
  !process.env.GMAIL_CLIENT_SECRET ||
  !process.env.GMAIL_REFRESH_TOKEN
) {
  throw new Error('Missing required Gmail environment variables')
}

const app = new cdk.App()
new EmailAutomationStack(app, 'EmailAutomationStack')
new EmailAutomationFragmentStack(app, 'EmailAutomationFragmentStack')
