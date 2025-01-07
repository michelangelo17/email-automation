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
    // 1. Get BVG email
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

    // 2. Get Charges email
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

    if (!imagePart?.body?.attachmentId) {
      throw new Error('Charges email attachment not found')
    }

    // 3. Fetch the image attachment
    const attachment = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: chargesRes.data.messages[0].id!,
      id: imagePart.body.attachmentId!,
    })

    // 4. Convert the attachment to standard Base64
    //    The Gmail API often returns base64url, so decode then re-encode:
    const rawAttachmentData = attachment.data.data || ''
    // Decode from Gmail’s base64url to a Buffer
    const decodedAttachment = Buffer.from(rawAttachmentData, 'base64')
    // Re-encode as standard Base64 for the MIME part
    const standardBase64Attachment = decodedAttachment.toString('base64')

    const attachmentMimeType = imagePart.mimeType!
    const attachmentFilename = imagePart.filename || 'charges.jpg'

    // 5. Construct the MIME email
    const boundary = `boundary-${Date.now()}`
    const emailContent = [
      `From: me`,
      `To: ${process.env.TARGET_EMAIL}`,
      `Cc: ${process.env.MY_EMAIL}`,
      `Subject: Deutschlandticket ${monthKey}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      '',
      bvgContent,
      '',
      `--${boundary}`,
      `Content-Type: ${attachmentMimeType}; name="${attachmentFilename}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${attachmentFilename}"`,
      '',
      standardBase64Attachment,
      '',
      `--${boundary}--`,
    ].join('\r\n')

    // 6. Send the email
    //    Gmail’s “raw” property must be base64-URL encoded.
    //    In Node 18+, .toString('base64url') does that automatically.
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: Buffer.from(emailContent).toString('base64url'),
      },
    })

    // 7. Update processing status in Dynamo
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
