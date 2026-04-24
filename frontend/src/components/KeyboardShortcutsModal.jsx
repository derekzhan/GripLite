/**
 * KeyboardShortcutsModal — Help → Docs shortcut reference.
 *
 * Lists every keyboard shortcut available in the app, grouped by context.
 * Mirrors the look of AboutModal (same overlay, card-bg, border tokens).
 */
import { useEffect } from 'react'
import { X, Keyboard } from 'lucide-react'

// ─── Data ────────────────────────────────────────────────────────────────────

const SECTIONS = [
  {
    title: 'SQL Console',
    rows: [
      { keys: ['⌘', 'Enter'],  label: 'Run selected / current statement' },
      { keys: ['Ctrl', 'Enter'], label: 'Run selected / current statement (Windows / Linux)' },
    ],
  },
  {
    title: 'Explorer — Database (right-click)',
    rows: [
      { keys: ['B'],  label: 'Browse from here — open SQL console for this DB' },
      { keys: ['F4'], label: 'View Tables — open table overview' },
      { keys: ['N'],  label: 'Create New Table…' },
      { keys: ['F5'], label: 'Refresh database' },
    ],
  },
  {
    title: 'Explorer — Connection (right-click)',
    rows: [
      { keys: ['C'],  label: 'Connect' },
      { keys: ['D'],  label: 'Disconnect' },
      { keys: ['F5'], label: 'Refresh connection' },
      { keys: ['P'],  label: 'Properties…' },
    ],
  },
  {
    title: 'Explorer — Table (right-click)',
    rows: [
      { keys: ['F4'], label: 'View Table' },
    ],
  },
  {
    title: 'Context menu navigation',
    rows: [
      { keys: ['↑', '↓'],  label: 'Move highlight up / down' },
      { keys: ['Enter'],   label: 'Execute highlighted item' },
      { keys: ['Esc'],     label: 'Close menu' },
    ],
  },
  {
    title: 'General',
    rows: [
      { keys: ['Esc'], label: 'Close dialog / panel' },
    ],
  },
]

// ─── Component ───────────────────────────────────────────────────────────────

export default function KeyboardShortcutsModal({ isOpen, onClose }) {
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center overlay-enter"
      style={{ background: 'var(--bg-overlay)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div
        className="modal-enter w-[560px] max-w-[95vw] max-h-[85vh] flex flex-col rounded-lg overflow-hidden
                   bg-[color:var(--card-bg)] border border-[color:var(--border-strong)]"
        style={{ boxShadow: 'var(--card-shadow)' }}
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4
                        border-b border-[color:var(--border-subtle)] flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 flex items-center justify-center rounded-md
                            bg-gradient-to-br from-[#0e639c] to-[#1fb6d1]">
              <Keyboard size={15} className="text-white" strokeWidth={2} />
            </div>
            <h2 className="text-[14px] font-semibold text-[color:var(--fg-primary)]">
              Keyboard Shortcuts
            </h2>
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="w-7 h-7 flex items-center justify-center rounded
                       text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)]
                       hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* ── Scrollable body ─────────────────────────────────────────── */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider
                             text-[color:var(--fg-muted)] mb-2">
                {section.title}
              </h3>
              <div className="rounded-md border border-[color:var(--border-subtle)]
                              bg-black/[0.02] dark:bg-white/[0.02] divide-y divide-[color:var(--border-subtle)]">
                {section.rows.map((row, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-2 gap-4">
                    <span className="text-[12px] text-[color:var(--fg-primary)] flex-1">
                      {row.label}
                    </span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {row.keys.map((k, ki) => (
                        <kbd
                          key={ki}
                          className="inline-flex items-center justify-center min-w-[26px] px-1.5 py-0.5
                                     text-[11px] font-mono rounded border
                                     border-[color:var(--border-strong)]
                                     bg-[color:var(--card-bg)]
                                     text-[color:var(--fg-secondary)]
                                     shadow-[0_1px_0_0_var(--border-strong)]"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <div className="flex justify-end px-6 py-3
                        border-t border-[color:var(--border-subtle)] flex-shrink-0">
          <button
            onClick={onClose}
            className="px-5 py-1.5 rounded text-[12px] font-medium
                       bg-[color:var(--accent)] hover:bg-[color:var(--accent-hover)]
                       text-[color:var(--fg-on-accent)] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
