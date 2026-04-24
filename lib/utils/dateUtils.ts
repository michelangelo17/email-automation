export const getMonthKey = (date: Date) => {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export const getGmailDateQuery = (date: Date) => {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  // Use a Date to roll December (month=12) over to January of the next year
  // correctly — "before:2024/13/1" is not a valid Gmail date query.
  const nextMonthDate = new Date(date.getFullYear(), date.getMonth() + 1, 1)
  const nextYear = nextMonthDate.getFullYear()
  const nextMonth = nextMonthDate.getMonth() + 1
  return `after:${year}/${month}/1 before:${nextYear}/${nextMonth}/1`
}
