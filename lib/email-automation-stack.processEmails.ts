import { DynamoDB } from '@aws-sdk/client-dynamodb'
import { google } from 'googleapis'

const dynamo = new DynamoDB({})
const tableName = process.env.PROCESSING_TABLE_NAME!

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID!,
  process.env.GMAIL_CLIENT_SECRET!
)

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN!,
})

const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

export const handler = async () => {
  const now = new Date()
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    '0'
  )}`

  try {
    // Combine emails
    const bvgEmail = await gmail.users.messages.list({
      userId: 'me',
      q: 'to:bvg@michelangelo.codes',
    })
    const chargesEmail = await gmail.users.messages.list({
      userId: 'me',
      q: 'to:bvgcharges@michelangelo.codes',
    })

    const combinedContent = `
      Dear HR Team,

      Please find the reimbursement details for ${monthKey}:

      BVG Confirmation:
      ${bvgEmail.data.messages?.[0]?.id || 'No BVG email found.'}

      Charges Confirmation:
      ${chargesEmail.data.messages?.[0]?.id || 'No charges email found.'}

      Best regards,
      Automated System
    `

    // Send email to HR
    const encodedEmail = Buffer.from(
      `To: hr@example.com\nSubject: Reimbursement Request for ${monthKey}\n\n${combinedContent}`
    ).toString('base64')

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedEmail },
    })

    // Update processing status
    await dynamo.updateItem({
      TableName: tableName,
      Key: { MonthKey: { S: monthKey } },
      UpdateExpression: 'SET Status = :status, LastUpdated = :timestamp',
      ExpressionAttributeValues: {
        ':status': { S: 'COMPLETE' },
        ':timestamp': { S: now.toISOString() },
      },
    })

    console.log('Emails processed and status marked as complete.')
  } catch (error) {
    console.error('Error processing emails:', error)
    throw error
  }
}
