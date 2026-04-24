import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib'
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager'
import { IKey } from 'aws-cdk-lib/aws-kms'
import { PolicyStatement } from 'aws-cdk-lib/aws-iam'
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

export interface EmailAutomationStackProps extends StackProps {
  secret: ISecret
  encryptionKey: IKey
}

export class EmailAutomationStack extends Stack {
  constructor(scope: Construct, id: string, props: EmailAutomationStackProps) {
    super(scope, id, props)
    const { secret, encryptionKey } = props

    const secretReadPolicy = new PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [secret.secretArn],
    })
    const kmsDecryptPolicy = new PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [encryptionKey.keyArn],
    })

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
          SECRET_ARN: secret.secretArn,
        },
      }
    )
    emailsReceivedTable.grantReadWriteData(updateEmailsReceivedLambda)
    updateEmailsReceivedLambda.addToRolePolicy(secretReadPolicy)
    updateEmailsReceivedLambda.addToRolePolicy(kmsDecryptPolicy)

    // Lambda: Process Emails
    const processEmailsLambda = new NodejsFunction(this, 'processEmails', {
      environment: {
        PROCESSING_TABLE_NAME: processingStatusTable.tableName,
        EMAILS_TABLE_NAME: emailsReceivedTable.tableName,
        SECRET_ARN: secret.secretArn,
      },
      timeout: Duration.seconds(30),
    })
    processingStatusTable.grantReadWriteData(processEmailsLambda)
    emailsReceivedTable.grantReadWriteData(processEmailsLambda)
    processEmailsLambda.addToRolePolicy(secretReadPolicy)
    processEmailsLambda.addToRolePolicy(kmsDecryptPolicy)

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

    // Second invoke of the same Lambda, after the Gmail fetch, to see
    // whether the update changed the bothReceived status. A separate
    // LambdaInvoke is needed because Step Functions state names must be unique.
    const recheckEmailsReceivedTask = new LambdaInvoke(
      this,
      'Recheck Emails Received Task',
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
    //
    // Linear flow — no loops. The daily EventBridge trigger is the retry
    // mechanism: if emails aren't in Gmail yet, we exit and try again tomorrow.
    //
    //   checkProcessingStatus
    //     → if COMPLETE: Succeed
    //     → else: checkEmailsReceived (read DynamoDB)
    //         → updateEmailsReceived (fetch any missing from Gmail; no-op if none missing)
    //         → recheckEmailsReceived (re-read DynamoDB)
    //         → if bothReceived: processEmails
    //           else: Succeed "Waiting for Emails"
    const definition = checkProcessingStatusTask.next(
      new Choice(this, 'Is Processing Complete?')
        .when(
          Condition.stringEquals('$.status', 'COMPLETE'),
          new Succeed(this, 'Processing Complete')
        )
        .otherwise(
          checkEmailsReceivedTask
            .next(updateEmailsReceivedTask)
            .next(recheckEmailsReceivedTask)
            .next(
              new Choice(this, 'Are Both Received?')
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
