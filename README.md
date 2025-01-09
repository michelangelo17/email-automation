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

## Environment Variables

Create a `.env` file with the following variables:

```plaintext
GMAIL_CLIENT_ID=your_client_id
GMAIL_CLIENT_SECRET=your_client_secret
GMAIL_REFRESH_TOKEN=your_refresh_token
TARGET_EMAIL=recipient@example.com
MY_EMAIL=your@email.com
BVG_EMAIL=bvg@example.com
CHARGES_EMAIL=charges@example.com
```

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
