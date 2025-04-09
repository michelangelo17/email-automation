import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import { Runtime } from 'aws-cdk-lib/aws-lambda'
import { Schedule, Rule } from 'aws-cdk-lib/aws-events'
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets'
import {
  StateMachine,
  Choice,
  Succeed,
  Condition,
  StateMachineFragment,
  State,
  INextable,
} from 'aws-cdk-lib/aws-stepfunctions'
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks'
import { Duration } from 'aws-cdk-lib'
import * as path from 'path'

// Fragment for checking processing status
class CheckProcessingStatusFragment extends StateMachineFragment {
  public readonly startState: State
  public readonly endStates: INextable[]

  constructor(
    scope: Construct,
    id: string,
    props: { lambdaFunction: NodejsFunction }
  ) {
    super(scope, id)

    const checkProcessingStatusTask = new LambdaInvoke(
      this,
      'Check Processing Status Task',
      {
        lambdaFunction: props.lambdaFunction,
        outputPath: '$.Payload',
      }
    )

    this.startState = checkProcessingStatusTask
    this.endStates = [checkProcessingStatusTask]
  }
}

// Fragment for checking emails received
class CheckEmailsReceivedFragment extends StateMachineFragment {
  public readonly startState: State
  public readonly endStates: INextable[]

  constructor(
    scope: Construct,
    id: string,
    props: { lambdaFunction: NodejsFunction }
  ) {
    super(scope, id)

    const checkEmailsReceivedTask = new LambdaInvoke(
      this,
      'Check Emails Received Task',
      {
        lambdaFunction: props.lambdaFunction,
        outputPath: '$.Payload',
      }
    )

    this.startState = checkEmailsReceivedTask
    this.endStates = [checkEmailsReceivedTask]
  }
}

// Fragment for updating emails received
class UpdateEmailsReceivedFragment extends StateMachineFragment {
  public readonly startState: State
  public readonly endStates: INextable[]

  constructor(
    scope: Construct,
    id: string,
    props: { lambdaFunction: NodejsFunction }
  ) {
    super(scope, id)

    const updateEmailsReceivedTask = new LambdaInvoke(
      this,
      'Update Emails Received Task',
      {
        lambdaFunction: props.lambdaFunction,
      }
    )

    this.startState = updateEmailsReceivedTask
    this.endStates = [updateEmailsReceivedTask]
  }
}

// Fragment for processing emails
class ProcessEmailsFragment extends StateMachineFragment {
  public readonly startState: State
  public readonly endStates: INextable[]

  constructor(
    scope: Construct,
    id: string,
    props: { lambdaFunction: NodejsFunction }
  ) {
    super(scope, id)

    const processEmailsTask = new LambdaInvoke(this, 'Process Emails Task', {
      lambdaFunction: props.lambdaFunction,
      outputPath: '$.Payload',
    })

    this.startState = processEmailsTask
    this.endStates = [processEmailsTask]
  }
}

// Main workflow fragment
class EmailProcessingWorkflowFragment extends StateMachineFragment {
  public readonly startState: State
  public readonly endStates: INextable[]

  constructor(
    scope: Construct,
    id: string,
    props: {
      checkProcessingStatusLambda: NodejsFunction
      checkEmailsReceivedLambda: NodejsFunction
      updateEmailsReceivedLambda: NodejsFunction
      processEmailsLambda: NodejsFunction
    }
  ) {
    super(scope, id)

    const checkProcessingStatus = new CheckProcessingStatusFragment(
      this,
      'CheckProcessingStatus',
      {
        lambdaFunction: props.checkProcessingStatusLambda,
      }
    )

    const checkEmailsReceived = new CheckEmailsReceivedFragment(
      this,
      'CheckEmailsReceived',
      {
        lambdaFunction: props.checkEmailsReceivedLambda,
      }
    )

    const updateEmailsReceived = new UpdateEmailsReceivedFragment(
      this,
      'UpdateEmailsReceived',
      {
        lambdaFunction: props.updateEmailsReceivedLambda,
      }
    )

    const processEmails = new ProcessEmailsFragment(this, 'ProcessEmails', {
      lambdaFunction: props.processEmailsLambda,
    })

    const definition = checkProcessingStatus.next(
      new Choice(this, 'Is Processing Complete?')
        .when(
          Condition.stringEquals('$.status', 'COMPLETE'),
          new Succeed(this, 'Processing Complete')
        )
        .otherwise(
          checkEmailsReceived.next(
            new Choice(this, 'Are Emails Missing?')
              .when(
                Condition.isPresent('$.missingEmails[0]'),
                updateEmailsReceived.next(checkEmailsReceived)
              )
              .when(
                Condition.booleanEquals('$.bothReceived', true),
                processEmails
              )
              .otherwise(new Succeed(this, 'Waiting for Emails'))
          )
        )
    )

    this.startState = definition.startState
    this.endStates = definition.endStates
  }
}

export class EmailAutomationFragmentStack extends Stack {
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
        runtime: Runtime.NODEJS_20_X,
        entry: path.join(
          __dirname,
          'email-automation-stack.checkProcessingStatus.ts'
        ),
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
        runtime: Runtime.NODEJS_20_X,
        entry: path.join(
          __dirname,
          'email-automation-stack.checkEmailsReceived.ts'
        ),
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
        runtime: Runtime.NODEJS_20_X,
        entry: path.join(
          __dirname,
          'email-automation-stack.updateEmailsReceived.ts'
        ),
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
      runtime: Runtime.NODEJS_20_X,
      entry: path.join(__dirname, 'email-automation-stack.processEmails.ts'),
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

    // Create the workflow fragment
    const workflow = new EmailProcessingWorkflowFragment(
      this,
      'EmailProcessingWorkflow',
      {
        checkProcessingStatusLambda,
        checkEmailsReceivedLambda,
        updateEmailsReceivedLambda,
        processEmailsLambda,
      }
    )

    // Create the state machine
    const stateMachine = new StateMachine(this, 'EmailProcessingStateMachine', {
      definition: workflow,
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
