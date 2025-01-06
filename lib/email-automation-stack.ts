import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import { Schedule, Rule } from 'aws-cdk-lib/aws-events'
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets'
import {
  StateMachine,
  Choice,
  Succeed,
  Condition,
} from 'aws-cdk-lib/aws-stepfunctions'
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks'

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
        },
      }
    )
    emailsReceivedTable.grantReadWriteData(updateEmailsReceivedLambda)

    // Lambda: Process Emails
    const processEmailsLambda = new NodejsFunction(this, 'processEmails', {
      environment: {
        PROCESSING_TABLE_NAME: processingStatusTable.tableName,
      },
    })
    processingStatusTable.grantReadWriteData(processEmailsLambda)

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
        outputPath: '$.Payload',
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
                Condition.booleanEquals('$.missingEmails', true),
                updateEmailsReceivedTask.next(processEmailsTask)
              )
              .otherwise(processEmailsTask)
          )
        )
    )

    const stateMachine = new StateMachine(this, 'EmailProcessingStateMachine', {
      definition,
    })

    // EventBridge Rule to Trigger State Machine Daily
    const dailyRule = new Rule(this, 'DailyTriggerRule', {
      schedule: Schedule.expression('cron(0 8 * * ? *)'), // Every day at 8 AM UTC
    })

    dailyRule.addTarget(new LambdaFunction(checkProcessingStatusLambda))

    // Outputs
    new CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
    })
  }
}
