import { useRef, useState, useEffect, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import { format as formatSql } from 'sql-formatter'
import { searchCompletions, runQuery, fetchDatabases } from '../lib/bridge'
import { splitSql, findStatementAt } from '../lib/sqlSplit'
import { useTheme } from '../theme/ThemeProvider'

const INITIAL_SQL = `-- GripLite SQL Console
-- Tip: ⌘+Enter / Ctrl+Enter to run the selected query

`

const TABS_INIT = [
  { id: 1, label: 'Console 1', content: INITIAL_SQL },
]

let nextTabId = 2

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

        // ── Regular keyword completion (table names + columns) ────────────
        const wordInfo = model.getWordUntilPosition(position)
        const keyword  = wordInfo.word

        if (!keyword || keyword.length < 1) return { suggestions: [] }

        let items = []
        try {
          // Pass selectedDb so the cache only returns tables/columns from the
          // currently active schema, preventing cross-DB noise in suggestions.
          items = await searchCompletions(connectionId, selectedDbRef.current, keyword)
        } catch {
          return { suggestions: [] }
        }

        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber:   position.lineNumber,
          startColumn:     wordInfo.startColumn,
          endColumn:       wordInfo.endColumn,
        }

        const suggestions = items.map((item) => ({
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

        return { suggestions }
      },
    })
  }

  /**
   * validateSql — debounced SQL syntax checker (C3).
   *
   * Strategy: run EXPLAIN <sql> against the connected backend and interpret
   * the result.  This uses the actual MySQL parser rather than a client-side
   * approximation, so it catches all syntax errors including invalid keywords,
   * wrong clause ordering, and type mismatches.
   *
   * Error-position extraction:
   *   MySQL errors include a "near '<token>' at line N" pattern.  We parse
   *   that to find the offending line; column position defaults to 1 if not
   *   available (MySQL rarely gives precise column offsets).
   *
   * Limitations:
   *   - Requires a live connection (skipped silently in browser mock mode).
   *   - EXPLAIN is not valid for all statements (DDL, multi-statement blocks).
   *     We handle these gracefully: if EXPLAIN itself returns "not supported"
   *     or similar, we clear markers and treat syntax as unknown.
   *   - 800 ms debounce avoids hammering the DB on every keystroke.
   */
  const validateSql = useCallback((sql, model, monaco) => {
    clearTimeout(validateTimerRef.current)
    const trimmed = sql?.trim() ?? ''
    // Skip validation when there is no content, or when the user has only
    // typed a single token (no whitespace) — a bare word like "t" or "select"
    // is not a valid statement and EXPLAIN would always return a syntax error.
    if (!trimmed || !trimmed.includes(' ')) {
      setSqlValid(null)
      if (model && !model.isDisposed()) {
        monaco.editor.setModelMarkers(model, 'sql-lint', [])
      }
      return
    }

    validateTimerRef.current = setTimeout(async () => {
      if (!model || model.isDisposed()) return

      try {
        const result = await runQuery(connectionId, selectedDbRef.current, `EXPLAIN ${sql}`)
        if (!result || model.isDisposed()) return

        if (!result.error) {
          setSqlValid(true)
          monaco.editor.setModelMarkers(model, 'sql-lint', [])
          return
        }

        const errMsg = result.error

        // Silently skip if EXPLAIN is unsupported for this statement type
        // (e.g. DDL like CREATE TABLE, or stored-procedure syntax).
        const unsupportedPhrases = [
          'not supported', 'command denied', 'access denied',
          'only supported', 'cannot use', 'not available',
        ]
        if (unsupportedPhrases.some((p) => errMsg.toLowerCase().includes(p))) {
          setSqlValid(null)
          monaco.editor.setModelMarkers(model, 'sql-lint', [])
          return
        }

        // Parse "at line N" from the MySQL error message.
        // Example: "You have an error in your SQL syntax … near 'FOM' at line 1"
        const lineMatch  = errMsg.match(/at line (\d+)/i)
        const lineNumber = lineMatch ? parseInt(lineMatch[1], 10) : 1

        // Try to locate the offending token from "near '<token>'" to set column.
        const nearMatch = errMsg.match(/near '([^']*)'/i)
        const token     = nearMatch?.[1] ?? ''
        const lineText  = model.getLineContent(lineNumber) ?? ''
        const colStart  = token ? Math.max(1, lineText.indexOf(token) + 1) : 1
        const colEnd    = colStart + Math.max(token.length, 1)

        setSqlValid(false)
        monaco.editor.setModelMarkers(model, 'sql-lint', [{
          startLineNumber: lineNumber,
          endLineNumber:   lineNumber,
          startColumn:     colStart,
          endColumn:       colEnd,
          message:         errMsg,
          severity:        monaco.MarkerSeverity.Error,
          source:          'MySQL',
        }])
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
