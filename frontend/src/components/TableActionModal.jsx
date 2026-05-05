import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

export default function TableActionModal({
  action,
  target,
  isBusy = false,
  error = '',
  onCancel,
  onConfirm,
}) {
  const isOpen = !!action && !!target
  const isRename = action === 'rename'
  const [newTableName, setNewTableName] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setNewTableName(target?.tableName ?? '')
  }, [isOpen, target?.tableName])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !isBusy) onCancel?.()
      if (e.key === 'Enter' && !isBusy) submit()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (!isOpen) return null

  const trimmedName = newTableName.trim()
  const canConfirm = !isBusy && (!isRename || (trimmedName && trimmedName !== target.tableName))
  const title = isRename ? 'Rename table' : 'Delete table'
  const buttonLabel = isBusy
    ? (isRename ? 'Renaming...' : 'Deleting...')
    : (isRename ? 'Rename' : 'Delete')

  function submit() {
    if (!canConfirm) return
    onConfirm?.(isRename ? { newTableName: trimmedName } : {})
  }

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
          <h2 className="text-[16px] font-semibold text-[color:var(--fg-primary)]">{title}</h2>
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
            <span className="text-[color:var(--fg-muted)]">Table:</span>{' '}
            <span className="font-mono text-[color:var(--fg-primary)]">{target.dbName}.{target.tableName}</span>
          </div>

          {isRename ? (
            <label className="grid grid-cols-[120px_1fr] items-center gap-3 text-[13px]">
              <span className="text-[color:var(--fg-primary)]">New name:</span>
              <input
                autoFocus
                value={newTableName}
                onChange={(e) => setNewTableName(e.target.value)}
                disabled={isBusy}
                className="w-full bg-[color:var(--bg-elev-2)] text-[color:var(--fg-primary)] border border-[color:var(--border-strong)] rounded px-2 py-1.5 outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/25 disabled:opacity-60"
              />
            </label>
          ) : (
            <div className="flex items-start gap-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-[color:var(--fg-primary)]">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-red-500" />
              <div>
                This will permanently drop the table and its data. This action cannot be undone.
              </div>
            </div>
          )}

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
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canConfirm}
            className={[
              'py-1.5 rounded border border-[color:var(--border-strong)] text-[13px] font-medium disabled:bg-[color:var(--bg-elev-2)] disabled:text-[color:var(--fg-muted)] disabled:opacity-70',
              isRename
                ? 'bg-[color:var(--accent)] text-[color:var(--fg-on-accent)] hover:bg-[color:var(--accent-hover)]'
                : 'bg-red-600 text-white hover:bg-red-500',
            ].join(' ')}
          >
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
