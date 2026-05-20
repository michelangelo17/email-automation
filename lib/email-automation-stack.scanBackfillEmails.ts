// Scan-once backfill planner.
//
// Replaces the simpler "generate list of months" Lambda. This one also
// scans Gmail for the BVG and Charges source emails across the full
// backfill window, and pre-resolves message IDs per target month so that
// the per-month Step Functions branch doesn't need to do its own date
// math — important because forwarded emails arrive today with an
// internalDate of today, regardless of what month the content is for.
//
// Output shape:
//   {
//     months: [
//       { monthKey: '2025-01', bvgMessageId: 'abc', chargesMessageId: 'xyz' },
//       { monthKey: '2025-02', bvgMessageId: 'def' },              // Charges still missing
//       { monthKey: '2025-03' },                                   // both missing
//       ...
//     ]
//   }

import { google } from 'googleapis'
import { listForwardedEmailsByAlias } from './utils/gmail'
import { getSecrets } from './utils/secrets'

const lookbackStart = process.env.LOOKBACK_START_MONTH || '2025-01'

interface MonthEntry {
  monthKey: string
  bvgMessageId?: string
  chargesMessageId?: string
}

function generateMonthKeys(startMonthKey: string): string[] {
  const match = startMonthKey.match(/^(\d{4})-(\d{2})$/)
  if (!match) {
    throw new Error(
      `Invalid LOOKBACK_START_MONTH '${startMonthKey}' — expected YYYY-MM`,
    )
  }
  const startYear = parseInt(match[1], 10)
  const startMonth = parseInt(match[2], 10)
  if (startMonth < 1 || startMonth > 12) {
    throw new Error(`Invalid month in LOOKBACK_START_MONTH: ${startMonthKey}`)
  }

  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  const months: string[] = []
  let y = startYear
  let m = startMonth
  while (y < currentYear || (y === currentYear && m <= currentMonth)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return months
}

export const handler = async () => {
  const secrets = await getSecrets()
  const oauth2Client = new google.auth.OAuth2(
    secrets.GMAIL_CLIENT_ID,
    secrets.GMAIL_CLIENT_SECRET,
  )
  oauth2Client.setCredentials({ refresh_token: secrets.GMAIL_REFRESH_TOKEN })
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

  const monthKeys = generateMonthKeys(lookbackStart)

  // Scan window covers everything from the lookback start through today.
  // Emails received in their original month AND emails forwarded today
  // both fall in this range.
  const [startYearStr, startMonthStr] = lookbackStart.split('-')
  const baseQuery = `after:${startYearStr}/${parseInt(startMonthStr, 10)}/1`

  console.log(
    `Scanning Gmail with base query: '${baseQuery}' for BVG and Charges aliases.`,
  )

  const [bvgEntries, chargesEntries] = await Promise.all([
    listForwardedEmailsByAlias(gmail, secrets.BVG_EMAIL, baseQuery),
    listForwardedEmailsByAlias(
      gmail,
      secrets.CHARGES_EMAIL,
      `has:attachment ${baseQuery}`,
    ),
  ])

  console.log(
    `Found ${bvgEntries.length} BVG candidate(s), ${chargesEntries.length} Charges candidate(s).`,
  )

  // Assemble the per-month plan. Iteration order is sorted, so when multiple
  // candidates exist for one month we deterministically pick the first.
  const monthMap = new Map<string, MonthEntry>()
  for (const mk of monthKeys) {
    monthMap.set(mk, { monthKey: mk })
  }

  for (const entry of bvgEntries) {
    const m = monthMap.get(entry.targetMonthKey)
    if (m && !m.bvgMessageId) m.bvgMessageId = entry.messageId
  }
  for (const entry of chargesEntries) {
    const m = monthMap.get(entry.targetMonthKey)
    if (m && !m.chargesMessageId) m.chargesMessageId = entry.messageId
  }

  const months = monthKeys.map((mk) => monthMap.get(mk)!)

  const withBoth = months.filter(
    (m) => m.bvgMessageId && m.chargesMessageId,
  ).length
  const partial = months.filter(
    (m) =>
      (m.bvgMessageId || m.chargesMessageId) &&
      !(m.bvgMessageId && m.chargesMessageId),
  ).length
  const empty = months.filter(
    (m) => !m.bvgMessageId && !m.chargesMessageId,
  ).length
  console.log(
    `Plan: ${months.length} months total, ${withBoth} with both emails, ${partial} partial, ${empty} empty.`,
  )

  return { months }
}
