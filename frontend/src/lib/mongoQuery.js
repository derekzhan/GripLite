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

// ── MongoDB console (shell) autocomplete ─────────────────────────────────────
//
// The SQL console editor switches to the `javascript` language for MongoDB
// connections.  These helpers power a mongo-shell-aware completion provider:
// collection names after `db.`, collection methods after `db.coll.`, cursor
// methods after `…)`, `$` query operators, and field names inside a filter.

// Methods exposed by the backend shell parser on a collection object.  Each
// `insert` is a Monaco snippet (`$1` = final cursor stop).
export const MONGO_COLLECTION_METHODS = [
  { label: 'find',                   insert: 'find({ $1 })',          detail: 'Query documents' },
  { label: 'aggregate',              insert: 'aggregate([ $1 ])',     detail: 'Aggregation pipeline' },
  { label: 'countDocuments',         insert: 'countDocuments({ $1 })', detail: 'Count matching documents' },
  { label: 'estimatedDocumentCount', insert: 'estimatedDocumentCount()', detail: 'Fast collection count' },
  { label: 'distinct',               insert: 'distinct("$1")',        detail: 'Distinct values of a field' },
  { label: 'insertOne',              insert: 'insertOne({ $1 })',     detail: 'Insert a document' },
  { label: 'insertMany',             insert: 'insertMany([ $1 ])',    detail: 'Insert documents' },
  { label: 'updateOne',              insert: 'updateOne({ $1 }, { $set: {  } })', detail: 'Update one document' },
  { label: 'updateMany',             insert: 'updateMany({ $1 }, { $set: {  } })', detail: 'Update many documents' },
  { label: 'replaceOne',             insert: 'replaceOne({ $1 }, {  })', detail: 'Replace one document' },
  { label: 'deleteOne',              insert: 'deleteOne({ $1 })',     detail: 'Delete one document' },
  { label: 'deleteMany',             insert: 'deleteMany({ $1 })',    detail: 'Delete many documents' },
  { label: 'createIndex',            insert: 'createIndex({ $1 })',   detail: 'Create an index' },
  { label: 'getIndexes',             insert: 'getIndexes()',          detail: 'List indexes' },
  { label: 'dropIndex',              insert: 'dropIndex("$1")',       detail: 'Drop an index by name' },
  { label: 'drop',                   insert: 'drop()',                detail: 'Drop the collection' },
]

// Chainable cursor methods available after find()/aggregate().
export const MONGO_CURSOR_METHODS = [
  { label: 'sort',    insert: 'sort({ $1 })',  detail: 'Sort the cursor' },
  { label: 'limit',   insert: 'limit($1)',     detail: 'Limit result count' },
  { label: 'skip',    insert: 'skip($1)',      detail: 'Skip documents' },
  { label: 'project', insert: 'project({ $1 })', detail: 'Project fields' },
  { label: 'toArray', insert: 'toArray()',     detail: 'Materialize the cursor' },
]

// Methods reachable directly on the `db` handle.
export const MONGO_DB_METHODS = [
  { label: 'getCollection', insert: 'getCollection("$1")', detail: 'db.getCollection(name)' },
  { label: 'runCommand',    insert: 'runCommand({ $1 })',  detail: 'db.runCommand(doc)' },
]

// Common query / update / aggregation operators offered after a `$`.
export const MONGO_QUERY_OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$and', '$or', '$not', '$nor', '$exists', '$type', '$regex', '$elemMatch',
  '$set', '$unset', '$inc', '$push', '$pull', '$addToSet', '$each',
  '$match', '$group', '$project', '$sort', '$limit', '$skip', '$lookup', '$unwind', '$count',
]

// Find the collection referenced closest to the cursor so field completion can
// be scoped to it.  Handles both `db.<name>.…` and `db.getCollection("name").…`.
export function detectMongoCollectionName(textUntilCursor) {
  const text = String(textUntilCursor ?? '')
  const re = /getCollection\(\s*["']([^"']+)["']\s*\)|db\.(?!getCollection\b|runCommand\b)([A-Za-z_][\w]*)/g
  let coll = null
  let m
  while ((m = re.exec(text)) !== null) {
    coll = m[1] ?? m[2] ?? coll
  }
  return coll
}

/**
 * classifyMongoConsoleContext — decide what kind of completion the cursor wants
 * based on the text immediately preceding it.  Returns `{ type, partial,
 * collection? }` where type is one of:
 *   'operator' | 'cursorMethod' | 'collectionMethod' | 'collectionName' |
 *   'field' | 'keyword'
 */
export function classifyMongoConsoleContext(textUntilCursor) {
  const text = String(textUntilCursor ?? '')

  const opMatch = text.match(/\$(\w*)$/)
  if (opMatch) return { type: 'operator', partial: '$' + opMatch[1] }

  // A `.` after a collection handle → collection methods.  Checked before the
  // generic "after a paren" cursor case so `getCollection("x").` (whose `)`
  // would otherwise look like a cursor chain) resolves to collection methods.
  const methodMatch = text.match(/(?:db\.[A-Za-z_]\w*|getCollection\(\s*["'][^"']+["']\s*\))\s*\.\s*(\w*)$/)
  if (methodMatch) return { type: 'collectionMethod', partial: methodMatch[1] }

  // A `.` directly after a closing paren → chainable cursor methods.
  const cursorMatch = text.match(/\)\s*\.\s*(\w*)$/)
  if (cursorMatch) return { type: 'cursorMethod', partial: cursorMatch[1] }

  // Typing right after `db.` (no further dot) → collection names + db methods.
  const dbMatch = text.match(/\bdb\s*\.\s*([A-Za-z_]\w*)?$/)
  if (dbMatch) return { type: 'collectionName', partial: dbMatch[1] ?? '' }

  // Otherwise, if a collection is in scope we're likely inside a filter and
  // want its field names; failing that, just offer the `db` entrypoint.
  const word = (text.match(/[A-Za-z_]\w*$/) ?? [''])[0]
  const collection = detectMongoCollectionName(text)
  if (collection) return { type: 'field', partial: word, collection }
  return { type: 'keyword', partial: word }
}
