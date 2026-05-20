import { DynamoDB } from '@aws-sdk/client-dynamodb'
import { google } from 'googleapis'
import {
  dateFromMonthKey,
  getGmailDateQuery,
  getMonthKey,
} from './utils/dateUtils'
import { getSecrets } from './utils/secrets'

const dynamo = new DynamoDB({})
const tableName = process.env.PROCESSING_TABLE_NAME!

const markProcessingComplete = async (monthKey: string) => {
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
      ':timestamp': { S: new Date().toISOString() },
    },
  })
}

export const handler = async (event: { monthKey?: string } = {}) => {
  const secrets = await getSecrets()
  const monthKey = event.monthKey || getMonthKey(new Date())
  const targetDate = event.monthKey
    ? dateFromMonthKey(event.monthKey)
    : new Date()
  const subjectForMonth = `Deutschlandticket ${monthKey}`

  const oauth2Client = new google.auth.OAuth2(
    secrets.GMAIL_CLIENT_ID,
    secrets.GMAIL_CLIENT_SECRET,
  )

  oauth2Client.setCredentials({
    refresh_token: secrets.GMAIL_REFRESH_TOKEN,
  })

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

  try {
    // 0. Sent-folder dedup: skip if a forward for this month already exists.
    //    Protects against re-sending forwards for months that were already
    //    processed before this stack tracked them in DynamoDB.
    const sentSearch = await gmail.users.messages.list({
      userId: 'me',
      q: `in:sent subject:"${subjectForMonth}" to:${secrets.TARGET_EMAIL}`,
    })

    if (sentSearch.data.messages && sentSearch.data.messages.length > 0) {
      console.log(
        `Forward for ${monthKey} already exists in Sent — marking COMPLETE without re-sending.`,
      )
      await markProcessingComplete(monthKey)
      return { monthKey, processed: false, skippedReason: 'already-sent' }
    }

    // 1. Get BVG email
    const bvgQuery = `to:${secrets.BVG_EMAIL} ${getGmailDateQuery(targetDate)}`
    const bvgRes = await gmail.users.messages.list({
      userId: 'me',
      q: bvgQuery,
    })

    if (!bvgRes.data.messages || bvgRes.data.messages.length === 0) {
      throw new Error(`BVG email not found for ${monthKey}`)
    }

    const bvgMessage = await gmail.users.messages.get({
      userId: 'me',
      id: bvgRes.data.messages[0].id!,
      format: 'full',
    })

    const bvgHtmlPart = bvgMessage.data.payload?.parts?.find(
      (part) => part.mimeType === 'text/html',
    )
    const bvgContent = bvgHtmlPart?.body?.data
      ? Buffer.from(bvgHtmlPart.body.data, 'base64').toString('utf-8')
      : 'No BVG content found'

    // 2. Get Charges email
    const chargesQuery = `to:${secrets.CHARGES_EMAIL} ${getGmailDateQuery(
      targetDate,
    )}`
    const chargesRes = await gmail.users.messages.list({
      userId: 'me',
      q: chargesQuery,
    })

    if (!chargesRes.data.messages || chargesRes.data.messages.length === 0) {
      throw new Error(`Charges email not found for ${monthKey}`)
    }

    const chargesMessage = await gmail.users.messages.get({
      userId: 'me',
      id: chargesRes.data.messages[0].id!,
      format: 'full',
    })

    const imagePart = chargesMessage.data.payload?.parts?.find((part) =>
      part.mimeType?.startsWith('image/'),
    )

    if (!imagePart?.body?.attachmentId) {
      throw new Error(`Charges email attachment not found for ${monthKey}`)
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
    const decodedAttachment = Buffer.from(rawAttachmentData, 'base64')
    const standardBase64Attachment = decodedAttachment.toString('base64')

    const attachmentMimeType = imagePart.mimeType!
    const attachmentFilename = imagePart.filename || 'charges.jpg'

    // 5. Construct the MIME email
    const boundary = `boundary-${Date.now()}`
    const emailContent = [
      `From: me`,
      `To: ${secrets.TARGET_EMAIL}`,
      `Cc: ${secrets.MY_EMAIL}`,
      `Subject: ${subjectForMonth}`,
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
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: Buffer.from(emailContent).toString('base64url'),
      },
    })

    // 7. Update processing status in Dynamo
    await markProcessingComplete(monthKey)

    console.log(`Emails processed and status updated for ${monthKey}.`)
    return { monthKey, processed: true }
  } catch (error) {
    console.error(`Error processing emails for ${monthKey}:`, error)
    throw error
  }
}
