export const getMonthKey = (date: Date) => {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export const getGmailDateQuery = (date: Date) => {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  return `after:${year}/${month}/1 before:${year}/${month + 1}/1`
}
