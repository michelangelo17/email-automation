import { DynamoDB } from '@aws-sdk/client-dynamodb'
import { google } from 'googleapis'

const dynamo = new DynamoDB({})
const tableName = process.env.PROCESSING_TABLE_NAME!
const emailsTableName = process.env.EMAILS_TABLE_NAME!

export const handler = async (event: any) => {
  const now = new Date()
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    '0'
  )}`

  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID!,
    process.env.GMAIL_CLIENT_SECRET!
  )

  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN!,
  })

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

  try {
    // Get message IDs from DynamoDB
    const emailsResult = await dynamo.getItem({
      TableName: emailsTableName,
      Key: {
        MonthKey: { S: monthKey },
        EmailType: { S: 'BVG' },
      },
    })
    const bvgMessageId = emailsResult.Item?.MessageId.S

    const chargesResult = await dynamo.getItem({
      TableName: emailsTableName,
      Key: {
        MonthKey: { S: monthKey },
        EmailType: { S: 'Charges' },
      },
    })
    const chargesMessageId = chargesResult.Item?.MessageId.S

    // Get BVG email content
    const bvgMessage = await gmail.users.messages.get({
      userId: 'me',
      id: bvgMessageId!,
      format: 'full',
    })
    const bvgHtmlPart = bvgMessage.data.payload?.parts?.find(
      (part) => part.mimeType === 'text/html'
    )
    const bvgContent = bvgHtmlPart?.body?.data
      ? Buffer.from(bvgHtmlPart.body.data, 'base64').toString()
      : null

    // Get Charges email attachment
    const chargesMessage = await gmail.users.messages.get({
      userId: 'me',
      id: chargesMessageId!,
      format: 'full',
    })
    const imagePart = chargesMessage.data.payload?.parts?.find((part) =>
      part.mimeType?.startsWith('image/')
    )
    let chargesImage = null
    if (imagePart?.body?.attachmentId) {
      const attachment = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: chargesMessageId!,
        id: imagePart.body.attachmentId,
      })
      chargesImage = attachment.data
    }

    // Create email content
    const boundary = 'boundary' + Date.now().toString()
    const emailContent = [
      'Content-Type: multipart/mixed; boundary=' + boundary,
      '',
      '--' + boundary,
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<h2>BVG Ticket and Charges</h2>',
      '<h3>BVG Ticket:</h3>',
      bvgContent || 'No BVG content found',
      '',
      '--' + boundary,
      'Content-Type: image/jpeg',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="charges.jpg"',
      '',
      chargesImage?.data || 'No charges image found',
      '',
      '--' + boundary + '--',
    ].join('\r\n')

    // Send combined email
    const encodedEmail = Buffer.from(
      `To: ${process.env.TARGET_EMAIL}
Subject: BVG Monthly Ticket and Charges
Content-Type: multipart/mixed; boundary=${boundary}

${emailContent}`
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail,
      },
    })

    console.log('Combined email sent successfully')

    // Update processing status
    await dynamo.updateItem({
      TableName: tableName,
      Key: { MonthKey: { S: monthKey } },
      UpdateExpression: 'SET #status = :status, #ts = :timestamp',
      ExpressionAttributeNames: {
        '#status': 'Status',
        '#ts': 'LastUpdated',
      },
      ExpressionAttributeValues: {
        ':status': { S: 'COMPLETE' },
        ':timestamp': { S: now.toISOString() },
      },
    })
  } catch (error) {
    console.error('Error processing emails:', error)
    throw error
  }
}
