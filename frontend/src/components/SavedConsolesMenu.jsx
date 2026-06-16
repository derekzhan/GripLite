/**
 * SavedConsolesMenu — title-bar dropdown for DBeaver-style saved SQL consoles.
 *
 * Lists saved consoles (click to open) and offers "Save current console…".
 * Lives in the title bar so it's always reachable on every platform.
 */
import { useEffect, useRef, useState } from 'react'
import { FileCode2, Save, Trash2, ChevronDown } from 'lucide-react'

export default function SavedConsolesMenu({ consoles = [], canSave = false, onSaveCurrent, onOpen, onDelete }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative h-full flex items-center" style={{ WebkitAppRegion: 'no-drag' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Saved consoles"
        className={[
          'flex items-center gap-1 h-full px-2 text-[12px] font-medium select-none rounded-sm transition-colors',
          open
            ? 'bg-black/10 dark:bg-white/10 text-[color:var(--fg-primary)]'
            : 'text-[color:var(--fg-secondary)] hover:bg-black/5 dark:hover:bg-white/5 hover:text-[color:var(--fg-primary)]',
        ].join(' ')}
      >
        <FileCode2 size={13} className="opacity-70" />
        Consoles
        <ChevronDown size={11} className="opacity-60" />
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-0.5 z-50 min-w-[260px] max-h-[420px] overflow-y-auto py-1
                     rounded shadow-xl bg-[color:var(--card-bg)] border border-[color:var(--border-strong)]"
        >
          <button
            disabled={!canSave}
            onClick={() => { setOpen(false); onSaveCurrent?.() }}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12px]
                       text-[color:var(--fg-primary)] disabled:opacity-40 disabled:cursor-not-allowed
                       hover:bg-[color:var(--accent)] hover:text-[color:var(--fg-on-accent)] transition-colors"
          >
            <Save size={13} />
            Save current console…
          </button>

          <div className="my-1 border-t border-line-subtle" />

          {consoles.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-fg-muted text-center">No saved consoles yet</div>
          ) : (
            consoles.map((c) => (
              <div
                key={c.id}
                className="group flex items-center gap-2 px-3 py-1.5 hover:bg-hover cursor-pointer"
                onClick={() => { setOpen(false); onOpen?.(c) }}
                title={c.name}
              >
                <FileCode2 size={13} className="flex-shrink-0 text-fg-muted" />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-fg-primary truncate">{c.name}</div>
                  {(c.dbName || c.connectionKind) && (
                    <div className="text-[10px] text-fg-muted truncate">
                      {[c.connectionKind, c.dbName].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete?.(c) }}
                  className="opacity-0 group-hover:opacity-100 text-fg-muted hover:text-danger flex-shrink-0"
                  title="Delete saved console"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
