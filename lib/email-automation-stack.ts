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
  Map,
  Pass,
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
    //   Per-message header scan via findMessageIdByAlias means we make up to
    //   ~100 metadata calls per alias check — 60s gives plenty of headroom.
    const updateEmailsReceivedLambda = new NodejsFunction(
      this,
      'updateEmailsReceived',
      {
        environment: {
          EMAILS_TABLE_NAME: emailsReceivedTable.tableName,
          SECRET_ARN: secret.secretArn,
        },
        timeout: Duration.seconds(60),
      }
    )
    emailsReceivedTable.grantReadWriteData(updateEmailsReceivedLambda)
    updateEmailsReceivedLambda.addToRolePolicy(secretReadPolicy)
    updateEmailsReceivedLambda.addToRolePolicy(kmsDecryptPolicy)

    // Lambda: Process Emails
    //   Does multiple Gmail calls per run: Sent dedup search, two alias
    //   header scans (~100 metadata calls each), full message fetch x2,
    //   attachment fetch, and the send. 90s is comfortable.
    const processEmailsLambda = new NodejsFunction(this, 'processEmails', {
      environment: {
        PROCESSING_TABLE_NAME: processingStatusTable.tableName,
        EMAILS_TABLE_NAME: emailsReceivedTable.tableName,
        SECRET_ARN: secret.secretArn,
      },
      timeout: Duration.seconds(90),
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

    // ========================================================================
    // Backfill state machine — manually triggered.
    //
    // Iterates over every month from LOOKBACK_START_MONTH through the current
    // month, running the same per-month pipeline as the daily flow. At the
    // end, sends an email report listing any months where source emails are
    // still missing in Gmail, so the user can locate and forward them.
    //
    // The per-month Lambdas accept `monthKey` from event input and fall back
    // to "today's month" when absent — that preserves the daily flow's
    // existing behavior without changes.
    // ========================================================================

    // scanBackfillEmails — combines month-list generation with a Gmail scan
    // that pre-resolves BVG/Charges message IDs per target month using the
    // subject / forwarded-Date / internalDate strategies in
    // listForwardedEmailsByAlias. Needs Gmail credentials so it reads the
    // secret like the other Gmail-touching Lambdas. 5 min timeout because
    // it does up to ~500 full message fetches per alias.
    const scanBackfillEmailsLambda = new NodejsFunction(
      this,
      'scanBackfillEmails',
      {
        environment: {
          LOOKBACK_START_MONTH: '2025-01',
          SECRET_ARN: secret.secretArn,
        },
        timeout: Duration.minutes(5),
        memorySize: 512,
      },
    )
    scanBackfillEmailsLambda.addToRolePolicy(secretReadPolicy)
    scanBackfillEmailsLambda.addToRolePolicy(kmsDecryptPolicy)

    const sendReportLambda = new NodejsFunction(this, 'sendReport', {
      environment: {
        SECRET_ARN: secret.secretArn,
      },
      timeout: Duration.seconds(30),
    })
    sendReportLambda.addToRolePolicy(secretReadPolicy)
    sendReportLambda.addToRolePolicy(kmsDecryptPolicy)

    // Per-state-machine task instances — Step Functions requires unique state
    // names across the entire state machine, and we can't reuse the daily
    // SM's task instances here.
    const bfScanBackfillEmailsTask = new LambdaInvoke(
      this,
      'Backfill Scan Emails Task',
      {
        lambdaFunction: scanBackfillEmailsLambda,
        outputPath: '$.Payload',
      },
    )

    const bfCheckProcessingStatusTask = new LambdaInvoke(
      this,
      'Backfill Check Processing Status Task',
      {
        lambdaFunction: checkProcessingStatusLambda,
        outputPath: '$.Payload',
      },
    )

    const bfProcessEmailsTask = new LambdaInvoke(
      this,
      'Backfill Process Emails Task',
      {
        lambdaFunction: processEmailsLambda,
        outputPath: '$.Payload',
      },
    )

    const bfSendReportTask = new LambdaInvoke(
      this,
      'Backfill Send Report Task',
      {
        lambdaFunction: sendReportLambda,
        outputPath: '$.Payload',
      },
    )

    // Per-month branch — runs inside the Map iterator with one
    // { monthKey, bvgMessageId?, chargesMessageId? } per iteration.
    //
    //   checkProcessingStatus (preserves input fields, adds status)
    //     → COMPLETE: Pass through (sendReport will skip these)
    //     → else: do we have both message IDs from the scan?
    //         → yes: processEmails using those IDs (or Sent-folder dedup)
    //         → no:  Pass through; sendReport will flag the missing
    //                source emails based on which IDs are absent
    const perMonthBranch = bfCheckProcessingStatusTask.next(
      new Choice(this, 'Backfill: Is Month Complete?')
        .when(
          Condition.stringEquals('$.status', 'COMPLETE'),
          new Pass(this, 'Backfill: Month Already Complete'),
        )
        .otherwise(
          new Choice(this, 'Backfill: Are Both Emails Found?')
            .when(
              Condition.and(
                Condition.isPresent('$.bvgMessageId'),
                Condition.isPresent('$.chargesMessageId'),
              ),
              bfProcessEmailsTask,
            )
            .otherwise(new Pass(this, 'Backfill: Month Waiting')),
        ),
    )

    // Map state — iterate over the months list. maxConcurrency: 1 keeps
    // execution sequential, which keeps Gmail rate-limit risk minimal and
    // produces a readable execution timeline.
    const monthMap = new Map(this, 'Backfill: For Each Month', {
      itemsPath: '$.months',
      maxConcurrency: 1,
      resultPath: '$.results',
    })
    monthMap.itemProcessor(perMonthBranch)

    const backfillDefinition = bfScanBackfillEmailsTask
      .next(monthMap)
      .next(bfSendReportTask)

    const backfillStateMachine = new StateMachine(
      this,
      'EmailBackfillStateMachine',
      {
        definition: backfillDefinition,
      },
    )

    // Outputs
    new CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
    })
    new CfnOutput(this, 'BackfillStateMachineArn', {
      value: backfillStateMachine.stateMachineArn,
      description:
        'Manually trigger with: aws stepfunctions start-execution --state-machine-arn <this-arn>',
    })
  }
}
