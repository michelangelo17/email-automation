import { DynamoDB } from '@aws-sdk/client-dynamodb'
import { google } from 'googleapis'
import {
  dateFromMonthKey,
  getGmailDateQuery,
  getMonthKey,
} from './utils/dateUtils'
import { findMessageIdByAliasForMonth } from './utils/gmail'
import { getSecrets } from './utils/secrets'

const dynamo = new DynamoDB({})
const tableName = process.env.EMAILS_TABLE_NAME!

export const handler = async (
  event: { monthKey?: string; missingEmails?: string[] } = {},
) => {
  const secrets = await getSecrets()
  const oauth2Client = new google.auth.OAuth2(
    secrets.GMAIL_CLIENT_ID,
    secrets.GMAIL_CLIENT_SECRET,
  )

  oauth2Client.setCredentials({
    refresh_token: secrets.GMAIL_REFRESH_TOKEN,
  })

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

  const { missingEmails } = event
  const monthKey = event.monthKey || getMonthKey(new Date())
  const targetDate = event.monthKey
    ? dateFromMonthKey(event.monthKey)
    : new Date()

  if (!missingEmails || missingEmails.length === 0) {
    console.log(`No missing emails to fetch for ${monthKey}.`)
    // Return an object (not undefined) so downstream outputPath: '$.Payload'
    // resolves to {monthKey} rather than null.
    return { monthKey }
  }

  try {
    for (const emailType of missingEmails) {
      // Gmail's search collapses our aliases (bvg@, bvgcharges@ are aliases
      // of the primary account), and a backfill forward sent today lives in
      // today's date range despite being for an old month. The month-aware
      // helper does a broad list, checks each message's actual recipient
      // headers client-side, AND parses each message's target month so that
      // we only accept matches whose target month equals `monthKey`.
      const alias =
        emailType === 'BVG' ? secrets.BVG_EMAIL : secrets.CHARGES_EMAIL
      const dateRange = getGmailDateQuery(targetDate)
      // Narrow Charges with has:attachment since we require an image
      // attachment downstream; this trims the scan substantially.
      const baseQuery =
        emailType === 'Charges' ? `has:attachment ${dateRange}` : dateRange

      const messageId = await findMessageIdByAliasForMonth(
        gmail,
        alias,
        monthKey,
        baseQuery,
      )

      if (messageId) {
        console.log(
          `${emailType} email found for ${monthKey} with ID: ${messageId}`,
        )

        await dynamo.updateItem({
          TableName: tableName,
          Key: { MonthKey: { S: monthKey }, EmailType: { S: emailType } },
          UpdateExpression: 'SET Received = :received, #ts = :timestamp',
          ExpressionAttributeNames: {
            '#ts': 'Timestamp',
          },
          ExpressionAttributeValues: {
            ':received': { BOOL: true },
            ':timestamp': { S: new Date().toISOString() },
          },
        })
      } else {
        console.log(`${emailType} email not found for ${monthKey}.`)
      }
    }

    console.log(`Emails received table updated for ${monthKey}.`)
    return { monthKey }
  } catch (error) {
    console.error('Error updating emails received:', error)
    throw error
  }
}
