export function quoteSqlIdentifier(name) {
  return '`' + String(name ?? '').replace(/`/g, '``') + '`'
}

export const DATABASE_CHARSET_OPTIONS = [
  {
    charset: 'utf8mb4',
    collations: ['utf8mb4_general_ci', 'utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci', 'utf8mb4_bin'],
  },
  {
    charset: 'utf8',
    collations: ['utf8_general_ci', 'utf8_unicode_ci', 'utf8_bin'],
  },
  {
    charset: 'latin1',
    collations: ['latin1_swedish_ci', 'latin1_general_ci', 'latin1_bin'],
  },
]

export const MYSQL_COLUMN_TYPE_OPTIONS = [
  'INT',
  'BIGINT',
  'TINYINT',
  'SMALLINT',
  'DECIMAL(10,2)',
  'DOUBLE',
  'VARCHAR(255)',
  'CHAR(36)',
  'TEXT',
  'LONGTEXT',
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'TIME',
  'BOOLEAN',
  'JSON',
  'BLOB',
  'LONGBLOB',
]

export function collationsForCharset(charset) {
  return DATABASE_CHARSET_OPTIONS.find((opt) => opt.charset === charset)?.collations ?? []
}

export function buildCreateDatabaseSql({ databaseName, charset = 'utf8mb4', collation = 'utf8mb4_general_ci' }) {
  const q = quoteSqlIdentifier(databaseName)
  const charsetClause = charset ? ` CHARACTER SET ${charset}` : ''
  const collationClause = collation ? ` COLLATE ${collation}` : ''
  return `CREATE DATABASE IF NOT EXISTS ${q}${charsetClause}${collationClause};`
}

function quoteStringLiteral(value) {
  return "'" + String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

export function buildCreateTableSql({
  dbName,
  tableName,
  engine = 'InnoDB',
  charset = 'utf8mb4',
  collation = 'utf8mb4_general_ci',
  comment = '',
  columns = [],
}) {
  const usableColumns = columns
    .map((col) => ({
      ...col,
      name: String(col.name ?? '').trim(),
      type: String(col.type ?? '').trim(),
    }))
    .filter((col) => col.name && col.type)

  if (!String(tableName ?? '').trim()) throw new Error('table name is required')
  if (usableColumns.length === 0) throw new Error('at least one column is required')

  const lines = []
  const primaryColumns = []
  for (const col of usableColumns) {
    const parts = [quoteSqlIdentifier(col.name), col.type]
    if (col.notNull) parts.push('NOT NULL')
    if (col.autoIncrement) parts.push('AUTO_INCREMENT')
    if (col.defaultValue !== undefined && col.defaultValue !== null && String(col.defaultValue).trim() !== '') {
      parts.push(`DEFAULT ${String(col.defaultValue).trim()}`)
    }
    if (col.comment) parts.push(`COMMENT ${quoteStringLiteral(col.comment)}`)
    lines.push(`  ${parts.join(' ')}`)
    if (col.key === 'PRIMARY') primaryColumns.push(col.name)
  }

  if (primaryColumns.length > 0) {
    lines.push(`  PRIMARY KEY (${primaryColumns.map(quoteSqlIdentifier).join(', ')})`)
  }

  const options = []
  if (engine) options.push(`ENGINE=${engine}`)
  if (charset) options.push(`DEFAULT CHARSET=${charset}`)
  if (collation) options.push(`COLLATE=${collation}`)
  if (comment) options.push(`COMMENT=${quoteStringLiteral(comment)}`)

  return [
    `CREATE TABLE ${quoteSqlIdentifier(dbName)}.${quoteSqlIdentifier(tableName)} (`,
    lines.map((line, idx) => idx < lines.length - 1 ? `${line},` : line).join('\n'),
    `) ${options.join(' ')};`,
  ].join('\n')
}

export function buildRenameTableSql({ dbName, oldTableName, newTableName }) {
  if (!String(dbName ?? '').trim()) throw new Error('database name is required')
  if (!String(oldTableName ?? '').trim()) throw new Error('current table name is required')
  if (!String(newTableName ?? '').trim()) throw new Error('new table name is required')
  return `RENAME TABLE ${quoteSqlIdentifier(dbName)}.${quoteSqlIdentifier(oldTableName)} TO ${quoteSqlIdentifier(dbName)}.${quoteSqlIdentifier(newTableName)};`
}

export function buildDropTableSql({ dbName, tableName }) {
  if (!String(dbName ?? '').trim()) throw new Error('database name is required')
  if (!String(tableName ?? '').trim()) throw new Error('table name is required')
  return `DROP TABLE ${quoteSqlIdentifier(dbName)}.${quoteSqlIdentifier(tableName)};`
}

export function buildCreateDatabaseTemplate(databaseName = 'new_database') {
  const q = quoteSqlIdentifier(databaseName || 'new_database')
  return `-- Create a new database

CREATE DATABASE IF NOT EXISTS ${q};

USE ${q};
`
}
