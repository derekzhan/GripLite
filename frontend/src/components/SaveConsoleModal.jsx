/**
 * SaveConsoleModal — name a console before saving it to griplite.db.
 * Re-saving an already-saved console prefills its current name.
 */
import { useState, useEffect, useRef } from 'react'
import { X, Save, Loader2 } from 'lucide-react'

export default function SaveConsoleModal({ isOpen, initialName = '', isSaving = false, error = '', onCancel, onSave }) {
  const [name, setName] = useState(initialName)
  const inputRef = useRef(null)

  useEffect(() => {
    if (isOpen) {
      setName(initialName)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (el) { el.focus(); el.select() }
      })
    }
  }, [isOpen, initialName])

  if (!isOpen) return null

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed || isSaving) return
    onSave?.(trimmed)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => !isSaving && onCancel?.()} />
      <div className="relative z-10 w-[400px] bg-panel border border-line rounded-lg shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-titlebar">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg-primary">
            <Save size={15} />
            Save Console
          </div>
          <button onClick={() => !isSaving && onCancel?.()} className="text-fg-muted hover:text-fg-primary">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-2">
          <label className="block text-xs text-fg-muted mb-1">Console name</label>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel?.() }}
            placeholder="e.g. orders report"
            className="w-full bg-sunken border border-line rounded px-2 py-1 text-sm text-fg-primary focus:outline-none focus:border-accent"
          />
          {error && <div className="text-xs text-danger">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-line bg-titlebar">
          <button
            onClick={() => !isSaving && onCancel?.()}
            className="px-3 py-1 text-sm text-fg-secondary hover:text-fg-primary"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!name.trim() || isSaving}
            className="px-3 py-1 text-sm rounded bg-accent text-white disabled:opacity-50 flex items-center gap-1.5"
          >
            {isSaving && <Loader2 size={13} className="animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
