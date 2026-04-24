import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'

export interface EmailAutomationSecrets {
  GMAIL_CLIENT_ID: string
  GMAIL_CLIENT_SECRET: string
  GMAIL_REFRESH_TOKEN: string
  BVG_EMAIL: string
  CHARGES_EMAIL: string
  TARGET_EMAIL: string
  MY_EMAIL: string
}

// Cache secrets for a short window so warm Lambda containers don't hammer
// Secrets Manager, but still pick up rotations within ~15 min.
const CACHE_TTL_MS = 15 * 60 * 1000
let cachedSecrets: EmailAutomationSecrets | null = null
let cacheExpiresAt = 0

export async function getSecrets(): Promise<EmailAutomationSecrets> {
  if (cachedSecrets && Date.now() < cacheExpiresAt) {
    return cachedSecrets
  }
  const secretArn = process.env.SECRET_ARN
  if (!secretArn) {
    throw new Error('SECRET_ARN environment variable is not set')
  }
  const client = new SecretsManagerClient({})
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  )
  const secretString = response.SecretString
  if (!secretString) {
    throw new Error('Secret has no value')
  }
  cachedSecrets = JSON.parse(secretString) as EmailAutomationSecrets
  cacheExpiresAt = Date.now() + CACHE_TTL_MS
  return cachedSecrets
}
