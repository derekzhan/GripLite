/**
 * ReviewSqlModal — renders the server-computed ALTER TABLE preview and
 * asks the user to confirm before Execute is dispatched.
 *
 * Design constraints:
 *   - READ-ONLY SQL display (Monaco, sql, vs-dark) so every statement is
 *     visible at a glance and copyable without typos.
 *   - Destructive warnings (DROP COLUMN) surfaced above the editor.
 *   - Execute button disabled while the backend is running the commit
 *     path and while the preview is empty.
 *   - Errors from Execute are rendered inline; the modal stays open so
 *     the user can inspect the failed statement and retry/cancel.
 */
import { useEffect, useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import { X, AlertTriangle, Play, Copy, CheckCircle2 } from 'lucide-react'
import { normalizeError } from '../lib/errors'
import { useTheme } from '../theme/ThemeProvider'

export default function ReviewSqlModal({
  isOpen,
  preview,           // { statements: [...], warnings: [...] }
  onClose,
  onExecute,         // async () => result
  running,           // boolean
  result,            // last execute result (or error) — displayed inline
}) {
  const [copied, setCopied] = useState(false)
  const { resolvedTheme } = useTheme()

  // Join the statements into a single SQL blob for the Monaco viewer.
  const sqlText = useMemo(() => {
    if (!preview?.statements?.length) return '-- No changes detected.'
    return preview.statements.map((s) => s.sql).join('\n\n')
  }, [preview])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !running) onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, running, onClose])

  if (!isOpen) return null

  const copy = () => {
    navigator.clipboard.writeText(sqlText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const hasStatements = (preview?.statements?.length ?? 0) > 0
  const warnings = preview?.warnings ?? []
  const succeeded = result?.success
  const failed    = result && !result.success

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !running) onClose?.()
      }}
    >
      <div className="flex flex-col w-[820px] max-w-[95vw] h-[620px] max-h-[90vh]
                      bg-panel border border-line rounded-lg shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-titlebar border-b border-line-subtle">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-fg-primary">Review SQL</span>
            <span className="text-[11px] text-fg-muted">
              {hasStatements ? `${preview.statements.length} statement${preview.statements.length === 1 ? '' : 's'}` : 'no changes'}
            </span>
          </div>
          <button
            onClick={() => !running && onClose?.()}
            disabled={running}
            className="text-fg-muted hover:text-fg-primary disabled:opacity-50 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="flex flex-col gap-1 px-4 py-2 bg-danger-bg border-b border-danger">
            {warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-2 text-[11.5px] text-danger">
                <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        {hasStatements && (
          <div className="flex-shrink-0 px-4 py-2 bg-titlebar border-b border-line-subtle max-h-[120px] overflow-auto">
            <ol className="space-y-1 text-[11.5px] text-fg-secondary">
              {preview.statements.map((st, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-fg-muted w-6 text-right tabular-nums">{i + 1}.</span>
                  <span className="px-1.5 py-px rounded text-[10px] font-semibold border"
                        style={kindStyle(st.kind)}>{st.kind.toUpperCase()}</span>
                  <span className="flex-1 truncate">{st.summary}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* SQL editor — flex-1 + min-h-0 so it actually fills the available
            vertical space inside the outer flex column.  Monaco's
            `automaticLayout` then picks up real pixel dimensions. */}
        <div className="flex-1 min-h-0 relative">
          <Editor
            height="100%"
            value={sqlText}
            language="sql"
            theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
            options={{
              readOnly: true,
              domReadOnly: true,
              fontSize: 12,
              lineHeight: 18,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              renderLineHighlight: 'none',
              folding: false,
              smoothScrolling: true,
              automaticLayout: true,
              padding: { top: 8, bottom: 8 },
            }}
          />
        </div>

        {/* Execute result strip */}
        {result && (
          <div className={`flex items-start gap-2 px-4 py-2 border-t text-[11.5px] ${
            succeeded ? 'bg-success/10 border-success/40 text-success'
                      : 'bg-danger-bg border-danger/40 text-danger'
          }`}>
            {succeeded
              ? <CheckCircle2 size={13} className="mt-0.5 flex-shrink-0" />
              : <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />}
            <div className="flex-1">
              {succeeded
                ? `All ${result.executedCount} statement${result.executedCount === 1 ? '' : 's'} executed successfully.`
                : (
                  <>
                    <div className="font-semibold mb-1">
                      Failed at statement #{(result.failedIndex ?? 0) + 1} · {result.executedCount} executed before this failure.
                    </div>
                    {result.error && (
                      <pre className="font-mono whitespace-pre-wrap text-[11px] text-danger">
                        {typeof result.error === 'string' ? result.error : normalizeError(result.error)}
                      </pre>
                    )}
                    {result.failedStatement && (
                      <pre className="font-mono whitespace-pre-wrap text-[11px] text-syntax-string mt-1">{result.failedStatement}</pre>
                    )}
                  </>
                )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-titlebar border-t border-line-subtle">
          <button
            onClick={copy}
            disabled={!hasStatements}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] rounded border border-line
                       text-fg-secondary hover:bg-hover disabled:opacity-40 transition-colors"
          >
            <Copy size={12} /> {copied ? 'Copied' : 'Copy SQL'}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => !running && onClose?.()}
              disabled={running}
              className="px-3 py-1 text-[12px] rounded border border-line
                         text-fg-secondary hover:bg-hover disabled:opacity-50 transition-colors"
            >
              {succeeded ? 'Close' : 'Cancel'}
            </button>
            {!succeeded && (
              <button
                onClick={onExecute}
                disabled={running || !hasStatements}
                className="flex items-center gap-1.5 px-3 py-1 text-[12px] rounded
                           bg-accent hover:bg-accent-hover text-fg-on-accent font-medium
                           disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Play size={12} />
                {running ? 'Executing…' : (failed ? 'Retry' : 'Execute')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function kindStyle(kind) {
  switch (kind) {
    case 'add':      return { borderColor: '#4ec9b0', color: '#4ec9b0' }
    case 'drop':     return { borderColor: '#f48771', color: '#f48771' }
    case 'rename':
    case 'modify':   return { borderColor: '#dcdcaa', color: '#dcdcaa' }
    case 'reorder':  return { borderColor: '#9cdcfe', color: '#9cdcfe' }
    case 'table':    return { borderColor: '#c586c0', color: '#c586c0' }
    default:         return { borderColor: '#858585', color: '#858585' }
  }
}
