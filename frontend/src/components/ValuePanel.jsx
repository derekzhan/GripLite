/**
 * ValuePanel.jsx — single-cell value inspector (Phase 6.4).
 *
 * Displays the raw value of the last-clicked Glide Data Grid cell in a
 * Monaco Editor with automatic language detection and formatting.
 *
 * Layout (sits to the right of the grid inside GridWithPanel):
 *
 *   ┌─ toolbar ───────────────────────────────────────────────────────┐
 *   │ col_name  [lang]       [Auto▼]  [↵]  [×]                       │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │                                                                  │
 *   │   Monaco Editor (read-only, dark theme, language-aware)         │
 *   │                                                                  │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * formatCellData(rawData, mode) — exported so tests can verify it:
 *
 *   Auto  → try JSON.parse; if ok → json; detect XML prefix; else plaintext
 *   JSON  → always set language=json; format if valid, show raw if not
 *   Text  → always plaintext
 *   XML   → always xml
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import { useTheme } from '../theme/ThemeProvider'

// ─────────────────────────────────────────────────────────────────────────────
// formatCellData
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determines display text and Monaco language for a raw cell value.
 *
 * @param {unknown} rawData   raw cell value from the result set (any type)
 * @param {'auto'|'json'|'text'|'xml'} mode
 * @returns {{ text: string, language: string, formatted: boolean, isNull: boolean }}
 */
export function formatCellData(rawData, mode) {
  if (rawData === null || rawData === undefined) {
    return { text: '', language: 'plaintext', formatted: false, isNull: true }
  }

  const str = String(rawData)

  // ── Explicit Text mode ───────────────────────────────────────────────────
  if (mode === 'text') {
    return { text: str, language: 'plaintext', formatted: false, isNull: false }
  }

  // ── Explicit XML mode ────────────────────────────────────────────────────
  if (mode === 'xml') {
    return { text: str, language: 'xml', formatted: false, isNull: false }
  }

  // ── JSON / Auto: try to parse as JSON ───────────────────────────────────
  if (mode === 'json' || mode === 'auto') {
    const trimmed = str.trim()
    // Quick prefix check to avoid calling JSON.parse on obviously non-JSON strings.
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try {
        const parsed = JSON.parse(trimmed)
        return {
          text:      JSON.stringify(parsed, null, 2),
          language:  'json',
          formatted: true,
          isNull:    false,
        }
      } catch {
        if (mode === 'json') {
          // User explicitly chose JSON — show raw but highlight as json anyway
          return { text: str, language: 'json', formatted: false, isNull: false }
        }
      }
    }
  }

  // ── Auto: detect XML ────────────────────────────────────────────────────
  if (mode === 'auto') {
    const trimmed = str.trim()
    if (trimmed.startsWith('<')) {
      return { text: str, language: 'xml', formatted: false, isNull: false }
    }
  }

  // ── Fallback: plain text ─────────────────────────────────────────────────
  return { text: str, language: 'plaintext', formatted: false, isNull: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// Language badge colour
// ─────────────────────────────────────────────────────────────────────────────
const LANG_COLOURS = {
  json:      'text-syntax-pk bg-success/10',
  xml:       'text-success bg-success/10',
  plaintext: 'text-fg-muted bg-elevated',
}

const MODES = [
  { value: 'auto', label: 'Auto' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'xml',  label: 'XML'  },
]

// ─────────────────────────────────────────────────────────────────────────────
// ValuePanel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   value:      unknown,    // raw cell value from the result set
 *   columnName: string,     // name of the clicked column (shown in header)
 *   rowIndex:   number,     // 0-based row index (shown in header)
 *   onClose:    () => void, // called when the × button is clicked
 *   // Inline-edit integration (all optional — panel is read-only without them).
 *   editState?: {
 *     editCell: (col:number, row:number, value:any) => void,
 *     isEdited: (col:number, row:number) => boolean,
 *     isDeleted:(row:number) => boolean,
 *     getCellValue:(col:number, row:number) => any,
 *   },
 *   col?:  number,
 *   row?:  number,
 * }} props
 */
export default function ValuePanel({ value, columnName, rowIndex, onClose, editState, col, row }) {
  const [mode,     setMode]     = useState('auto')
  const [wordWrap, setWordWrap] = useState(true)
  const [copied,   setCopied]   = useState(false)
  const editorRef = useRef(null)
  const monacoRef = useRef(null)
  const { resolvedTheme } = useTheme()

  // Editing is available only when the caller wired up editState + (col,row).
  // When the selected row is marked for deletion we stay read-only and hint
  // at why.
  const canEdit   = !!editState && typeof col === 'number' && typeof row === 'number'
  const rowDeleted = canEdit ? !!editState.isDeleted(row) : false
  const editable   = canEdit && !rowDeleted

  const { text, language, formatted, isNull } = formatCellData(value, mode)

  // draft is the editable buffer; we seed it from `text` whenever the
  // underlying cell identity or its effective value changes.  Typing in the
  // Monaco editor mutates `draft` without touching editState until the user
  // explicitly commits.
  const [draft,    setDraft]    = useState(text)
  const [dirty,    setDirty]    = useState(false)

  useEffect(() => {
    setDraft(text)
    setDirty(false)
  // Deliberately re-sync on cell / effective-value changes.  We compare the
  // *original* text (not draft) so a pending edit doesn't get stomped by a
  // parent re-render that reports the same cell.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [col, row, text, mode])

  const langColour = LANG_COLOURS[language] ?? LANG_COLOURS.plaintext

  const onEditorMount = useCallback((editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    if (!editable || !monaco) return
    // Cmd/Ctrl+S inside the editor commits the draft and keeps the panel open.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      commitDraftRef.current?.()
    })
  }, [editable])

  const copyValue = () => {
    const toCopy = isNull && !dirty ? 'NULL' : (dirty ? draft : text)
    navigator.clipboard.writeText(toCopy).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // ── Editing actions ───────────────────────────────────────────────────
  // We go through a ref so the Monaco keybinding registered at mount always
  // sees the freshest closure (state updates otherwise create stale handles).
  const commitDraftRef = useRef(null)
  const commitDraft = useCallback(() => {
    if (!editable) return
    if (!dirty) return
    // Writing the raw draft text back.  For JSON the user can minify/format
    // freely — we keep what they typed byte-for-byte so MySQL stores exactly
    // what's on screen.  NULL is set via the dedicated button; an empty
    // string is treated as an empty string, not NULL.
    editState.editCell(col, row, draft)
    setDirty(false)
  }, [editable, dirty, editState, col, row, draft])
  commitDraftRef.current = commitDraft

  const discardDraft = useCallback(() => {
    setDraft(text)
    setDirty(false)
  }, [text])

  const setValueToNull = useCallback(() => {
    if (!editable) return
    editState.editCell(col, row, null)
    // Also reset the local draft so the editor shows '' (matches the NULL
    // placeholder), and clear the dirty flag since we just committed.
    setDraft('')
    setDirty(false)
  }, [editable, editState, col, row])

  return (
    <div
      className="flex flex-col h-full bg-app"
      style={{ boxShadow: '-3px 0 12px rgba(0,0,0,0.25)' }}
    >
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 bg-titlebar border-b border-line-subtle
                      flex-shrink-0">

        {/* Column name + row indicator */}
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-[11px] font-mono text-syntax-keyword truncate leading-tight" title={columnName}>
            {columnName ?? '(column)'}
          </span>
          <span className="text-[10px] text-fg-muted leading-tight tabular-nums">
            row {rowIndex + 1}
          </span>
        </div>

        {/* Language detection badge */}
        <span className={`text-[10px] px-1.5 py-px rounded font-mono select-none flex-shrink-0 ${langColour}`}>
          {formatted ? `${language} ✓` : language}
        </span>

        {/* Mode dropdown */}
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          className="bg-elevated text-fg-secondary border border-line rounded px-1.5 py-0.5
                     text-[11px] outline-none cursor-pointer hover:border-accent transition-colors
                     flex-shrink-0"
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>

        {/* Word wrap toggle (compact, non-primary) */}
        <button
          onClick={() => setWordWrap((w) => !w)}
          title={`Word wrap: ${wordWrap ? 'on (click to disable)' : 'off (click to enable)'}`}
          className={[
            'flex-shrink-0 w-6 h-6 flex items-center justify-center text-[13px] rounded',
            'transition-colors select-none border',
            wordWrap
              ? 'border-line text-fg-secondary bg-hover'
              : 'border-transparent text-fg-muted hover:text-fg-primary hover:bg-hover',
          ].join(' ')}
        >
          ⮒
        </button>

        {/* Copy */}
        <button
          onClick={copyValue}
          title="Copy value"
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center text-[12px] rounded
                     border border-transparent text-fg-muted
                     hover:text-fg-primary hover:border-line transition-colors select-none"
        >
          {copied ? '✓' : '⎘'}
        </button>

        {/* Save (↵) — only meaningful when an editable cell is bound. */}
        {canEdit && (
          <button
            onClick={commitDraft}
            disabled={!editable || !dirty}
            title={
              !editable ? 'Row is marked for deletion'
              : !dirty  ? 'No changes to save'
              : 'Save change (⌘/Ctrl+S)'
            }
            className={[
              'flex-shrink-0 w-7 h-6 flex items-center justify-center rounded',
              'text-[12px] font-semibold transition-colors select-none border',
              editable && dirty
                ? 'bg-accent border-accent text-fg-on-accent hover:bg-accent-hover ring-1 ring-success/40'
                : 'border-line-subtle text-fg-faint cursor-not-allowed',
            ].join(' ')}
          >
            ↵
          </button>
        )}

        {/* Cancel (×) — dirty: discards draft without closing.  clean: closes. */}
        <button
          onClick={() => {
            if (canEdit && dirty) {
              discardDraft()
            } else {
              onClose()
            }
          }}
          title={
            canEdit && dirty ? 'Discard unsaved changes'
            : 'Close value panel'
          }
          className={[
            'flex-shrink-0 w-6 h-6 flex items-center justify-center rounded',
            'text-[15px] leading-none transition-colors select-none border',
            canEdit && dirty
              ? 'border-danger/60 text-danger hover:bg-danger-bg'
              : 'border-transparent text-fg-muted hover:text-fg-primary hover:bg-hover',
          ].join(' ')}
        >
          ×
        </button>
      </div>

      {/* ── Dirty / state indicator strip ───────────────────────────── */}
      {canEdit && (
        <div className={[
          'px-3 py-1 text-[11px] flex-shrink-0 flex items-center gap-2 border-b transition-colors',
          rowDeleted
            ? 'bg-danger-bg border-danger/40 text-danger'
            : dirty
              ? 'bg-warn-bg border-warn/40 text-warn'
              : 'bg-sunken border-line-subtle text-fg-muted',
        ].join(' ')}>
          {rowDeleted ? (
            <span>Row is marked for deletion — editing is disabled.</span>
          ) : dirty ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
              <span className="font-medium">Unsaved changes</span>
              <span className="text-warn/80">· press ↵ or ⌘/Ctrl+S to save, × to discard</span>
            </>
          ) : (
            <span>
              Editing <span className="text-syntax-keyword font-mono">{columnName}</span>
              {isNull && <span className="ml-1 text-fg-muted">(currently NULL)</span>}
              <span className="ml-2 text-fg-faint">· type to edit</span>
            </span>
          )}
          <div className="flex-1" />
          {/* Explicit NULL action — only shown when the value isn't already
              NULL and there are no unsaved text changes.  Clicking commits a
              true SQL NULL via editState and clears the draft buffer. */}
          {editable && !isNull && !dirty && (
            <button
              onClick={setValueToNull}
              title="Set this cell to SQL NULL"
              className="text-[10px] px-1.5 py-0.5 rounded border border-line text-fg-muted
                         hover:text-fg-primary hover:border-accent transition-colors select-none"
            >
              Set NULL
            </button>
          )}
        </div>
      )}

      {/* ── Content ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        {/* Preserve the original NULL placeholder when the panel is strictly
            read-only (ad-hoc query results, row marked for deletion).  In
            edit mode we always show the editor so the user can overwrite
            NULL by just typing. */}
        {isNull && !editable ? (
          <div className="flex items-center justify-center h-full gap-2 select-none">
            <span className="text-fg-muted text-[13px] italic">NULL</span>
            <span className="text-fg-faint text-[11px]">— no value</span>
          </div>
        ) : (
          <Editor
            height="100%"
            language={language}
            value={editable ? draft : text}
            theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
            onMount={onEditorMount}
            onChange={editable
              ? (next) => {
                  const nextText = next ?? ''
                  setDraft(nextText)
                  setDirty(nextText !== text)
                }
              : undefined}
            options={{
              readOnly:              !editable,
              domReadOnly:           !editable,
              wordWrap:              wordWrap ? 'on' : 'off',
              minimap:               { enabled: false },
              scrollBeyondLastLine:  false,
              lineNumbers:           'off',
              folding:               true,
              foldingHighlight:      true,
              fontSize:              12,
              lineHeight:            20,
              padding:               { top: 10, bottom: 10 },
              fontFamily:            '"JetBrains Mono","Fira Code",Consolas,"Courier New",monospace',
              renderLineHighlight:   editable ? 'line' : 'none',
              occurrencesHighlight:  false,
              selectionHighlight:    false,
              scrollbar: {
                verticalScrollbarSize:   6,
                horizontalScrollbarSize: 6,
                useShadows:              false,
              },
              overviewRulerLanes:        0,
              hideCursorInOverviewRuler: true,
              contextmenu:               true,
              automaticLayout:           true,
            }}
          />
        )}
      </div>
    </div>
  )
}
