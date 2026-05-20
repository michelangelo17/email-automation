import type { gmail_v1 } from 'googleapis'

// Headers we inspect for the alias. Gmail's `to:` and `deliveredto:` search
// operators normalize alias addresses to the primary account address, so a
// search for an alias returns every email to any address on the same account.
// Each individual message still has the raw recipient in its To/Cc/
// Delivered-To headers, which we can inspect via the messages.get metadata
// API to filter client-side.
const ALIAS_HEADERS = [
  'To',
  'Cc',
  'Delivered-To',
  'X-Original-To',
  'X-Forwarded-To',
]

const MONTH_NAMES: Record<string, number> = {
  // English (Gmail's forward block uses English regardless of locale in
  // most cases, but we accept German too as a safety net.)
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  // German variants seen in the wild
  jän: 1,
  mär: 3,
  mai: 5,
  okt: 10,
  dez: 12,
}

/**
 * Find the first message whose alias matches AND whose target month
 * (parsed via subject / forwarded-body Date / internalDate) equals
 * `monthKey`. Used by the daily flow to avoid mistakenly consuming a
 * backfill forward that arrives today but represents an older month.
 *
 * `baseQuery` should narrow the candidate set — typically the current
 * month's date range. Backfill forwards will still appear in that range
 * (they have an internalDate of today), but their target month will be
 * the old one parsed from body/subject, so they're correctly filtered out.
 */
export async function findMessageIdByAliasForMonth(
  gmail: gmail_v1.Gmail,
  alias: string,
  monthKey: string,
  baseQuery: string,
  maxResults = 100,
): Promise<string | null> {
  const entries = await listForwardedEmailsByAlias(
    gmail,
    alias,
    baseQuery,
    maxResults,
  )
  const match = entries.find((e) => e.targetMonthKey === monthKey)
  return match?.messageId || null
}

/**
 * Scan messages matching `baseQuery` and return every match along with the
 * target month each email belongs to. Designed for the backfill flow where
 * forwarded emails have a "today" internalDate but their content is for an
 * old month.
 *
 * Target month is determined with a layered strategy:
 *   1. Subject contains a YYYY-MM pattern (e.g., partner sends "2025-04")
 *   2. Body contains a forwarded-block "Date: ..." line (Gmail forward)
 *   3. Fall back to the message's internalDate
 */
export async function listForwardedEmailsByAlias(
  gmail: gmail_v1.Gmail,
  alias: string,
  baseQuery: string,
  maxResults = 500,
): Promise<Array<{ messageId: string; targetMonthKey: string }>> {
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: baseQuery,
    maxResults,
  })
  const messages = list.data.messages || []
  if (messages.length === 0) return []

  const aliasLc = alias.toLowerCase()
  const results: Array<{ messageId: string; targetMonthKey: string }> = []

  for (const msg of messages) {
    if (!msg.id) continue
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    })

    if (!messageMatchesAlias(detail.data, aliasLc)) continue

    const headers = detail.data.payload?.headers || []
    const subject =
      headers.find((h) => h.name === 'Subject')?.value || ''
    const bodyText = extractTextFromMessage(detail.data)

    const monthKey =
      parseMonthKeyFromSubject(subject) ||
      parseMonthKeyFromBodyDate(bodyText) ||
      (detail.data.internalDate
        ? monthKeyFromInternalDate(detail.data.internalDate)
        : null)

    if (monthKey) {
      results.push({ messageId: msg.id, targetMonthKey: monthKey })
    }
  }

  if (messages.length >= maxResults) {
    console.warn(
      `listForwardedEmailsByAlias: scanned ${maxResults} messages for '${alias}' — additional matches may exist beyond the scan window.`,
    )
  }

  return results
}

function messageMatchesAlias(
  message: gmail_v1.Schema$Message,
  aliasLc: string,
): boolean {
  const headers = message.payload?.headers || []
  return headers.some(
    (h) =>
      h.name !== null &&
      h.name !== undefined &&
      ALIAS_HEADERS.includes(h.name) &&
      (h.value || '').toLowerCase().includes(aliasLc),
  )
}

function extractTextFromMessage(message: gmail_v1.Schema$Message): string {
  const chunks: string[] = []
  function walk(part: gmail_v1.Schema$MessagePart) {
    if (part.parts) {
      part.parts.forEach(walk)
    }
    if (
      part.body?.data &&
      (part.mimeType === 'text/plain' || part.mimeType === 'text/html')
    ) {
      const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8')
      const cleaned =
        part.mimeType === 'text/html'
          ? decoded
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/p>/gi, '\n')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ')
          : decoded
      chunks.push(cleaned)
    }
  }
  if (message.payload) {
    walk(message.payload as gmail_v1.Schema$MessagePart)
  }
  return chunks.join('\n')
}

function parseMonthKeyFromSubject(subject: string): string | null {
  const m = subject.match(/(\d{4})-(\d{2})/)
  if (!m) return null
  const year = parseInt(m[1], 10)
  const month = parseInt(m[2], 10)
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null
  return `${year}-${String(month).padStart(2, '0')}`
}

function parseMonthKeyFromBodyDate(bodyText: string): string | null {
  // Match the "Date:" line in a forwarded block. Tolerate optional weekday
  // prefix ("Sat, ") and Gmail's "at HH:MM" suffix. Examples:
  //   Date: Sat, 1 Feb 2025 at 16:41
  //   Date: 1 Feb 2025
  //   Datum: 1. Feb. 2025
  //   Sent: 1 February 2025
  const datePattern =
    /(?:^|\n|\s)(?:Date|Datum|Sent):\s+(?:[A-Za-zäöü]+,?\s+)?(\d{1,2})[.\s]+([A-Za-zäöü]+)[.\s]+(\d{4})/i
  const m = bodyText.match(datePattern)
  if (!m) return null
  const monthStr = m[2].toLowerCase().slice(0, 3)
  const year = parseInt(m[3], 10)
  const month = MONTH_NAMES[monthStr]
  if (!month || year < 2000 || year > 2100) return null
  return `${year}-${String(month).padStart(2, '0')}`
}

function monthKeyFromInternalDate(internalDate: string): string {
  const date = new Date(parseInt(internalDate, 10))
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}
