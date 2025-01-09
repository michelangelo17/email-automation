# Email Automation CDK Project

This project implements an automated email processing system using AWS CDK and Gmail API. It's designed to monitor specific emails, process them, and forward them to designated recipients on a scheduled basis.

## Architecture

The solution uses several AWS services orchestrated through AWS CDK:

- **AWS Lambda** - For email processing and status checking
- **DynamoDB** - For storing email processing status and tracking
- **Step Functions** - For workflow orchestration
- **EventBridge** - For scheduled execution

### Workflow

1. A daily EventBridge rule triggers the Step Functions workflow at 7 AM UTC
2. The workflow checks if processing is already complete for the current month
3. If not complete, it checks for required emails from specific senders
4. Missing emails are fetched using the Gmail API
5. When all required emails are received, they are processed and forwarded
6. Processing status is updated in DynamoDB

## Prerequisites

- Node.js (v18 or later recommended)
- AWS CLI configured with appropriate credentials
- Gmail API credentials (OAuth2)
- Yarn package manager

## Gmail API Setup

1. Go to Google Cloud Console
2. Create a new project or select existing
3. Enable Gmail API for your project
4. Configure OAuth 2.0 credentials
   - Add authorized redirect URIs
   - Set application type as "Desktop"
5. Download credentials and generate refresh token
6. Required Gmail API scopes:
   - gmail.readonly
   - gmail.send
   - gmail.modify

## Environment Variables

Create a `.env` file in the project root with the following variables:

| Variable            | Required | Description                                   | Example                                      |
| ------------------- | -------- | --------------------------------------------- | -------------------------------------------- |
| GMAIL_CLIENT_ID     | Yes      | OAuth 2.0 Client ID from Google Cloud Console | 123456789-example.apps.googleusercontent.com |
| GMAIL_CLIENT_SECRET | Yes      | OAuth 2.0 Client Secret                       | GOCSPX-your_secret_here                      |
| GMAIL_REFRESH_TOKEN | Yes      | Gmail API refresh token                       | 1//your_refresh_token_here                   |
| TARGET_EMAIL        | Yes      | Primary recipient email address               | recipient@example.com                        |
| MY_EMAIL            | Yes      | CC recipient email address                    | your@email.com                               |
| BVG_EMAIL           | Yes      | Source email for BVG notifications            | bvg@example.com                              |
| CHARGES_EMAIL       | Yes      | Source email for charges notifications        | charges@example.com                          |

Note: All email addresses must be valid and verified in your Gmail account.

## Installation

1. Clone the repository
2. Install dependencies:

```bash
yarn install
```

3. Build the project:

```bash
yarn build
```

## Deployment

Deploy the stack to your AWS account:

```bash
npx cdk deploy
```

## Troubleshooting

Common issues and solutions:

1. **Gmail API Authentication Errors**

   - Verify credentials in .env file
   - Check token expiration
   - Ensure required scopes are enabled

2. **AWS Deployment Issues**

   - Verify AWS credentials
   - Check CloudWatch logs
   - Ensure sufficient IAM permissions

3. **Email Processing Errors**
   - Verify email format requirements
   - Check DynamoDB table permissions
   - Monitor CloudWatch metrics

## Development

### Project Structure

- `bin/` - CDK app entry point
- `lib/` - Stack definition and Lambda functions
- `test/` - Test files
- `cdk.json` - CDK configuration

### Available Commands

- `yarn build` - Compile TypeScript to JavaScript
- `yarn watch` - Watch for changes and compile
- `yarn test` - Run Jest unit tests
- `npx cdk deploy` - Deploy the stack to your AWS account
- `npx cdk diff` - Compare deployed stack with current state
- `npx cdk synth` - Emit the synthesized CloudFormation template

### Adding New Features

1. Define infrastructure changes in `lib/email-automation-stack.ts`
2. Implement Lambda function logic in `lib/email-automation-stack.*.ts` files
3. Update Step Functions workflow as needed
4. Test locally using `yarn test`
5. Deploy changes using `npx cdk deploy`

## Security

- All sensitive information is stored in environment variables
- DynamoDB tables use encryption at rest
- Lambda functions use minimal IAM permissions
- Gmail API uses OAuth2 authentication

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT License
