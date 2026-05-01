const SQL_FILTER_KEYWORDS = [
  'AND',
  'OR',
  'NOT',
  'LIKE',
  'IN',
  'IS',
  'NULL',
  'BETWEEN',
  'TRUE',
  'FALSE',
  'EXISTS',
]

export function getWordBeforeCursor(value, cursorPos) {
  const before = String(value ?? '').slice(0, cursorPos)
  const match = before.match(/`?[\w.]+$/)
  return match ? match[0].replace(/^`/, '') : ''
}

export function getWhereFilterSuggestions({ value, cursorPos, columns }) {
  const word = getWordBeforeCursor(value, cursorPos)
  if (!word) return []

  const lower = word.toLowerCase()
  const colMatches = (columns ?? [])
    .map((col) => (typeof col === 'string' ? { name: col } : col))
    .filter((col) => col?.name)
    .filter((col) => {
      const name = String(col.name).toLowerCase()
      return name.startsWith(lower) && name !== lower
    })
    .map((col) => ({ text: col.name, kind: 'column' }))

  const kwMatches = SQL_FILTER_KEYWORDS
    .filter((keyword) => {
      const k = keyword.toLowerCase()
      return k.startsWith(lower) && k !== lower
    })
    .map((keyword) => ({ text: keyword, kind: 'keyword' }))

  return [...colMatches, ...kwMatches]
}
