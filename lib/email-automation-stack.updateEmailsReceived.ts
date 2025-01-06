import { DynamoDB } from '@aws-sdk/client-dynamodb'
import { google } from 'googleapis'
import { getGmailDateQuery } from './utils/dateUtils'

const dynamo = new DynamoDB({})
const tableName = process.env.EMAILS_TABLE_NAME!

export const handler = async (event: any) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID!,
    process.env.GMAIL_CLIENT_SECRET!
  )

  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN!,
  })

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

  const { missingEmails } = event

  if (!missingEmails || missingEmails.length === 0) {
    console.log('No missing emails to fetch.')
    return
  }

  const now = new Date()
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    '0'
  )}`

  try {
    for (const emailType of missingEmails) {
      const query =
        emailType === 'BVG'
          ? `to:${process.env.BVG_EMAIL} ${getGmailDateQuery(now)}`
          : `to:${process.env.CHARGES_EMAIL} ${getGmailDateQuery(now)}`
      const res = await gmail.users.messages.list({ userId: 'me', q: query })

      if (res.data.messages && res.data.messages.length > 0) {
        console.log(`${emailType} email found.`)

        // Get the full message content
        const messageId = res.data.messages[0].id!
        console.log(`${emailType} email found with ID: ${messageId}`)

        await dynamo.updateItem({
          TableName: tableName,
          Key: { MonthKey: { S: monthKey }, EmailType: { S: emailType } },
          UpdateExpression: 'SET Received = :received, #ts = :timestamp',
          ExpressionAttributeNames: {
            '#ts': 'Timestamp',
          },
          ExpressionAttributeValues: {
            ':received': { BOOL: true },
            ':timestamp': { S: now.toISOString() },
          },
        })
      } else {
        console.log(`${emailType} email not found.`)
      }
    }

    console.log('Emails received table updated.')
  } catch (error) {
    console.error('Error updating emails received:', error)
    throw error
  }
}
