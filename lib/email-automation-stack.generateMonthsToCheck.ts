// Produces the list of months for the backfill state machine to iterate over.
// Reads LOOKBACK_START_MONTH (format "YYYY-MM") from env, generates every
// month from there through the current month inclusive.

const lookbackStart = process.env.LOOKBACK_START_MONTH || '2025-01'

export const handler = async () => {
  const match = lookbackStart.match(/^(\d{4})-(\d{2})$/)
  if (!match) {
    throw new Error(
      `Invalid LOOKBACK_START_MONTH '${lookbackStart}' — expected YYYY-MM`,
    )
  }
  const startYear = parseInt(match[1], 10)
  const startMonth = parseInt(match[2], 10)
  if (startMonth < 1 || startMonth > 12) {
    throw new Error(`Invalid month in LOOKBACK_START_MONTH: ${lookbackStart}`)
  }

  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  const months: Array<{ monthKey: string }> = []
  let y = startYear
  let m = startMonth
  while (y < currentYear || (y === currentYear && m <= currentMonth)) {
    months.push({ monthKey: `${y}-${String(m).padStart(2, '0')}` })
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }

  console.log(
    `Generated ${months.length} months to check: ${months[0]?.monthKey} → ${
      months[months.length - 1]?.monthKey
    }`,
  )
  return { months }
}
