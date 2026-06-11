/**
 * AddRedisKeyModal — create a new Redis key.
 *
 * Redis has no empty keys, so creating one always materialises a first value
 * appropriate to the chosen type (an empty string, or a single placeholder
 * field/element/member/entry). The user refines it afterwards in the key viewer.
 */
import { useState, useEffect, useRef } from 'react'
import { X, KeyRound, Loader2 } from 'lucide-react'

const KEY_TYPES = [
  { id: 'string', label: 'String' },
  { id: 'hash', label: 'Hash' },
  { id: 'list', label: 'List' },
  { id: 'set', label: 'Set' },
  { id: 'zset', label: 'Sorted Set' },
  { id: 'stream', label: 'Stream' },
]

export default function AddRedisKeyModal({ isOpen, dbName, prefix = '', isCreating = false, error = '', onCancel, onCreate }) {
  const [name, setName] = useState(prefix)
  const [type, setType] = useState('string')
  const inputRef = useRef(null)

  useEffect(() => {
    if (isOpen) {
      setName(prefix)
      setType('string')
      // Focus + place cursor at the end so a prefilled namespace is easy to extend.
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
      })
    }
  }, [isOpen, prefix])

  if (!isOpen) return null

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed || isCreating) return
    onCreate?.({ name: trimmed, type })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => !isCreating && onCancel?.()} />
      <div className="relative z-10 w-[420px] bg-panel border border-line rounded-lg shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-titlebar">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg-primary">
            <KeyRound size={15} />
            New Redis Key
          </div>
          <button onClick={() => !isCreating && onCancel?.()} className="text-fg-muted hover:text-fg-primary">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="text-xs text-fg-muted">Database: <span className="text-fg-secondary">{dbName}</span></div>

          <div>
            <label className="block text-xs text-fg-muted mb-1">Key name</label>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel?.() }}
              placeholder="e.g. user:1001"
              className="w-full bg-sunken border border-line rounded px-2 py-1 text-sm text-fg-primary focus:outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-xs text-fg-muted mb-1">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full bg-sunken border border-line rounded px-2 py-1 text-sm text-fg-primary focus:outline-none focus:border-accent"
            >
              {KEY_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>

          <p className="text-[11px] text-fg-muted leading-relaxed">
            A placeholder value is created so the key exists; edit or remove it in the key viewer.
          </p>

          {error && <div className="text-xs text-danger">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-line bg-titlebar">
          <button
            onClick={() => !isCreating && onCancel?.()}
            className="px-3 py-1 text-sm text-fg-secondary hover:text-fg-primary"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!name.trim() || isCreating}
            className="px-3 py-1 text-sm rounded bg-accent text-white disabled:opacity-50 flex items-center gap-1.5"
          >
            {isCreating && <Loader2 size={13} className="animate-spin" />}
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
