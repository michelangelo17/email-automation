import { DynamoDB } from '@aws-sdk/client-dynamodb'
import { getMonthKey } from './utils/dateUtils'

const dynamo = new DynamoDB({})
const tableName = process.env.PROCESSING_TABLE_NAME!

export const handler = async (
  event: {
    monthKey?: string
    bvgMessageId?: string
    chargesMessageId?: string
  } = {},
) => {
  const monthKey = event.monthKey || getMonthKey(new Date())

  try {
    console.log(`Checking processing status for ${monthKey}.`)

    const result = await dynamo.getItem({
      TableName: tableName,
      Key: {
        MonthKey: { S: monthKey },
      },
    })

    const status = result.Item?.Status?.S || 'PENDING'

    console.log(`Processing status for ${monthKey}: ${status}`)
    // Preserve input fields (bvgMessageId, chargesMessageId from backfill)
    // so the per-month state machine branch can read them downstream.
    return { ...event, monthKey, status }
  } catch (error) {
    console.error('Error checking processing status:', error)
    throw error
  }
}
