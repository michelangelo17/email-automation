import { google } from 'googleapis'
import { getSecrets } from './utils/secrets'

// Each Map iteration produces one of these shapes:
//   - { monthKey, status: 'COMPLETE', ... }           — already processed
//   - { monthKey, processed: true }                   — processed in this run
//   - { monthKey, processed: false,
//       skippedReason: 'already-sent' }               — Sent-folder dedup hit
//   - { monthKey, status: 'PENDING',
//       bvgMessageId?, chargesMessageId? }            — waiting (one or both
//                                                       source emails missing)
interface MonthResult {
  monthKey: string
  status?: string
  processed?: boolean
  skippedReason?: string
  bvgMessageId?: string
  chargesMessageId?: string
  missingEmails?: string[] // legacy / future-friendly
}

function computeMissing(r: MonthResult): string[] {
  if (r.missingEmails && r.missingEmails.length > 0) return r.missingEmails
  const missing: string[] = []
  if (!r.bvgMessageId) missing.push('BVG')
  if (!r.chargesMessageId) missing.push('Charges')
  return missing
}

function describeMissing(missing: string[]): string {
  if (missing.length === 0) return 'status unknown'
  if (missing.length === 2) return 'BVG and Charges missing'
  return `${missing[0]} missing`
}

export const handler = async (event: {
  months?: Array<{ monthKey: string }>
  results: MonthResult[]
}) => {
  const results = event.results || []

  const incomplete = results.filter(
    (r) =>
      r.status !== 'COMPLETE' &&
      r.processed !== true &&
      r.skippedReason !== 'already-sent',
  )

  if (incomplete.length === 0) {
    console.log('All months caught up — no report needed.')
    return { reportSent: false, incomplete: 0, total: results.length }
  }

  incomplete.sort((a, b) => a.monthKey.localeCompare(b.monthKey))

  const secrets = await getSecrets()
  const oauth2Client = new google.auth.OAuth2(
    secrets.GMAIL_CLIENT_ID,
    secrets.GMAIL_CLIENT_SECRET,
  )
  oauth2Client.setCredentials({ refresh_token: secrets.GMAIL_REFRESH_TOKEN })
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

  const lines = incomplete.map(
    (r) => `  ${r.monthKey}  ->  ${describeMissing(computeMissing(r))}`,
  )

  const body = [
    `Months waiting on source emails in Gmail:`,
    ``,
    ...lines,
    ``,
    `To fix: find these emails and forward them to ${secrets.BVG_EMAIL} or`,
    `${secrets.CHARGES_EMAIL} as appropriate. Then re-run the backfill state`,
    `machine to pick them up.`,
    ``,
    `Months already processed are not listed.`,
  ].join('\n')

  const subject = `Deutschlandticket — missing source emails (${
    incomplete.length
  } month${incomplete.length === 1 ? '' : 's'})`

  const emailContent = [
    `From: me`,
    `To: ${secrets.MY_EMAIL}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    '',
    body,
  ].join('\r\n')

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: Buffer.from(emailContent).toString('base64url'),
    },
  })

  console.log(
    `Report sent to ${secrets.MY_EMAIL}: ${incomplete.length} incomplete month(s) of ${results.length} checked.`,
  )
  return {
    reportSent: true,
    incomplete: incomplete.length,
    total: results.length,
  }
}
