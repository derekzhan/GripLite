import { useRef, useState, useEffect, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import { format as formatSql } from 'sql-formatter'
import { searchCompletions, runQuery, fetchDatabases, cancelQuery, getQueryHistory, clearQueryHistory } from '../lib/bridge'
import { splitSql, findStatementAt } from '../lib/sqlSplit'
import { useTheme } from '../theme/ThemeProvider'

const INITIAL_SQL = `-- GripLite SQL Console
-- Tip: ⌘+Enter / Ctrl+Enter to run the selected query

`

const TABS_INIT = [
  { id: 1, label: 'Console 1', content: INITIAL_SQL },
]

let nextTabId = 2

// ── MySQL keyword data ───────────────────────────────────────────────────────
//
// SHOW_SUBCMDS: completions offered when the cursor is inside a SHOW statement.
// SQL_KEYWORDS: completions offered anywhere else in the buffer.
//
// Multi-word items (e.g. "CHARACTER SET") are inserted as a single unit; the
// completion range covers all text typed since the start of the subcommand.

const SHOW_SUBCMDS = [
  { label: 'DATABASES',           detail: 'List all databases' },
  { label: 'SCHEMAS',             detail: 'Alias for SHOW DATABASES' },
  { label: 'TABLES',              detail: 'Tables in the active database' },
  { label: 'FULL TABLES',         detail: 'Tables with TABLE_TYPE column' },
  { label: 'OPEN TABLES',         detail: 'Tables currently open in the table cache' },
  { label: 'COLUMNS',             detail: 'Columns of a table (FROM tbl)' },
  { label: 'FULL COLUMNS',        detail: 'Columns with collation/privileges info' },
  { label: 'INDEX',               detail: 'Index information for a table' },
  { label: 'INDEXES',             detail: 'Alias for SHOW INDEX' },
  { label: 'KEYS',                detail: 'Alias for SHOW INDEX' },
  { label: 'TABLE STATUS',        detail: 'Status / stats for every table' },
  { label: 'FULL TABLE STATUS',   detail: 'Table status with full comments' },
  { label: 'VARIABLES',           detail: 'All system variables' },
  { label: 'GLOBAL VARIABLES',    detail: 'Global system variables' },
  { label: 'SESSION VARIABLES',   detail: 'Session-level system variables' },
  { label: 'STATUS',              detail: 'Server status counters' },
  { label: 'GLOBAL STATUS',       detail: 'Global server status counters' },
  { label: 'SESSION STATUS',      detail: 'Session-level status counters' },
  { label: 'PROCESSLIST',         detail: 'Active client threads' },
  { label: 'FULL PROCESSLIST',    detail: 'Active threads with full SQL text' },
  { label: 'GRANTS',              detail: 'GRANT statements for the current user' },
  { label: 'GRANTS FOR',          detail: 'GRANT statements for a specific user' },
  { label: 'CREATE TABLE',        detail: 'CREATE TABLE DDL for a table' },
  { label: 'CREATE DATABASE',     detail: 'CREATE DATABASE DDL' },
  { label: 'CREATE VIEW',         detail: 'CREATE VIEW DDL' },
  { label: 'CREATE PROCEDURE',    detail: 'CREATE PROCEDURE DDL' },
  { label: 'CREATE FUNCTION',     detail: 'CREATE FUNCTION DDL' },
  { label: 'CREATE TRIGGER',      detail: 'CREATE TRIGGER DDL' },
  { label: 'CREATE EVENT',        detail: 'CREATE EVENT DDL' },
  { label: 'WARNINGS',            detail: 'Warnings from the last statement' },
  { label: 'ERRORS',              detail: 'Errors from the last statement' },
  { label: 'ENGINES',             detail: 'Available storage engines' },
  { label: 'STORAGE ENGINES',     detail: 'Available storage engines (alias)' },
  { label: 'CHARACTER SET',       detail: 'Available character sets' },
  { label: 'CHARSET',             detail: 'Available character sets (alias)' },
  { label: 'COLLATION',           detail: 'Available collations' },
  { label: 'PLUGINS',             detail: 'Installed server plugins' },
  { label: 'PRIVILEGES',          detail: 'Privilege types and their context' },
  { label: 'BINARY LOGS',         detail: 'Binary log files on the server' },
  { label: 'BINLOG EVENTS',       detail: 'Events in a binary log file' },
  { label: 'MASTER STATUS',       detail: 'Status of the primary server' },
  { label: 'REPLICA STATUS',      detail: 'Status of the replica' },
  { label: 'SLAVE STATUS',        detail: 'Replica status (legacy name)' },
  { label: 'EVENTS',              detail: 'Scheduled events' },
  { label: 'TRIGGERS',            detail: 'Triggers in the active database' },
  { label: 'PROCEDURE STATUS',    detail: 'Stored procedures metadata' },
  { label: 'FUNCTION STATUS',     detail: 'Stored functions metadata' },
]

const SQL_KEYWORDS = [
  // DML
  { label: 'SELECT',            detail: 'Query rows from one or more tables' },
  { label: 'INSERT INTO',       detail: 'Insert rows into a table' },
  { label: 'UPDATE',            detail: 'Modify existing rows' },
  { label: 'DELETE FROM',       detail: 'Delete rows from a table' },
  { label: 'REPLACE INTO',      detail: 'Insert or replace rows' },
  // DDL
  { label: 'CREATE TABLE',      detail: 'Create a new table' },
  { label: 'ALTER TABLE',       detail: 'Modify a table\'s structure' },
  { label: 'DROP TABLE',        detail: 'Drop a table' },
  { label: 'TRUNCATE TABLE',    detail: 'Remove all rows from a table' },
  { label: 'CREATE DATABASE',   detail: 'Create a new database / schema' },
  { label: 'DROP DATABASE',     detail: 'Drop a database' },
  { label: 'CREATE INDEX',      detail: 'Create an index on a table' },
  { label: 'DROP INDEX',        detail: 'Drop an index' },
  { label: 'CREATE VIEW',       detail: 'Create a virtual table (view)' },
  { label: 'DROP VIEW',         detail: 'Drop a view' },
  { label: 'CREATE PROCEDURE',  detail: 'Create a stored procedure' },
  { label: 'CREATE FUNCTION',   detail: 'Create a stored function' },
  // Utility
  { label: 'SHOW',              detail: 'Show database/server information' },
  { label: 'USE',               detail: 'Switch the active database' },
  { label: 'DESCRIBE',          detail: 'Describe table structure' },
  { label: 'DESC',              detail: 'Alias for DESCRIBE' },
  { label: 'EXPLAIN',           detail: 'Show query execution plan' },
  { label: 'SET',               detail: 'Set a system or session variable' },
  { label: 'CALL',              detail: 'Call a stored procedure' },
  { label: 'FLUSH',             detail: 'Reload server caches / logs' },
  { label: 'OPTIMIZE TABLE',    detail: 'Defragment a table' },
  { label: 'ANALYZE TABLE',     detail: 'Update table statistics' },
  // Clauses
  { label: 'FROM',              detail: 'Specify source table(s)' },
  { label: 'WHERE',             detail: 'Filter rows' },
  { label: 'GROUP BY',          detail: 'Group rows by column(s)' },
  { label: 'ORDER BY',          detail: 'Sort result rows' },
  { label: 'HAVING',            detail: 'Filter groups (after GROUP BY)' },
  { label: 'LIMIT',             detail: 'Limit the number of rows returned' },
  { label: 'OFFSET',            detail: 'Skip N rows before returning results' },
  { label: 'JOIN',              detail: 'INNER JOIN two tables' },
  { label: 'LEFT JOIN',         detail: 'Left outer join' },
  { label: 'RIGHT JOIN',        detail: 'Right outer join' },
  { label: 'INNER JOIN',        detail: 'Inner join (default JOIN)' },
  { label: 'CROSS JOIN',        detail: 'Cartesian product of two tables' },
  { label: 'UNION',             detail: 'Combine result sets (deduplicated)' },
  { label: 'UNION ALL',         detail: 'Combine result sets (with duplicates)' },
  { label: 'DISTINCT',          detail: 'Return unique rows only' },
  { label: 'AS',                detail: 'Column or table alias' },
  { label: 'ON',                detail: 'Join condition' },
  { label: 'IN',                detail: 'Match any value in a list' },
  { label: 'NOT IN',            detail: 'Exclude values in a list' },
  { label: 'IS NULL',           detail: 'Test for NULL' },
  { label: 'IS NOT NULL',       detail: 'Test for non-NULL' },
  { label: 'LIKE',              detail: 'Pattern match with % and _' },
  { label: 'NOT LIKE',          detail: 'Negative pattern match' },
  { label: 'BETWEEN',           detail: 'Range comparison (inclusive)' },
  { label: 'EXISTS',            detail: 'True if subquery returns any rows' },
  { label: 'CASE',              detail: 'Conditional expression' },
  { label: 'WHEN',              detail: 'Condition branch inside CASE' },
  { label: 'THEN',              detail: 'Result branch inside CASE' },
  { label: 'ELSE',              detail: 'Default branch inside CASE / IF' },
  { label: 'END',               detail: 'Close CASE or BEGIN…END block' },
  { label: 'AND',               detail: 'Logical AND' },
  { label: 'OR',                detail: 'Logical OR' },
  { label: 'NOT',               detail: 'Logical NOT' },
  { label: 'INTO',              detail: 'Target table for INSERT / SELECT INTO' },
  { label: 'VALUES',            detail: 'Row data for INSERT' },
  { label: 'DEFAULT',           detail: 'Use column\'s default value' },
  { label: 'NULL',              detail: 'NULL literal / marker' },
  { label: 'PRIMARY KEY',       detail: 'Primary key constraint' },
  { label: 'FOREIGN KEY',       detail: 'Foreign key constraint' },
  { label: 'REFERENCES',        detail: 'Foreign key target table/column' },
  { label: 'NOT NULL',          detail: 'Column cannot be NULL' },
  { label: 'AUTO_INCREMENT',    detail: 'Auto-increment integer column' },
  { label: 'UNIQUE',            detail: 'Unique constraint' },
  { label: 'INDEX',             detail: 'Regular index' },
  { label: 'ENGINE',            detail: 'Storage engine (e.g. InnoDB)' },
  { label: 'CHARSET',           detail: 'Character set for a table/column' },
  { label: 'COLLATE',           detail: 'Collation for a table/column' },
  { label: 'CHARACTER SET',     detail: 'Character set specification' },
  { label: 'IF NOT EXISTS',     detail: 'Skip if already present (CREATE)' },
  { label: 'IF EXISTS',         detail: 'Skip if absent (DROP)' },
  // Transactions
  { label: 'BEGIN',             detail: 'Start a transaction' },
  { label: 'START TRANSACTION', detail: 'Start an explicit transaction' },
  { label: 'COMMIT',            detail: 'Commit the current transaction' },
  { label: 'ROLLBACK',          detail: 'Roll back the current transaction' },
  { label: 'SAVEPOINT',         detail: 'Create a savepoint inside a transaction' },
  { label: 'RELEASE SAVEPOINT', detail: 'Remove a savepoint' },
  // Aggregate / scalar functions
  { label: 'COUNT',             detail: 'Count matching rows' },
  { label: 'SUM',               detail: 'Sum numeric values' },
  { label: 'AVG',               detail: 'Average of numeric values' },
  { label: 'MIN',               detail: 'Minimum value' },
  { label: 'MAX',               detail: 'Maximum value' },
  { label: 'NOW()',             detail: 'Current date and time' },
  { label: 'CURDATE()',         detail: 'Current date' },
  { label: 'CURTIME()',         detail: 'Current time' },
  { label: 'COALESCE',          detail: 'First non-NULL value in a list' },
  { label: 'IFNULL',            detail: 'Return alternate value if NULL' },
  { label: 'NULLIF',            detail: 'Return NULL if two values are equal' },
  { label: 'IF',                detail: 'Inline IF(cond, true_val, false_val)' },
  { label: 'CONCAT',            detail: 'Concatenate strings' },
  { label: 'GROUP_CONCAT',      detail: 'Concatenate values within a group' },
  { label: 'LENGTH',            detail: 'Byte length of a string' },
  { label: 'CHAR_LENGTH',       detail: 'Character length of a string' },
  { label: 'SUBSTRING',         detail: 'Extract a substring' },
  { label: 'TRIM',              detail: 'Remove leading/trailing whitespace' },
  { label: 'UPPER',             detail: 'Convert to upper case' },
  { label: 'LOWER',             detail: 'Convert to lower case' },
  { label: 'REPLACE',           detail: 'Replace occurrences in a string' },
  { label: 'CAST',              detail: 'Convert a value to a given type' },
  { label: 'CONVERT',           detail: 'Convert type or character set' },
  { label: 'DATE_FORMAT',       detail: 'Format a date value' },
  { label: 'STR_TO_DATE',       detail: 'Parse a string as a date' },
  { label: 'YEAR',              detail: 'Extract year from a date' },
  { label: 'MONTH',             detail: 'Extract month from a date' },
  { label: 'DAY',               detail: 'Extract day from a date' },
  { label: 'HOUR',              detail: 'Extract hour from a time/datetime' },
  { label: 'MINUTE',            detail: 'Extract minute' },
  { label: 'SECOND',            detail: 'Extract second' },
  { label: 'DATEDIFF',          detail: 'Difference in days between two dates' },
  { label: 'DATE_ADD',          detail: 'Add a time interval to a date' },
  { label: 'DATE_SUB',          detail: 'Subtract a time interval from a date' },
  { label: 'FLOOR',             detail: 'Round down to nearest integer' },
  { label: 'CEIL',              detail: 'Round up to nearest integer' },
  { label: 'ROUND',             detail: 'Round to a specified decimal place' },
  { label: 'ABS',               detail: 'Absolute value' },
  { label: 'RAND()',            detail: 'Random float 0 ≤ x < 1' },
  { label: 'UUID()',            detail: 'Generate a UUID string' },
  { label: 'LAST_INSERT_ID()',  detail: 'ID of the last auto-increment insert' },
  { label: 'ROW_COUNT()',       detail: 'Rows affected by the last DML' },
  { label: 'DATABASE()',        detail: 'Name of the active database' },
  { label: 'USER()',            detail: 'Current MySQL user' },
  { label: 'VERSION()',         detail: 'MySQL server version string' },
  // Window functions
  { label: 'ROW_NUMBER()',      detail: 'Row number within a partition' },
  { label: 'RANK()',            detail: 'Rank within partition (with gaps)' },
  { label: 'DENSE_RANK()',      detail: 'Rank without gaps' },
  { label: 'LEAD',              detail: 'Value from a following row' },
  { label: 'LAG',               detail: 'Value from a preceding row' },
  { label: 'OVER',              detail: 'Define window for window function' },
  { label: 'PARTITION BY',      detail: 'Divide rows into window partitions' },
  // Data types
  { label: 'INT',               detail: 'Integer (4 bytes)' },
  { label: 'BIGINT',            detail: 'Large integer (8 bytes)' },
  { label: 'TINYINT',           detail: 'Small integer (1 byte)' },
  { label: 'SMALLINT',          detail: 'Small integer (2 bytes)' },
  { label: 'DECIMAL',           detail: 'Fixed-point decimal number' },
  { label: 'FLOAT',             detail: 'Single-precision floating point' },
  { label: 'DOUBLE',            detail: 'Double-precision floating point' },
  { label: 'VARCHAR',           detail: 'Variable-length string' },
  { label: 'CHAR',              detail: 'Fixed-length string' },
  { label: 'TEXT',              detail: 'Long text string' },
  { label: 'LONGTEXT',          detail: 'Very long text (up to 4 GB)' },
  { label: 'BLOB',              detail: 'Binary large object' },
  { label: 'JSON',              detail: 'JSON document column' },
  { label: 'DATE',              detail: 'Date (YYYY-MM-DD)' },
  { label: 'DATETIME',          detail: 'Date and time' },
  { label: 'TIMESTAMP',         detail: 'Timestamp (auto-updated)' },
  { label: 'TIME',              detail: 'Time of day' },
  { label: 'YEAR',              detail: 'Year (2 or 4 digits)' },
  { label: 'BOOLEAN',           detail: 'Boolean (alias for TINYINT(1))' },
  { label: 'ENUM',              detail: 'Enumeration of string values' },
  { label: 'SET',               detail: 'Set of string values' },
]

/**
 * resolveTableAlias — scan a SQL string for FROM / JOIN clauses and return
 * the real table name for a given alias token.
 *
 * Handles both plain and backtick-quoted identifiers, and optional AS keyword:
 *   FROM de_approval t      → alias "t" → "de_approval"
 *   FROM de_approval AS t   → alias "t" → "de_approval"
 *   JOIN `orders` o         → alias "o" → "orders"
 *
 * Returns null when no mapping is found (caller treats the token as a direct
 * table name, e.g. `de_approval.id`).
 */
function resolveTableAlias(sql, alias) {
  const pat = new RegExp(
    `\\b(?:FROM|JOIN)\\s+\`?(\\w+)\`?\\s+(?:AS\\s+)?\`?${alias}\`?\\b`,
    'gi',
  )
  let m
  // eslint-disable-next-line no-cond-assign
  while ((m = pat.exec(sql)) !== null) {
    return m[1]
  }
  return null
}

// ── Saved SQL Snippets ───────────────────────────────────────────────────────
const SNIPPETS_KEY = 'griplite_snippets_v1'

function loadSnippets() {
  try { return JSON.parse(localStorage.getItem(SNIPPETS_KEY) || '[]') } catch { return [] }
}
function saveSnippetsToStorage(snips) {
  try { localStorage.setItem(SNIPPETS_KEY, JSON.stringify(snips)) } catch {}
}

/**
 * @param {object} props
 * @param {string} [props.initialSql]
 *   Optional one-off seed for this editor's first internal tab.  Used by
 *   "Browse from here" / "Create New Table" Explorer actions so the new
 *   console opens already populated with the chosen template.  If the seed
 *   is empty/undefined, the editor falls back to the default sample SQL.
 */
export default function SqlEditor({
  onRunQuery,
  isRunning = false,
  connectionId = 'mock-conn',
  initialSql,
  defaultDb = '',
  connectionLabel = '',
}) {
  const { resolvedTheme } = useTheme()
  // initialSql is captured ONCE at mount; subsequent prop changes are
  // ignored because the editor's tab list is owned internally and re-seeding
  // it would overwrite anything the user has typed.
  const [tabs, setTabs] = useState(() => {
    if (initialSql && initialSql.trim()) {
      return [{ id: 1, label: 'Console 1', content: initialSql }]
    }
    return TABS_INIT
  })
  const [activeTab, setActiveTab] = useState(1)
  const editorRef             = useRef(null)
  const monacoRef             = useRef(null)
  const completionProviderRef = useRef(null)
  const validateTimerRef      = useRef(null)
  const [sqlValid, setSqlValid] = useState(null) // null=unknown, true=ok, false=error
  const [runMenuOpen, setRunMenuOpen] = useState(false)  // split-button dropdown
  const runMenuRef = useRef(null)
  const [snippets, setSnippets] = useState(() => loadSnippets())
  const [showSnippets,  setShowSnippets]  = useState(false)
  const snippetsRef = useRef(null)
  const [showHistory,   setShowHistory]   = useState(false)
  const [historyItems,  setHistoryItems]  = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const historyRef = useRef(null)

  const activeContent = tabs.find((t) => t.id === activeTab)?.content ?? ''

  // ── Database selector state ─────────────────────────────────────────────
  const [databases,     setDatabases]     = useState([])
  const [dbsLoading,    setDbsLoading]    = useState(false)
  const [selectedDb,    setSelectedDb]    = useState(defaultDb)
  const [dbDropdownOpen, setDbDropdownOpen] = useState(false)
  const dbDropdownRef  = useRef(null)
  // Stable ref so the Monaco completion provider (created once) always reads
  // the latest selected database without being recreated on every change.
  const selectedDbRef  = useRef(defaultDb)

  // Keep selectedDbRef in sync so the Monaco provider always has the latest value.
  useEffect(() => { selectedDbRef.current = selectedDb }, [selectedDb])

  // Fetch databases whenever the active connection changes.
  useEffect(() => {
    setSelectedDb(defaultDb)
    if (!connectionId) return
    let cancelled = false
    setDbsLoading(true)
    fetchDatabases(connectionId)
      .then((dbs) => { if (!cancelled) setDatabases(dbs ?? []) })
      .catch(() => { if (!cancelled) setDatabases([]) })
      .finally(() => { if (!cancelled) setDbsLoading(false) })
    return () => { cancelled = true }
  }, [connectionId, defaultDb])

  // Close db dropdown on outside click / Escape.
  useEffect(() => {
    if (!dbDropdownOpen) return
    const close = (e) => {
      if (dbDropdownRef.current && !dbDropdownRef.current.contains(e.target)) {
        setDbDropdownOpen(false)
      }
    }
    const closeEsc = (e) => { if (e.key === 'Escape') setDbDropdownOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown',   closeEsc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown',   closeEsc)
    }
  }, [dbDropdownOpen])

  // Switch active database: update UI state only.
  // The selected db is forwarded with every query via meta.dbName, so the
  // backend runs USE `db` on the same dedicated connection before executing.
  const handleDbSelect = useCallback((db) => {
    setSelectedDb(db)
    setDbDropdownOpen(false)
  }, [])

  const handleEditorMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco

    // ── Cmd/Ctrl+Enter → run the single statement at cursor (or selection)
    editor.addCommand(
      // eslint-disable-next-line no-bitwise
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => runCurrent(),
    )

    // ── Cmd/Ctrl+Shift+Enter → run ALL statements in the buffer
    editor.addCommand(
      // eslint-disable-next-line no-bitwise
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
      () => runAll(),
    )

    // ── Format SQL — context menu item + Shift+Alt+F shortcut ─────────────
    editor.addAction({
      id:    'griplite.formatSql',
      label: 'Format SQL',
      // Shift+Alt+F matches VS Code / DBeaver convention
      // eslint-disable-next-line no-bitwise
      keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
      contextMenuGroupId: '1_modification',
      contextMenuOrder:   1.5,
      run(ed) {
        const model    = ed.getModel()
        const sel      = ed.getSelection()
        const hasRange = sel && !sel.isEmpty()

        // Format only the selection when text is selected; otherwise the whole buffer.
        const input = hasRange
          ? model.getValueInRange(sel)
          : model.getValue()

        let formatted
        try {
          formatted = formatSql(input, {
            language:            'mysql',
            tabWidth:            2,
            keywordCase:         'upper',
            linesBetweenQueries: 1,
          })
        } catch {
          // Silently ignore — malformed SQL that the formatter can't parse.
          return
        }

        if (hasRange) {
          ed.executeEdits('format-sql', [{
            range: sel,
            text:  formatted,
          }])
        } else {
          // Replace entire buffer, preserve cursor/scroll position best-effort.
          const pos = ed.getPosition()
          ed.executeEdits('format-sql', [{
            range: model.getFullModelRange(),
            text:  formatted,
          }])
          ed.setPosition(pos)
        }
        ed.focus()
      },
    })

    // ── Register SQL autocomplete provider ─────────────────────────────────
    // Dispose any previous provider registration to avoid duplicates when the
    // component re-mounts (e.g. Strict Mode double-invoke in development).
    if (completionProviderRef.current) {
      completionProviderRef.current.dispose()
    }

    completionProviderRef.current = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', '_'],

      provideCompletionItems: async (model, position) => {
        // Guard: Monaco broadcasts this call to every registered provider
        // (one per mounted SqlEditor tab).  Return nothing for editors that
        // are not the owner of the model being completed, otherwise the user
        // sees N duplicates for N open console tabs.
        if (model !== editorRef.current?.getModel()) {
          return { suggestions: [] }
        }

        // Full text from start of document up to the current cursor position.
        const textUntilCursor = model.getValueInRange({
          startLineNumber: 1, startColumn: 1,
          endLineNumber: position.lineNumber, endColumn: position.column,
        })

        // ── Dot-completion: "alias." or "table." or "alias.partial" ──────
        // Detect when the cursor sits immediately after a dot (with an
        // optional partial column name already typed).
        const dotMatch = textUntilCursor.match(/(\w+)\.(\w*)$/)
        if (dotMatch) {
          const qualifier = dotMatch[1]
          const fullSql   = model.getValue()

          // Resolve alias → real table name; fall back to the token itself
          // for bare table-name qualifiers like `de_approval.id`.
          const tableName = resolveTableAlias(fullSql, qualifier) ?? qualifier

          let items = []
          try {
            // Search by table name — the cache's LIKE filter returns every
            // column whose table_name starts with `tableName`.
            items = await searchCompletions(connectionId, selectedDbRef.current, tableName)
          } catch {
            return { suggestions: [] }
          }

          // Keep only columns that belong to this exact table.
          const colItems = items.filter(
            (it) => it.kind === 'column' && it.tableName === tableName,
          )

          // The range replaces any partial word already typed after the dot.
          const wordInfo = model.getWordUntilPosition(position)
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber:   position.lineNumber,
            startColumn:     wordInfo.startColumn,
            endColumn:       wordInfo.endColumn,
          }

          return {
            suggestions: colItems.map((item) => ({
              label: {
                label:       item.label,
                description: item.detail,
              },
              kind:       monaco.languages.CompletionItemKind.Field,
              insertText: item.label,
              detail:     item.isPrimaryKey ? `🔑 PK · ${item.detail}` : item.detail,
              documentation: item.isPrimaryKey ? '🔑 Primary Key' : undefined,
              sortText: item.isPrimaryKey ? '0' + item.label : '1' + item.label,
              range,
            })),
          }
        }

        // ── SHOW sub-command completion ────────────────────────────────────
        // Detect that the cursor is inside a SHOW statement on the current
        // line and offer the list of SHOW sub-commands.  The regex captures
        // everything typed after "SHOW " so multi-word items like
        // "CHARACTER SET" are matched and replaced as a single unit.
        const currentLine = textUntilCursor.split('\n').pop()
        const showMatch   = currentLine.match(/\bSHOW\s+([\w ]*)$/i)
        if (showMatch) {
          const partialSubcmd = showMatch[1]          // e.g. "" | "C" | "CHARACTER S"
          const upper         = partialSubcmd.toUpperCase()

          const prefix  = upper.trimEnd()
          const matched = prefix === ''
            ? SHOW_SUBCMDS                                            // show all when cursor is right after "SHOW "
            : SHOW_SUBCMDS.filter((cmd) => cmd.label.startsWith(prefix))

          // Replace the entire partial sub-command text typed so far.
          const replaceStart = position.column - partialSubcmd.length
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber:   position.lineNumber,
            startColumn:     replaceStart,
            endColumn:       position.column,
          }

          return {
            suggestions: matched.map((cmd) => ({
              label: { label: cmd.label, description: cmd.detail },
              kind:        monaco.languages.CompletionItemKind.Keyword,
              insertText:  cmd.label,
              filterText:  cmd.label,
              detail:      cmd.detail,
              sortText:    '0' + cmd.label,
              range,
            })),
          }
        }

        // ── General keyword + schema-object completion ─────────────────────
        const wordInfo = model.getWordUntilPosition(position)
        const keyword  = wordInfo.word

        if (!keyword || keyword.length < 1) return { suggestions: [] }

        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber:   position.lineNumber,
          startColumn:     wordInfo.startColumn,
          endColumn:       wordInfo.endColumn,
        }

        // Filter SQL_KEYWORDS whose first word starts with the typed prefix.
        const kwUpper = keyword.toUpperCase()
        const kwSuggestions = SQL_KEYWORDS
          .filter((kw) => kw.label.split(' ')[0].startsWith(kwUpper))
          .map((kw) => ({
            label:       { label: kw.label, description: kw.detail },
            kind:        monaco.languages.CompletionItemKind.Keyword,
            insertText:  kw.label,
            filterText:  kw.label,
            detail:      kw.detail,
            // Sort keywords after schema objects so table/column names win
            // when both match (e.g. typing "users" should prefer the table).
            sortText:    '5' + kw.label,
            range,
          }))

        // Fetch schema-object candidates (tables + columns) from the cache.
        let cacheItems = []
        try {
          // Pass selectedDb so the cache only returns tables/columns from the
          // currently active schema, preventing cross-DB noise in suggestions.
          cacheItems = await searchCompletions(connectionId, selectedDbRef.current, keyword)
        } catch {
          // Cache unavailable — still return keyword suggestions.
        }

        const cacheSuggestions = cacheItems.map((item) => ({
          label: {
            label:       item.label,
            description: item.tableName ? `${item.tableName}.${item.label}` : item.label,
            detail:      ` ${item.detail}`,
          },
          kind: item.kind === 'table'
            ? monaco.languages.CompletionItemKind.Class
            : monaco.languages.CompletionItemKind.Field,
          insertText:   item.label,
          detail:       item.kind === 'table'
            ? `table · ${item.dbName}`
            : `${item.tableName} · ${item.detail}`,
          documentation: item.isPrimaryKey ? '🔑 Primary Key' : undefined,
          sortText: item.kind === 'table' ? '0' + item.label : '1' + item.label,
          range,
        }))

        return { suggestions: [...cacheSuggestions, ...kwSuggestions] }
      },
    })
  }

  /**
   * validateSql — debounced SQL syntax checker (C3).
   *
   * Strategy: split the buffer into individual statements, then run
   * EXPLAIN <stmt> for each one that MySQL can EXPLAIN (SELECT / INSERT /
   * UPDATE / DELETE / REPLACE).  Statements that are not EXPLAINable —
   * SHOW, USE, SET, DDL, CALL, etc. — are silently skipped so they never
   * trigger false-positive syntax errors.
   *
   * Each EXPLAIN call uses only its own statement text, never the full
   * buffer, so MySQL's "at line N" error offsets map correctly back into
   * the per-statement text and then into the Monaco buffer.
   *
   * Limitations:
   *   - Requires a live connection (skipped silently in browser mock mode).
   *   - 800 ms debounce avoids hammering the DB on every keystroke.
   */
  const validateSql = useCallback((sql, model, monaco) => {
    clearTimeout(validateTimerRef.current)
    const trimmed = sql?.trim() ?? ''
    if (!trimmed) {
      setSqlValid(null)
      if (model && !model.isDisposed()) {
        monaco.editor.setModelMarkers(model, 'sql-lint', [])
      }
      return
    }

    validateTimerRef.current = setTimeout(async () => {
      if (!model || model.isDisposed()) return

      // Split into individual statements so each is validated in isolation.
      const stmts = splitSql(sql)

      // Only attempt EXPLAIN for statement types MySQL supports it on.
      // Everything else (SHOW, USE, SET, DDL, CALL, …) is skipped silently.
      const explainablePrefix = /^(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i

      const candidates = stmts.filter((s) => explainablePrefix.test(s.sql.trimStart()))

      if (candidates.length === 0) {
        // No EXPLAINable statements — nothing to validate; clear markers.
        setSqlValid(null)
        if (!model.isDisposed()) {
          monaco.editor.setModelMarkers(model, 'sql-lint', [])
        }
        return
      }

      try {
        const markers = []

        for (const stmt of candidates) {
          // Skip bare keywords with no whitespace — "select" alone would
          // always fail EXPLAIN; wait until the user has typed more.
          if (!stmt.sql.includes(' ')) continue

          const result = await runQuery(connectionId, selectedDbRef.current, `EXPLAIN ${stmt.sql}`)
          if (!result || model.isDisposed()) return
          if (!result.error) continue

          const errMsg = result.error

          // Silently skip if EXPLAIN is unsupported for this specific variant
          // (e.g. EXPLAIN INSERT … ON DUPLICATE KEY on older servers).
          const unsupportedPhrases = [
            'not supported', 'command denied', 'access denied',
            'only supported', 'cannot use', 'not available',
          ]
          if (unsupportedPhrases.some((p) => errMsg.toLowerCase().includes(p))) continue

          // "at line N" in the MySQL error is relative to the statement text,
          // not the full buffer.  Convert to a buffer line number by counting
          // newlines before stmt.startOffset.
          const bufferLinesBefore = sql.slice(0, stmt.startOffset).split('\n').length - 1
          const lineMatch  = errMsg.match(/at line (\d+)/i)
          const stmtLine   = lineMatch ? parseInt(lineMatch[1], 10) : 1
          const lineNumber = bufferLinesBefore + stmtLine

          const nearMatch = errMsg.match(/near '([^']*)'/i)
          const token     = nearMatch?.[1] ?? ''
          const lineText  = model.getLineContent(lineNumber) ?? ''
          const colStart  = token ? Math.max(1, lineText.indexOf(token) + 1) : 1
          const colEnd    = colStart + Math.max(token.length, 1)

          markers.push({
            startLineNumber: lineNumber,
            endLineNumber:   lineNumber,
            startColumn:     colStart,
            endColumn:       colEnd,
            message:         errMsg,
            severity:        monaco.MarkerSeverity.Error,
            source:          'MySQL',
          })
        }

        if (model.isDisposed()) return
        setSqlValid(markers.length === 0 ? true : false)
        monaco.editor.setModelMarkers(model, 'sql-lint', markers)
      } catch {
        // Network / IPC error — don't show false positives.
        setSqlValid(null)
        if (!model.isDisposed()) {
          monaco.editor.setModelMarkers(model, 'sql-lint', [])
        }
      }
    }, 800)
  }, [connectionId])

  /**
   * Dispose Monaco resources when the SQL console tab is closed.
   *
   * Monaco registers shared language services (completion providers, hover
   * providers, etc.) globally per ILanguage — they are NOT automatically
   * released when a component unmounts.  Each `<Editor key={n}>` instance
   * also allocates V8-heap for its own model, tokeniser, and web-worker
   * communication channel.
   *
   * Resources to release:
   *   completionProviderRef  – IDisposable returned by registerCompletionItemProvider
   *   editorRef              – IStandaloneCodeEditor; calling .dispose() frees its
   *                            model, decorations, and the associated web worker
   *                            if no other editor shares the same language worker.
   *
   * Note: @monaco-editor/react's <Editor> wrapper does NOT call editor.dispose()
   * on its own when the React component unmounts; we must do it explicitly.
   */
  useEffect(() => {
    return () => {
      clearTimeout(validateTimerRef.current)
      completionProviderRef.current?.dispose()
      completionProviderRef.current = null
      editorRef.current?.dispose()
      editorRef.current = null
    }
  }, [])

  // Close the Run split-button dropdown on outside click / Escape.
  useEffect(() => {
    if (!runMenuOpen) return
    const closeOnClick = (e) => {
      if (runMenuRef.current && !runMenuRef.current.contains(e.target)) {
        setRunMenuOpen(false)
      }
    }
    const closeOnEsc = (e) => { if (e.key === 'Escape') setRunMenuOpen(false) }
    document.addEventListener('mousedown', closeOnClick)
    document.addEventListener('keydown',   closeOnEsc)
    return () => {
      document.removeEventListener('mousedown', closeOnClick)
      document.removeEventListener('keydown',   closeOnEsc)
    }
  }, [runMenuOpen])

  const handleEditorChange = (value) => {
    const sql = value ?? ''
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTab ? { ...t, content: sql } : t)),
    )
    // Validate syntax after typing stops.
    const model  = editorRef.current?.getModel()
    const monaco = monacoRef.current
    if (model && monaco) {
      validateSql(sql, model, monaco)
    }
  }

  const addTab = () => {
    const id = nextTabId++
    setTabs((prev) => [...prev, { id, label: `Console ${id}`, content: '' }])
    setActiveTab(id)
  }

  const closeTab = (e, id) => {
    e.stopPropagation()
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (activeTab === id && next.length > 0) {
        setActiveTab(next[next.length - 1].id)
      }
      return next
    })
  }

  // ── Run helpers ─────────────────────────────────────────────────────────
  //
  // runCurrent: honours the user's text selection if non-empty; otherwise
  // splits the buffer on `;` and picks the statement covering the caret.
  //
  // runAll: splits the full buffer and asks the host to execute every
  // statement sequentially, producing one result set per statement.
  //
  // Both paths call `onRunQuery(sql, meta)` where `meta.multi` is the list
  // of individual statements when Run All is used.  When Run All yields
  // only one statement, we degrade to single-run for clarity.
  const runCurrent = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const sel = editor.getSelection()
    const model = editor.getModel()
    const selected = sel && model ? model.getValueInRange(sel) : ''
    const db = selectedDbRef.current
    if (selected && selected.trim()) {
      onRunQuery?.(selected.trim(), { dbName: db })
      return
    }
    const full = editor.getValue() ?? ''
    if (!full.trim()) return
    const caret = model?.getOffsetAt(editor.getPosition()) ?? 0
    const stmt  = findStatementAt(full, caret)
    onRunQuery?.(stmt ? stmt.sql : full.trim(), { dbName: db })
  }, [onRunQuery])

  const runAll = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const full = editor.getValue() ?? ''
    const stmts = splitSql(full)
    if (stmts.length === 0) return
    const db = selectedDbRef.current
    if (stmts.length === 1) {
      onRunQuery?.(stmts[0].sql, { dbName: db })
      return
    }
    onRunQuery?.(stmts.map((s) => s.sql), { multi: true, dbName: db })
  }, [onRunQuery])

  const handleTxn = useCallback((sql) => {
    if (!connectionId || isRunning) return
    onRunQuery?.(sql, { dbName: selectedDbRef.current })
  }, [connectionId, isRunning, onRunQuery])

  const insertSnippet = useCallback((sql) => {
    const editor = editorRef.current
    if (!editor) return
    const selection = editor.getSelection()
    editor.executeEdits('snippet', [{
      range: selection,
      text: sql,
      forceMoveMarkers: true,
    }])
    editor.focus()
    setShowSnippets(false)
  }, [])

  const saveSnippet = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const sql = editor.getValue()
    if (!sql.trim()) return
    const name = window.prompt('Snippet name:')
    if (!name) return
    const newSnip = { id: Date.now().toString(), name, sql, createdAt: new Date().toISOString() }
    const updated = [newSnip, ...snippets]
    setSnippets(updated)
    saveSnippetsToStorage(updated)
  }, [snippets])

  // Close snippets dropdown on outside click.
  useEffect(() => {
    if (!showSnippets) return
    const handle = (e) => {
      if (snippetsRef.current && !snippetsRef.current.contains(e.target)) {
        setShowSnippets(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [showSnippets])

  // ── Query History ────────────────────────────────────────────────────────
  const openHistory = useCallback(async () => {
    setShowHistory(p => !p)
    if (!connectionId || historyItems.length > 0) return
    setHistoryLoading(true)
    try {
      const items = await getQueryHistory(connectionId, 200)
      setHistoryItems(items ?? [])
    } finally {
      setHistoryLoading(false)
    }
  }, [connectionId, historyItems.length])

  const handleClearHistory = useCallback(async () => {
    if (!connectionId) return
    await clearQueryHistory(connectionId)
    setHistoryItems([])
  }, [connectionId])

  // Reload history whenever the dropdown opens (fresh data).
  useEffect(() => {
    if (!showHistory || !connectionId) return
    getQueryHistory(connectionId, 200).then(items => setHistoryItems(items ?? []))
  }, [showHistory, connectionId])

  // Close history dropdown on outside click.
  useEffect(() => {
    if (!showHistory) return
    const handle = (e) => {
      if (historyRef.current && !historyRef.current.contains(e.target)) {
        setShowHistory(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [showHistory])

  // ── Cancel running query ────────────────────────────────────────────────
  const handleCancelQuery = useCallback(async () => {
    if (!connectionId) return
    try { await cancelQuery(connectionId) } catch { /* ignore */ }
  }, [connectionId])

  return (
    <div className="flex flex-col h-full bg-app">
      {/* Tab bar */}
      <div className="flex items-stretch bg-titlebar border-b border-line-subtle flex-shrink-0 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={[
              'flex items-center gap-2 px-4 py-2 text-[13px] cursor-pointer border-r border-line-subtle',
              'select-none flex-shrink-0 min-w-[100px] transition-colors',
              tab.id === activeTab
                ? 'bg-app text-fg-primary border-t-2 border-t-accent'
                : 'text-fg-muted hover:text-fg-primary hover:bg-hover',
            ].join(' ')}
          >
            <span className="text-[10px] opacity-60">⚡</span>
            <span className="truncate max-w-[120px]">{tab.label}</span>
            <button
              onClick={(e) => closeTab(e, tab.id)}
              className="ml-auto text-fg-muted hover:text-fg-primary leading-none hover:bg-line rounded px-0.5"
            >
              ×
            </button>
          </div>
        ))}

        {/* New tab button */}
        <button
          onClick={addTab}
          className="px-3 py-2 text-fg-muted hover:text-fg-primary hover:bg-hover transition-colors flex-shrink-0"
          title="New Console"
        >
          +
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-titlebar border-b border-line-subtle flex-shrink-0">
        {/* Split Run button: main = current statement, ▾ = Run All */}
        <div ref={runMenuRef} className="relative flex">
          <button
            onClick={() => { setRunMenuOpen(false); runCurrent() }}
            disabled={isRunning}
            className={[
              'flex items-center gap-1.5 pl-3 pr-2 py-1 text-fg-on-accent text-[12px] rounded-l transition-colors font-medium',
              isRunning
                ? 'bg-accent-hover cursor-not-allowed opacity-60'
                : 'bg-accent hover:bg-accent-hover',
            ].join(' ')}
            title="Run current statement (Ctrl/Cmd+Enter)"
          >
            {isRunning ? '⏳ Running…' : '▶ Run'}
          </button>
          <button
            onClick={() => setRunMenuOpen((o) => !o)}
            disabled={isRunning}
            className={[
              'flex items-center justify-center w-5 py-1 text-fg-on-accent text-[10px] rounded-r transition-colors border-l border-accent-hover',
              isRunning
                ? 'bg-accent-hover cursor-not-allowed opacity-60'
                : 'bg-accent hover:bg-accent-hover',
            ].join(' ')}
            title="More run options"
          >
            ▾
          </button>
          {runMenuOpen && (
            <div className="absolute top-full left-0 mt-1 bg-panel border border-line
                            rounded shadow-xl py-1 min-w-[220px] text-[12px] z-40">
              <button
                onClick={() => { setRunMenuOpen(false); runCurrent() }}
                className="w-full text-left px-3 py-1.5 text-fg-secondary hover:bg-active hover:text-fg-on-accent
                           transition-colors flex items-center justify-between gap-3"
              >
                <span>▶&nbsp; Run current statement</span>
                <span className="text-[10px] text-fg-faint tabular-nums">⌘↵</span>
              </button>
              <button
                onClick={() => { setRunMenuOpen(false); runAll() }}
                className="w-full text-left px-3 py-1.5 text-fg-secondary hover:bg-active hover:text-fg-on-accent
                           transition-colors flex items-center justify-between gap-3"
              >
                <span>⏭&nbsp; Run all statements</span>
                <span className="text-[10px] text-fg-faint tabular-nums">⌘⇧↵</span>
              </button>
            </div>
          )}
        </div>
        <div className="h-4 w-px bg-line" />

        {/* Transaction buttons */}
        {connectionId && (
          <div className="flex items-stretch rounded border border-line overflow-hidden text-[11px] ml-1">
            {[
              { label: 'BEGIN',    sql: 'BEGIN',    title: 'Begin transaction' },
              { label: 'COMMIT',   sql: 'COMMIT',   title: 'Commit transaction' },
              { label: 'ROLLBACK', sql: 'ROLLBACK', title: 'Rollback transaction' },
            ].map((btn, i) => (
              <button
                key={btn.label}
                onClick={() => handleTxn(btn.sql)}
                disabled={isRunning}
                title={btn.title}
                className={[
                  'px-2 py-1 transition-colors select-none',
                  i > 0 ? 'border-l border-line' : '',
                  'text-fg-secondary hover:text-fg-primary hover:bg-hover disabled:opacity-40',
                ].join(' ')}
              >
                {btn.label}
              </button>
            ))}
          </div>
        )}

        {/* Snippets button + dropdown */}
        <div ref={snippetsRef} className="relative ml-1">
          <button
            onClick={() => setShowSnippets(p => !p)}
            title="SQL Snippets"
            className={[
              'text-[11px] px-2 py-1 rounded border transition-colors select-none',
              showSnippets
                ? 'border-accent text-accent'
                : 'border-line text-fg-secondary hover:border-accent hover:text-fg-primary',
            ].join(' ')}
          >
            Snippets{snippets.length > 0 ? ` (${snippets.length})` : ''}
          </button>
          {showSnippets && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-panel border border-line rounded
                            min-w-[300px] max-h-[400px] overflow-y-auto py-1">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-line-subtle">
                <span className="text-[10px] uppercase tracking-wider text-fg-muted">SQL Snippets</span>
                <button onClick={saveSnippet} className="text-[10px] text-accent hover:underline select-none">
                  + Save current
                </button>
              </div>
              {snippets.length === 0 ? (
                <div className="px-3 py-4 text-[12px] text-fg-muted text-center">No snippets yet</div>
              ) : snippets.map(snip => (
                <div key={snip.id} className="group flex items-start gap-2 px-3 py-2 hover:bg-hover border-b border-line-subtle">
                  <button
                    onClick={() => insertSnippet(snip.sql)}
                    className="flex-1 text-left min-w-0"
                    title={snip.sql}
                  >
                    <div className="text-[12px] text-fg-primary font-medium truncate">{snip.name}</div>
                    <div className="text-[10px] text-fg-muted font-mono truncate">{snip.sql.slice(0, 60)}{snip.sql.length > 60 ? '…' : ''}</div>
                  </button>
                  <button
                    onClick={() => {
                      const updated = snippets.filter(s => s.id !== snip.id)
                      setSnippets(updated)
                      saveSnippetsToStorage(updated)
                    }}
                    className="opacity-0 group-hover:opacity-100 text-fg-muted hover:text-danger text-[10px] select-none mt-0.5"
                    title="Delete snippet"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Connection label */}
        {connectionLabel && (
          <span className="text-[11px] text-fg-muted select-none">{connectionLabel}</span>
        )}

        {/* Database selector ─────────────────────────────────────────────
            Shows the active database for this console.  Clicking it opens
            a dropdown with every database on the connected server; selecting
            one runs USE `db`; to switch the session context. */}
        <div ref={dbDropdownRef} className="relative">
          <button
            onClick={() => setDbDropdownOpen((o) => !o)}
            title="Switch active database"
            className={[
              'flex items-center gap-1 px-2 py-0.5 rounded border transition-colors text-[11px]',
              'bg-sunken hover:bg-hover border-line text-fg-secondary',
              dbDropdownOpen ? 'border-accent' : '',
            ].join(' ')}
            style={{ maxWidth: 180 }}
          >
            {dbsLoading ? (
              <span className="text-fg-muted">…</span>
            ) : (
              <>
                {/* tiny database icon — inline SVG so no extra import needed */}
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="flex-shrink-0 opacity-60">
                  <ellipse cx="6" cy="2.5" rx="5" ry="1.8" stroke="currentColor" strokeWidth="1.3"/>
                  <path d="M1 2.5v3c0 1 2.24 1.8 5 1.8s5-.8 5-1.8v-3" stroke="currentColor" strokeWidth="1.3"/>
                  <path d="M1 5.5v3c0 1 2.24 1.8 5 1.8s5-.8 5-1.8v-3" stroke="currentColor" strokeWidth="1.3"/>
                </svg>
                <span className="truncate" style={{ maxWidth: 120 }}>
                  {selectedDb || 'No database'}
                </span>
                <span className="text-fg-muted flex-shrink-0 text-[9px]">▾</span>
              </>
            )}
          </button>

          {dbDropdownOpen && (
            <div
              className="absolute top-full left-0 mt-1 bg-panel border border-line rounded shadow-xl py-1
                         text-[12px] z-50 overflow-y-auto"
              style={{ minWidth: 180, maxHeight: 280 }}
            >
              {databases.length === 0 ? (
                <div className="px-3 py-2 text-fg-muted text-[11px] italic">No databases found</div>
              ) : (
                databases.map((db) => (
                  <button
                    key={db}
                    onClick={() => handleDbSelect(db)}
                    className={[
                      'w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors',
                      db === selectedDb
                        ? 'text-accent bg-selected'
                        : 'text-fg-secondary hover:bg-hover',
                    ].join(' ')}
                  >
                    {db === selectedDb
                      ? <span className="text-[8px] flex-shrink-0">●</span>
                      : <span className="w-2 flex-shrink-0" />}
                    <span className="truncate">{db}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* SQL validation badge — updates 800 ms after typing stops */}
        {sqlValid === true && (
          <span className="text-[11px] text-success select-none" title="No syntax errors detected">
            ✓ Valid SQL
          </span>
        )}
        {sqlValid === false && (
          <span className="text-[11px] text-danger select-none" title="Syntax error detected (see red underline)">
            ✗ Syntax error
          </span>
        )}

        {/* Cancel button — only when a query is running */}
        {isRunning && (
          <button
            onClick={handleCancelQuery}
            title="Cancel running query"
            className="text-[11px] px-2 py-1 rounded border border-danger text-danger
                       hover:bg-danger hover:text-white transition-colors select-none ml-1"
          >
            ✕ Cancel
          </button>
        )}

        {/* Query history button */}
        {connectionId && (
          <div ref={historyRef} className="relative ml-1">
            <button
              onClick={openHistory}
              title="Query history"
              className={[
                'text-[11px] px-2 py-1 rounded border transition-colors select-none',
                showHistory
                  ? 'border-accent text-accent'
                  : 'border-line text-fg-secondary hover:border-accent hover:text-fg-primary',
              ].join(' ')}
            >
              History
            </button>
            {showHistory && (
              <div className="absolute top-full right-0 mt-1 z-50 bg-panel border border-line rounded
                              w-[420px] max-h-[420px] overflow-y-auto py-1">
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-line-subtle">
                  <span className="text-[10px] uppercase tracking-wider text-fg-muted">
                    {historyLoading ? 'Loading…' : `${historyItems.length} recent queries`}
                  </span>
                  <button
                    onClick={handleClearHistory}
                    className="text-[10px] text-danger hover:underline select-none"
                  >
                    Clear all
                  </button>
                </div>
                {historyItems.length === 0 && !historyLoading ? (
                  <div className="px-3 py-4 text-[12px] text-fg-muted text-center">No history yet</div>
                ) : historyItems.map(item => (
                  <div
                    key={item.id}
                    className="group flex items-start gap-2 px-3 py-2 hover:bg-hover border-b border-line-subtle cursor-pointer"
                    onClick={() => {
                      insertSnippet(item.sql)
                      setShowHistory(false)
                    }}
                    title="Click to insert into editor"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-mono text-fg-primary truncate">{item.sql}</div>
                      <div className="text-[10px] text-fg-muted mt-0.5 flex items-center gap-2">
                        {item.dbName && <span className="text-accent">{item.dbName}</span>}
                        <span>{item.execMs} ms</span>
                        {item.errorMsg && <span className="text-danger">✗ Error</span>}
                        <span className="ml-auto">{item.executedAt?.slice(0, 16)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-1 text-[11px] text-fg-muted">
          <span>Ln 1, Col 1</span>
        </div>
      </div>

      {/* Monaco Editor */}
      <div className="flex-1 overflow-hidden">
        <Editor
          key={activeTab}
          height="100%"
          defaultLanguage="sql"
          value={activeContent}
          onChange={handleEditorChange}
          onMount={handleEditorMount}
          theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
          options={{
            fontSize: 14,
            lineHeight: 22,
            fontFamily: '"JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace',
            fontLigatures: true,
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            tabSize: 2,
            renderLineHighlight: 'line',
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            padding: { top: 12 },
          }}
        />
      </div>
    </div>
  )
}
