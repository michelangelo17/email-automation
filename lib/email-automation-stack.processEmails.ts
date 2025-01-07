import { DynamoDB } from '@aws-sdk/client-dynamodb'
import { google } from 'googleapis'
import { getGmailDateQuery } from './utils/dateUtils'

const dynamo = new DynamoDB({})
const tableName = process.env.PROCESSING_TABLE_NAME!

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
    // Get BVG email
    const bvgQuery = `to:${process.env.BVG_EMAIL} ${getGmailDateQuery(now)}`
    const bvgRes = await gmail.users.messages.list({
      userId: 'me',
      q: bvgQuery,
    })

    if (!bvgRes.data.messages || bvgRes.data.messages.length === 0) {
      throw new Error('BVG email not found')
    }

    const bvgMessage = await gmail.users.messages.get({
      userId: 'me',
      id: bvgRes.data.messages[0].id!,
      format: 'full',
    })

    const bvgHtmlPart = bvgMessage.data.payload?.parts?.find(
      (part) => part.mimeType === 'text/html'
    )
    const bvgContent = bvgHtmlPart?.body?.data
      ? Buffer.from(bvgHtmlPart.body.data, 'base64').toString('utf-8')
      : 'No BVG content found'

    // Get Charges email
    const chargesQuery = `to:${process.env.CHARGES_EMAIL} ${getGmailDateQuery(
      now
    )}`
    const chargesRes = await gmail.users.messages.list({
      userId: 'me',
      q: chargesQuery,
    })

    if (!chargesRes.data.messages || chargesRes.data.messages.length === 0) {
      throw new Error('Charges email not found')
    }

    const chargesMessage = await gmail.users.messages.get({
      userId: 'me',
      id: chargesRes.data.messages[0].id!,
      format: 'full',
    })

    const imagePart = chargesMessage.data.payload?.parts?.find((part) =>
      part.mimeType?.startsWith('image/')
    )

    let attachmentData = ''
    let attachmentMimeType = ''
    if (imagePart?.body?.attachmentId) {
      const attachment = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: chargesRes.data.messages[0].id!,
        id: imagePart.body.attachmentId,
      })

      attachmentData = attachment.data.data!
      attachmentMimeType = imagePart.mimeType!
    } else {
      throw new Error('Charges email attachment not found')
    }

    // Construct the email content
    const boundary = `boundary-${Date.now()}`
    const emailContent = [
      `From: me`,
      `To: ${process.env.TARGET_EMAIL}`,
      `Subject: BVG Ticket and Charges`,
      `Content-Type: multipart/mixed; boundary=${boundary}`,
      '',
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      '',
      `<h2>BVG Ticket and Charges</h2>`,
      `<h3>BVG Ticket:</h3>`,
      bvgContent,
      '',
      `--${boundary}`,
      `Content-Type: ${attachmentMimeType}; name="charges.jpg"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="charges.jpg"`,
      '',
      attachmentData,
      '',
      `--${boundary}--`,
    ].join('\r\n')

    // Send the email using Gmail API
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: Buffer.from(emailContent).toString('base64url'),
      },
    })

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

    console.log('Emails processed and status updated successfully.')
  } catch (error) {
    console.error('Error processing emails:', error)
    throw error
  }
}
