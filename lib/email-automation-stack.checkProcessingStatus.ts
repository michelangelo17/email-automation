import { DynamoDB } from '@aws-sdk/client-dynamodb'

const dynamo = new DynamoDB({})
const tableName = process.env.PROCESSING_TABLE_NAME!

export const handler = async () => {
  const now = new Date()
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    '0'
  )}`

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
    return { status }
  } catch (error) {
    console.error('Error checking processing status:', error)
    throw error
  }
}
