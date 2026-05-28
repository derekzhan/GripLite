export function escapeMongoCollectionName(name) {
  return String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export const DEFAULT_MONGO_SORT = '{ _id: -1 }'

export function normalizeMongoObjectInput(input, fallback = '{}') {
  const trimmed = String(input ?? '').trim()
  return trimmed || fallback
}

export function buildMongoCollectionFindQuery(tableName, pageSize, offset = 0, filter = '{}', sort = DEFAULT_MONGO_SORT) {
  const coll = escapeMongoCollectionName(tableName)
  const find = normalizeMongoObjectInput(filter, '{}')
  const sortDoc = normalizeMongoObjectInput(sort, DEFAULT_MONGO_SORT)
  const sortClause = sortDoc ? `.sort(${sortDoc})` : ''
  const skip = offset > 0 ? `.skip(${offset})` : ''
  return `db.getCollection("${coll}").find(${find})${sortClause}${skip}.limit(${pageSize})`
}

export function getMongoWordBeforeCursor(value, cursorPos) {
  const before = String(value ?? '').slice(0, cursorPos)
  const match = before.match(/[\w.]+$/)
  return match ? match[0] : ''
}

export function getMongoFieldSuggestions({ value, cursorPos, columns }) {
  const word = getMongoWordBeforeCursor(value, cursorPos)
  if (!word) return []
  const lower = word.toLowerCase()
  return (columns ?? [])
    .map((col) => (typeof col === 'string' ? { name: col } : col))
    .filter((col) => col?.name)
    .filter((col) => {
      const name = String(col.name).toLowerCase()
      return name.startsWith(lower) && name !== lower
    })
    .map((col) => ({ text: col.name, kind: 'field', type: col.type ?? col.databaseType ?? '' }))
}
