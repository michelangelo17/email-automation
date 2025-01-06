import { DynamoDB } from '@aws-sdk/client-dynamodb'

const dynamo = new DynamoDB({})
const tableName = process.env.EMAILS_TABLE_NAME!

export const handler = async () => {
  const now = new Date()
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    '0'
  )}`

  try {
    console.log(`Checking emails received for ${monthKey}.`)

    const result = await dynamo.query({
      TableName: tableName,
      KeyConditionExpression: 'MonthKey = :monthKey',
      ExpressionAttributeValues: {
        ':monthKey': { S: monthKey },
      },
    })

    const items = result.Items || []
    const bvgReceived = items.some(
      (item) => item.EmailType.S === 'BVG' && item.Received?.BOOL === true
    )
    const chargesReceived = items.some(
      (item) => item.EmailType.S === 'Charges' && item.Received?.BOOL === true
    )

    const missingEmails = []
    if (!bvgReceived) missingEmails.push('BVG')
    if (!chargesReceived) missingEmails.push('Charges')

    const bothReceived = bvgReceived && chargesReceived

    console.log(`Missing emails: ${missingEmails.join(', ') || 'None'}`)

    return { missingEmails, bothReceived }
  } catch (error) {
    console.error('Error checking emails received:', error)
    throw error
  }
}
