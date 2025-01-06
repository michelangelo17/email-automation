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
    console.log(
      'BVG query:',
      `to:${process.env.BVG_EMAIL} ${getGmailDateQuery(now)}`
    )
    const bvgRes = await gmail.users.messages.list({
      userId: 'me',
      q: `to:${process.env.BVG_EMAIL} ${getGmailDateQuery(now)}`,
    })
    console.log('BVG response:', JSON.stringify(bvgRes.data, null, 2))
    if (!bvgRes.data.messages?.[0]) {
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
      ? Buffer.from(bvgHtmlPart.body.data, 'base64').toString()
      : null

    // Get Charges email
    console.log(
      'Charges query:',
      `to:${process.env.CHARGES_EMAIL} ${getGmailDateQuery(now)}`
    )
    const chargesRes = await gmail.users.messages.list({
      userId: 'me',
      q: `to:${process.env.CHARGES_EMAIL} ${getGmailDateQuery(now)}`,
    })
    console.log('Charges response:', JSON.stringify(chargesRes.data, null, 2))
    if (!chargesRes.data.messages?.[0]) {
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
    let chargesImage = null
    if (imagePart?.body?.attachmentId) {
      const attachment = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: chargesRes.data.messages[0].id!,
        id: imagePart.body.attachmentId,
      })
      // The attachment data needs to be properly formatted
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
        `Content-Type: ${imagePart.mimeType}`,
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="charges.jpg"',
        '',
        attachment.data.data, // Use the raw base64 data directly
        '',
        '--' + boundary + '--',
      ].join('\r\n')

      // Send the email using Gmail API
      await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: Buffer.from(emailContent).toString('base64url'),
        },
      })
    }

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
