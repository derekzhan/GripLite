import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { DATABASE_CHARSET_OPTIONS, collationsForCharset } from '../lib/databaseTemplates'

export default function CreateDatabaseModal({ isOpen, isCreating = false, error = '', onCancel, onCreate }) {
  const [databaseName, setDatabaseName] = useState('')
  const [charset, setCharset] = useState('utf8mb4')
  const [collation, setCollation] = useState('utf8mb4_general_ci')

  const collations = useMemo(() => collationsForCharset(charset), [charset])

  useEffect(() => {
    if (!isOpen) return
    setDatabaseName('')
    setCharset('utf8mb4')
    setCollation('utf8mb4_general_ci')
  }, [isOpen])

  useEffect(() => {
    if (!collations.includes(collation)) {
      setCollation(collations[0] ?? '')
    }
  }, [collation, collations])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !isCreating) onCancel?.()
      if (e.key === 'Enter' && databaseName.trim() && !isCreating) {
        onCreate?.({ databaseName: databaseName.trim(), charset, collation })
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [charset, collation, databaseName, isCreating, isOpen, onCancel, onCreate])

  if (!isOpen) return null

  const canCreate = databaseName.trim().length > 0 && !isCreating

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center overlay-enter"
      style={{ background: 'var(--bg-overlay)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !isCreating) onCancel?.() }}
    >
      <div
        className="modal-enter w-[520px] max-w-[94vw] rounded-xl overflow-hidden bg-[color:var(--card-bg)] border border-[color:var(--border-strong)]"
        style={{ boxShadow: 'var(--card-shadow)' }}
      >
        <div className="relative px-5 py-3 border-b border-[color:var(--border-subtle)] text-center">
          <h2 className="text-[16px] font-semibold text-[color:var(--fg-primary)]">Create database</h2>
          <button
            onClick={onCancel}
            disabled={isCreating}
            className="absolute right-2 top-2 w-7 h-7 rounded flex items-center justify-center text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)] hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
            title="Close"
          >
            <X size={15} />
          </button>
        </div>

        <div className="px-8 py-6 space-y-4">
          <FormRow label="Database name:">
            <input
              autoFocus
              value={databaseName}
              onChange={(e) => setDatabaseName(e.target.value)}
              disabled={isCreating}
              className="w-full bg-[color:var(--bg-elev-2)] text-[color:var(--fg-primary)] border border-[color:var(--border-strong)] rounded px-2 py-1.5 outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/25 disabled:opacity-60"
            />
          </FormRow>

          <FormRow label="Charset:">
            <select
              value={charset}
              onChange={(e) => setCharset(e.target.value)}
              disabled={isCreating}
              className="w-full bg-[color:var(--bg-elev-2)] text-[color:var(--fg-primary)] border border-[color:var(--border-strong)] rounded px-2 py-1.5 outline-none focus:border-[color:var(--accent)] disabled:opacity-60"
            >
              {DATABASE_CHARSET_OPTIONS.map((opt) => (
                <option key={opt.charset} value={opt.charset}>{opt.charset}</option>
              ))}
            </select>
          </FormRow>

          <FormRow label="Collation:">
            <select
              value={collation}
              onChange={(e) => setCollation(e.target.value)}
              disabled={isCreating}
              className="w-full bg-[color:var(--bg-elev-2)] text-[color:var(--fg-primary)] border border-[color:var(--border-strong)] rounded px-2 py-1.5 outline-none focus:border-[color:var(--accent)] disabled:opacity-60"
            >
              {collations.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </FormRow>

          {error && (
            <div className="text-[12px] text-red-500 pl-[138px]">{error}</div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-8 px-8 pb-7">
          <button
            onClick={onCancel}
            disabled={isCreating}
            className="py-1.5 rounded border border-[color:var(--border-strong)] text-[13px] text-[color:var(--fg-primary)] bg-[color:var(--bg-elev-2)] hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            onClick={() => onCreate?.({ databaseName: databaseName.trim(), charset, collation })}
            disabled={!canCreate}
            className="py-1.5 rounded border border-[color:var(--border-strong)] text-[13px] font-medium bg-[color:var(--accent)] text-[color:var(--fg-on-accent)] hover:bg-[color:var(--accent-hover)] disabled:bg-[color:var(--bg-elev-2)] disabled:text-[color:var(--fg-muted)] disabled:opacity-70"
          >
            {isCreating ? 'Creating...' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}

function FormRow({ label, children }) {
  return (
    <label className="grid grid-cols-[138px_1fr] items-center gap-3 text-[13px]">
      <span className="text-[color:var(--fg-primary)]">{label}</span>
      {children}
    </label>
  )
}
