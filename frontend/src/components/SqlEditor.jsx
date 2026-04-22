import { useRef, useState, useEffect, useCallback } from 'react'
import Editor from '@monaco-editor/react'
import { searchCompletions, runQuery } from '../lib/bridge'
import { splitSql, findStatementAt } from '../lib/sqlSplit'
import { useTheme } from '../theme/ThemeProvider'

const INITIAL_SQL = `-- GripLite SQL Console
-- Tip: Ctrl+Enter to run the selected query

SELECT
    u.id,
    u.name,
    u.email,
    COUNT(o.id) AS order_count,
    SUM(o.total) AS total_spent
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.created_at >= '2024-01-01'
GROUP BY u.id, u.name, u.email
ORDER BY total_spent DESC
LIMIT 100;
`

const TABS_INIT = [
  { id: 1, label: 'Console 1', content: INITIAL_SQL },
  { id: 2, label: 'Console 2', content: '-- New query\nSELECT * FROM products LIMIT 50;\n' },
]

let nextTabId = 3

/**
 * @param {object} props
 * @param {string} [props.initialSql]
 *   Optional one-off seed for this editor's first internal tab.  Used by
 *   "Browse from here" / "Create New Table" Explorer actions so the new
 *   console opens already populated with the chosen template.  If the seed
 *   is empty/undefined, the editor falls back to the default sample SQL.
 */
export default function SqlEditor({ onRunQuery, isRunning = false, connectionId = 'mock-conn', initialSql }) {
  const { resolvedTheme } = useTheme()
  // initialSql is captured ONCE at mount; subsequent prop changes are
  // ignored because the editor's tab list is owned internally and re-seeding
  // it would overwrite anything the user has typed.
  const [tabs, setTabs] = useState(() => {
    if (initialSql && initialSql.trim()) {
      return [
        { id: 1, label: 'Console 1', content: initialSql },
        TABS_INIT[1],
      ]
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

    // ── Register SQL autocomplete provider ─────────────────────────────────
    // Dispose any previous provider registration to avoid duplicates when the
    // component re-mounts (e.g. Strict Mode double-invoke in development).
    if (completionProviderRef.current) {
      completionProviderRef.current.dispose()
    }

    completionProviderRef.current = monaco.languages.registerCompletionItemProvider('sql', {
      // Trigger autocomplete on letters, digits, and the dot/underscore separators.
      triggerCharacters: ['.', '_'],

      provideCompletionItems: async (model, position) => {
        // Extract the word the cursor is currently inside.
        const wordInfo = model.getWordUntilPosition(position)
        const keyword  = wordInfo.word

        if (!keyword || keyword.length < 1) return { suggestions: [] }

        let items = []
        try {
          items = await searchCompletions(connectionId, keyword)
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
          // Monaco completion kind constants:
          // Field=5 (column), Class=7 (table)
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
    if (!sql?.trim()) {
      setSqlValid(null)
      if (model && !model.isDisposed()) {
        monaco.editor.setModelMarkers(model, 'sql-lint', [])
      }
      return
    }

    validateTimerRef.current = setTimeout(async () => {
      if (!model || model.isDisposed()) return

      try {
        const result = await runQuery(connectionId, `EXPLAIN ${sql}`)
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
    setTabs((prev) => [...prev, { id, label: `Console ${id}`, content: '-- New query\n' }])
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
    if (selected && selected.trim()) {
      onRunQuery?.(selected.trim())
      return
    }
    const full = editor.getValue() ?? ''
    if (!full.trim()) return
    const caret = model?.getOffsetAt(editor.getPosition()) ?? 0
    const stmt  = findStatementAt(full, caret)
    onRunQuery?.(stmt ? stmt.sql : full.trim())
  }, [onRunQuery])

  const runAll = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const full = editor.getValue() ?? ''
    const stmts = splitSql(full)
    if (stmts.length === 0) return
    if (stmts.length === 1) {
      onRunQuery?.(stmts[0].sql)
      return
    }
    onRunQuery?.(stmts.map((s) => s.sql), { multi: true })
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
        <span className="text-[11px] text-fg-muted">db1 @ localhost</span>

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
