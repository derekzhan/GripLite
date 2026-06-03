import { useEffect, useMemo, useState } from 'react'
import { X, Search, ArrowUp, ArrowDown, KeyRound, Loader2 } from 'lucide-react'
import { getTableSchema } from '../lib/bridge'

/**
 * CreateIndexModal — DataGrip-style "Add index" dialog for MongoDB collections.
 *
 * The user picks one or more fields (order matters for compound indexes),
 * toggles ascending / descending per key, optionally marks it unique, and
 * names it.  On confirm the parent receives the structured spec and turns it
 * into a `createIndex` shell command.
 */
function defaultIndexName(keys) {
  if (!keys.length) return ''
  return keys.map((k) => `${k.name}_${k.dir}`).join('_')
}

export default function CreateIndexModal({
  target,
  isBusy = false,
  error = '',
  onCancel,
  onConfirm,
}) {
  const isOpen = !!target

  const [fields, setFields] = useState([])
  const [loadingFields, setLoadingFields] = useState(false)
  const [fieldsError, setFieldsError] = useState('')
  const [filter, setFilter] = useState('')
  const [keys, setKeys] = useState([]) // [{ name, dir }]
  const [unique, setUnique] = useState(false)
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)

  // Reset + load the collection fields whenever the dialog opens.
  useEffect(() => {
    if (!isOpen) return
    setFilter('')
    setKeys([])
    setUnique(false)
    setName('')
    setNameEdited(false)
    setFieldsError('')
    setLoadingFields(true)
    let cancelled = false
    getTableSchema(target.connId, target.dbName, target.tableName)
      .then((schema) => {
        if (cancelled) return
        const cols = (schema?.columns ?? [])
          .map((c) => ({ name: c.name, type: c.type }))
          .filter((c) => c.name)
        setFields(cols)
      })
      .catch((e) => {
        if (cancelled) return
        setFieldsError(String(e?.message ?? e))
        setFields([])
      })
      .finally(() => { if (!cancelled) setLoadingFields(false) })
    return () => { cancelled = true }
  }, [isOpen, target?.connId, target?.dbName, target?.tableName])

  // Keep the auto-generated name in sync until the user takes it over.
  useEffect(() => {
    if (!nameEdited) setName(defaultIndexName(keys))
  }, [keys, nameEdited])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !isBusy) onCancel?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const selectedNames = useMemo(() => new Set(keys.map((k) => k.name)), [keys])
  const visibleFields = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return fields
    return fields.filter((f) => f.name.toLowerCase().includes(q))
  }, [fields, filter])

  if (!isOpen) return null

  const toggleField = (fieldName) => {
    setKeys((prev) =>
      prev.some((k) => k.name === fieldName)
        ? prev.filter((k) => k.name !== fieldName)
        : [...prev, { name: fieldName, dir: 1 }],
    )
  }
  const setDir = (fieldName, dir) =>
    setKeys((prev) => prev.map((k) => (k.name === fieldName ? { ...k, dir } : k)))
  const move = (idx, delta) =>
    setKeys((prev) => {
      const next = [...prev]
      const j = idx + delta
      if (j < 0 || j >= next.length) return prev
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  const removeKey = (fieldName) => setKeys((prev) => prev.filter((k) => k.name !== fieldName))

  const canConfirm = !isBusy && keys.length > 0
  const submit = () => {
    if (!canConfirm) return
    onConfirm?.({ keys, unique, name: name.trim() })
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center overlay-enter"
      style={{ background: 'var(--bg-overlay)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !isBusy) onCancel?.() }}
    >
      <div
        className="modal-enter w-[680px] max-w-[95vw] rounded-xl overflow-hidden bg-[color:var(--card-bg)] border border-[color:var(--border-strong)]"
        style={{ boxShadow: 'var(--card-shadow)' }}
      >
        <div className="relative px-5 py-3 border-b border-[color:var(--border-subtle)] text-center">
          <h2 className="text-[16px] font-semibold text-[color:var(--fg-primary)] flex items-center justify-center gap-2">
            <KeyRound size={15} className="text-[color:var(--accent)]" />
            Create index
          </h2>
          <div className="text-[12px] text-[color:var(--fg-muted)] mt-0.5 font-mono">
            {target.dbName}.{target.tableName}
          </div>
          <button
            onClick={onCancel}
            disabled={isBusy}
            className="absolute right-2 top-2 w-7 h-7 rounded flex items-center justify-center text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)] hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
            title="Close"
          >
            <X size={15} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-0">
          {/* ── Available fields ─────────────────────────────────────── */}
          <div className="border-r border-[color:var(--border-subtle)] flex flex-col" style={{ height: 340 }}>
            <div className="px-3 py-2 border-b border-[color:var(--border-subtle)]">
              <div className="flex items-center gap-1.5 rounded border border-[color:var(--border-strong)] bg-[color:var(--bg-elev-2)] px-2 py-1">
                <Search size={13} className="text-[color:var(--fg-muted)] flex-shrink-0" />
                <input
                  autoFocus
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter fields"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="w-full bg-transparent outline-none text-[12px] text-[color:var(--fg-primary)] placeholder:text-[color:var(--fg-muted)]"
                />
              </div>
            </div>
            <div className="flex-1 overflow-auto py-1">
              {loadingFields ? (
                <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-[color:var(--fg-muted)]">
                  <Loader2 size={13} className="animate-spin" /> Loading fields…
                </div>
              ) : fieldsError ? (
                <div className="px-3 py-3 text-[12px] text-red-500">{fieldsError}</div>
              ) : visibleFields.length === 0 ? (
                <div className="px-3 py-3 text-[12px] text-[color:var(--fg-muted)]">
                  {fields.length === 0 ? 'No fields detected for this collection.' : 'No matching fields.'}
                </div>
              ) : (
                visibleFields.map((f) => {
                  const checked = selectedNames.has(f.name)
                  return (
                    <label
                      key={f.name}
                      className="flex items-center gap-2 px-3 py-1 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleField(f.name)}
                        className="accent-[color:var(--accent)]"
                      />
                      <span className="text-[12px] font-mono text-[color:var(--fg-primary)] truncate">{f.name}</span>
                      {f.type && (
                        <span className="text-[10px] text-[color:var(--fg-muted)] ml-auto truncate max-w-[80px]">{f.type}</span>
                      )}
                    </label>
                  )
                })
              )}
            </div>
          </div>

          {/* ── Index keys (ordered) + options ──────────────────────── */}
          <div className="flex flex-col" style={{ height: 340 }}>
            <div className="px-3 py-2 border-b border-[color:var(--border-subtle)] text-[11px] uppercase tracking-wide text-[color:var(--fg-muted)]">
              Index keys {keys.length > 0 && <span className="tabular-nums">({keys.length})</span>}
            </div>
            <div className="flex-1 overflow-auto py-1">
              {keys.length === 0 ? (
                <div className="px-3 py-3 text-[12px] text-[color:var(--fg-muted)]">
                  Select fields on the left to build the index. Order matters for compound indexes.
                </div>
              ) : (
                keys.map((k, i) => (
                  <div key={k.name} className="flex items-center gap-1.5 px-3 py-1">
                    <span className="text-[10px] tabular-nums text-[color:var(--fg-muted)] w-4 text-right select-none">{i + 1}</span>
                    <span className="text-[12px] font-mono text-[color:var(--fg-primary)] flex-1 truncate" title={k.name}>{k.name}</span>
                    <div className="flex rounded border border-[color:var(--border-strong)] overflow-hidden text-[10px]">
                      <button
                        onClick={() => setDir(k.name, 1)}
                        className={k.dir === 1
                          ? 'px-1.5 py-0.5 bg-[color:var(--accent)] text-[color:var(--fg-on-accent)]'
                          : 'px-1.5 py-0.5 text-[color:var(--fg-secondary)] hover:bg-black/5 dark:hover:bg-white/10'}
                        title="Ascending (1)"
                      >
                        ASC
                      </button>
                      <button
                        onClick={() => setDir(k.name, -1)}
                        className={k.dir === -1
                          ? 'px-1.5 py-0.5 bg-[color:var(--accent)] text-[color:var(--fg-on-accent)]'
                          : 'px-1.5 py-0.5 text-[color:var(--fg-secondary)] hover:bg-black/5 dark:hover:bg-white/10'}
                        title="Descending (-1)"
                      >
                        DESC
                      </button>
                    </div>
                    <button
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      className="p-0.5 text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)] disabled:opacity-25"
                      title="Move up"
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      onClick={() => move(i, 1)}
                      disabled={i === keys.length - 1}
                      className="p-0.5 text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)] disabled:opacity-25"
                      title="Move down"
                    >
                      <ArrowDown size={13} />
                    </button>
                    <button
                      onClick={() => removeKey(k.name)}
                      className="p-0.5 text-[color:var(--fg-muted)] hover:text-red-500"
                      title="Remove"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="px-3 py-2 border-t border-[color:var(--border-subtle)] space-y-2">
              <label className="flex items-center gap-2 text-[12px] text-[color:var(--fg-primary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={unique}
                  onChange={(e) => setUnique(e.target.checked)}
                  className="accent-[color:var(--accent)]"
                />
                Unique
              </label>
              <label className="block">
                <span className="text-[11px] text-[color:var(--fg-muted)]">Index name</span>
                <input
                  value={name}
                  onChange={(e) => { setName(e.target.value); setNameEdited(true) }}
                  placeholder={defaultIndexName(keys) || 'auto'}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="mt-0.5 w-full bg-[color:var(--bg-elev-2)] text-[color:var(--fg-primary)] border border-[color:var(--border-strong)] rounded px-2 py-1 text-[12px] font-mono outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/25"
                />
              </label>
            </div>
          </div>
        </div>

        {error && (
          <div className="px-5 pt-3 text-[12px] text-red-500">{error}</div>
        )}

        <div className="grid grid-cols-2 gap-8 px-8 py-5">
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
            className="py-1.5 rounded border border-[color:var(--border-strong)] text-[13px] font-medium bg-[color:var(--accent)] text-[color:var(--fg-on-accent)] hover:bg-[color:var(--accent-hover)] disabled:bg-[color:var(--bg-elev-2)] disabled:text-[color:var(--fg-muted)] disabled:opacity-70"
          >
            {isBusy ? 'Creating…' : 'Create index'}
          </button>
        </div>
      </div>
    </div>
  )
}
