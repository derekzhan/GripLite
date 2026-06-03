import { useEffect } from 'react'
import { AlertTriangle, X } from 'lucide-react'

/**
 * IndexActionModal — confirmation dialog for dropping a collection index.
 * Mirrors TableActionModal's delete styling so the explorer's destructive
 * actions feel consistent.
 */
export default function IndexActionModal({
  target,
  isBusy = false,
  error = '',
  onCancel,
  onConfirm,
}) {
  const isOpen = !!target

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !isBusy) onCancel?.()
      if (e.key === 'Enter' && !isBusy) onConfirm?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center overlay-enter"
      style={{ background: 'var(--bg-overlay)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !isBusy) onCancel?.() }}
    >
      <div
        className="modal-enter w-[520px] max-w-[94vw] rounded-xl overflow-hidden bg-[color:var(--card-bg)] border border-[color:var(--border-strong)]"
        style={{ boxShadow: 'var(--card-shadow)' }}
      >
        <div className="relative px-5 py-3 border-b border-[color:var(--border-subtle)] text-center">
          <h2 className="text-[16px] font-semibold text-[color:var(--fg-primary)]">Delete index</h2>
          <button
            onClick={onCancel}
            disabled={isBusy}
            className="absolute right-2 top-2 w-7 h-7 rounded flex items-center justify-center text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)] hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
            title="Close"
          >
            <X size={15} />
          </button>
        </div>

        <div className="px-8 py-6 space-y-4">
          <div className="text-[13px] text-[color:var(--fg-secondary)]">
            <span className="text-[color:var(--fg-muted)]">Index:</span>{' '}
            <span className="font-mono text-[color:var(--fg-primary)]">{target.indexName}</span>
            <span className="text-[color:var(--fg-muted)]"> on </span>
            <span className="font-mono text-[color:var(--fg-primary)]">{target.tableName}</span>
          </div>

          <div className="flex items-start gap-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-[color:var(--fg-primary)]">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-red-500" />
            <div>This will permanently drop the index. This action cannot be undone.</div>
          </div>

          {error && (
            <div className="text-[12px] text-red-500">{error}</div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-8 px-8 pb-7">
          <button
            onClick={onCancel}
            disabled={isBusy}
            className="py-1.5 rounded border border-[color:var(--border-strong)] text-[13px] text-[color:var(--fg-primary)] bg-[color:var(--bg-elev-2)] hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-60"
          >
            No
          </button>
          <button
            onClick={onConfirm}
            disabled={isBusy}
            className="py-1.5 rounded border border-[color:var(--border-strong)] text-[13px] font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-70"
          >
            {isBusy ? 'Deleting...' : 'Yes'}
          </button>
        </div>
      </div>
    </div>
  )
}
