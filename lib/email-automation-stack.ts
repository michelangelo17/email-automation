import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import { Schedule, Rule } from 'aws-cdk-lib/aws-events'
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets'
import {
  StateMachine,
  Choice,
  Succeed,
  Condition,
} from 'aws-cdk-lib/aws-stepfunctions'
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks'
import { Duration } from 'aws-cdk-lib'

export class EmailAutomationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // DynamoDB: Emails Received Table
    const emailsReceivedTable = new Table(this, 'EmailsReceivedTable', {
      partitionKey: { name: 'MonthKey', type: AttributeType.STRING },
      sortKey: { name: 'EmailType', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
    })

    // DynamoDB: Processing Status Table
    const processingStatusTable = new Table(this, 'ProcessingStatusTable', {
      partitionKey: { name: 'MonthKey', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
    })

    // Lambda: Check Processing Status
    const checkProcessingStatusLambda = new NodejsFunction(
      this,
      'checkProcessingStatus',
      {
        environment: {
          PROCESSING_TABLE_NAME: processingStatusTable.tableName,
        },
      }
    )
    processingStatusTable.grantReadWriteData(checkProcessingStatusLambda)

    // Lambda: Check Emails Received
    const checkEmailsReceivedLambda = new NodejsFunction(
      this,
      'checkEmailsReceived',
      {
        environment: {
          EMAILS_TABLE_NAME: emailsReceivedTable.tableName,
        },
      }
    )
    emailsReceivedTable.grantReadWriteData(checkEmailsReceivedLambda)

    // Lambda: Update Emails Received
    const updateEmailsReceivedLambda = new NodejsFunction(
      this,
      'updateEmailsReceived',
      {
        environment: {
          EMAILS_TABLE_NAME: emailsReceivedTable.tableName,
          GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID!,
          GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET!,
          GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN!,
          BVG_EMAIL: process.env.BVG_EMAIL!,
          CHARGES_EMAIL: process.env.CHARGES_EMAIL!,
        },
      }
    )
    emailsReceivedTable.grantReadWriteData(updateEmailsReceivedLambda)

    // Lambda: Process Emails
    const processEmailsLambda = new NodejsFunction(this, 'processEmails', {
      environment: {
        PROCESSING_TABLE_NAME: processingStatusTable.tableName,
        EMAILS_TABLE_NAME: emailsReceivedTable.tableName,
        GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID!,
        GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET!,
        GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN!,
        TARGET_EMAIL: process.env.TARGET_EMAIL!,
        MY_EMAIL: process.env.MY_EMAIL!,
        BVG_EMAIL: process.env.BVG_EMAIL!,
        CHARGES_EMAIL: process.env.CHARGES_EMAIL!,
      },
      timeout: Duration.seconds(30),
    })
    processingStatusTable.grantReadWriteData(processEmailsLambda)
    emailsReceivedTable.grantReadWriteData(processEmailsLambda)

    // Step Functions Tasks
    const checkProcessingStatusTask = new LambdaInvoke(
      this,
      'Check Processing Status Task',
      {
        lambdaFunction: checkProcessingStatusLambda,
        outputPath: '$.Payload',
      }
    )

    const checkEmailsReceivedTask = new LambdaInvoke(
      this,
      'Check Emails Received Task',
      {
        lambdaFunction: checkEmailsReceivedLambda,
        outputPath: '$.Payload',
      }
    )

    const updateEmailsReceivedTask = new LambdaInvoke(
      this,
      'Update Emails Received Task',
      {
        lambdaFunction: updateEmailsReceivedLambda,
      }
    )

    const processEmailsTask = new LambdaInvoke(this, 'Process Emails Task', {
      lambdaFunction: processEmailsLambda,
      outputPath: '$.Payload',
    })

    // Step Functions Workflow
    const definition = checkProcessingStatusTask.next(
      new Choice(this, 'Is Processing Complete?')
        .when(
          Condition.stringEquals('$.status', 'COMPLETE'),
          new Succeed(this, 'Processing Complete')
        )
        .otherwise(
          checkEmailsReceivedTask.next(
            new Choice(this, 'Are Emails Missing?')
              .when(
                Condition.isPresent('$.missingEmails[0]'),
                updateEmailsReceivedTask.next(checkEmailsReceivedTask)
              )
              .when(
                Condition.booleanEquals('$.bothReceived', true),
                processEmailsTask
              )
              .otherwise(new Succeed(this, 'Waiting for Emails'))
          )
        )
    )

    const stateMachine = new StateMachine(this, 'EmailProcessingStateMachine', {
      definition,
    })

    // EventBridge Rule to Trigger State Machine Daily
    const dailyRule = new Rule(this, 'DailyTriggerRule', {
      schedule: Schedule.expression('cron(0 7 * * ? *)'), // Every day at 7 AM UTC
    })

    dailyRule.addTarget(new SfnStateMachine(stateMachine))

    // Outputs
    new CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
    })
  }
}
