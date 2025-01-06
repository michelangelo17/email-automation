import { DynamoDB } from '@aws-sdk/client-dynamodb'
import { google } from 'googleapis'

const dynamo = new DynamoDB({})
const tableName = process.env.EMAILS_TABLE_NAME!

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID!,
  process.env.GMAIL_CLIENT_SECRET!
)

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN!,
})

const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

export const handler = async (event: any) => {
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
          ? 'to:bvg@michelangelo.codes'
          : 'to:bvgcharges@michelangelo.codes'
      const res = await gmail.users.messages.list({ userId: 'me', q: query })

      if (res.data.messages && res.data.messages.length > 0) {
        console.log(`${emailType} email found.`)
        await dynamo.updateItem({
          TableName: tableName,
          Key: { MonthKey: { S: monthKey }, EmailType: { S: emailType } },
          UpdateExpression: 'SET Received = :received, Timestamp = :timestamp',
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
