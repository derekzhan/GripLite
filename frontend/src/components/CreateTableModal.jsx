import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Plus, Trash2, X } from 'lucide-react'
import {
  DATABASE_CHARSET_OPTIONS,
  MYSQL_COLUMN_TYPE_OPTIONS,
  buildCreateTableSql,
  collationsForCharset,
} from '../lib/databaseTemplates'
import { normalizeError } from '../lib/errors'

const ENGINE_OPTIONS = ['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV']
const DEFAULT_COLUMN = { name: 'id', type: 'INT', notNull: true, autoIncrement: true, key: 'PRIMARY', defaultValue: '', comment: '' }

export default function CreateTableModal({ isOpen, dbName, isCreating = false, error = '', onCancel, onCreate }) {
  const [tableName, setTableName] = useState('')
  const [description, setDescription] = useState('')
  const [engine, setEngine] = useState('InnoDB')
  const [charset, setCharset] = useState('utf8mb4')
  const [collation, setCollation] = useState('utf8mb4_general_ci')
  const [columns, setColumns] = useState([DEFAULT_COLUMN])
  const [localError, setLocalError] = useState('')

  const collations = useMemo(() => collationsForCharset(charset), [charset])
  const canCreate = tableName.trim() && columns.some((col) => col.name.trim() && col.type.trim()) && !isCreating

  useEffect(() => {
    if (!isOpen) return
    setTableName('')
    setDescription('')
    setEngine('InnoDB')
    setCharset('utf8mb4')
    setCollation('utf8mb4_general_ci')
    setColumns([{ ...DEFAULT_COLUMN }])
    setLocalError('')
  }, [isOpen])

  useEffect(() => {
    if (!collations.includes(collation)) setCollation(collations[0] ?? '')
  }, [collation, collations])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !isCreating) onCancel?.()
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canCreate) submit()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (!isOpen) return null

  const patchColumn = (idx, patch) => {
    setColumns((prev) => prev.map((col, i) => i === idx ? { ...col, ...patch } : col))
  }

  const addColumn = () => {
    setColumns((prev) => [...prev, { name: '', type: 'VARCHAR(255)', notNull: false, autoIncrement: false, key: '', defaultValue: '', comment: '' }])
  }

  const removeColumn = (idx) => {
    setColumns((prev) => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx))
  }

  const submit = () => {
    try {
      const sql = buildCreateTableSql({
        dbName,
        tableName: tableName.trim(),
        engine,
        charset,
        collation,
        comment: description,
        columns,
      })
      setLocalError('')
      onCreate?.({ tableName: tableName.trim(), sql })
    } catch (err) {
      setLocalError(normalizeError(err))
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center overlay-enter"
      style={{ background: 'var(--bg-overlay)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !isCreating) onCancel?.() }}
    >
      <div
        className="modal-enter flex flex-col w-[980px] max-w-[96vw] h-[720px] max-h-[92vh] rounded-lg overflow-hidden bg-[color:var(--card-bg)] border border-[color:var(--border-strong)]"
        style={{ boxShadow: 'var(--card-shadow)' }}
      >
        <div className="relative px-4 py-2.5 border-b border-[color:var(--border-subtle)] text-center">
          <h2 className="text-[15px] font-semibold text-[color:var(--fg-primary)]">Create table</h2>
          <button
            onClick={onCancel}
            disabled={isCreating}
            className="absolute right-2 top-2 w-7 h-7 rounded flex items-center justify-center text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)] hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
          >
            <X size={15} />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-[color:var(--border-subtle)] bg-titlebar">
          <div className="grid grid-cols-[90px_1fr_84px_180px_76px_180px] gap-3 items-center text-[12px]">
            <label className="text-[color:var(--fg-secondary)]">Table Name:</label>
            <input autoFocus value={tableName} onChange={(e) => setTableName(e.target.value)} disabled={isCreating} className={inputCls} />
            <label className="text-[color:var(--fg-secondary)]">Engine:</label>
            <select value={engine} onChange={(e) => setEngine(e.target.value)} disabled={isCreating} className={inputCls}>
              {ENGINE_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
            <label className="text-[color:var(--fg-secondary)]">Collation:</label>
            <select value={collation} onChange={(e) => setCollation(e.target.value)} disabled={isCreating} className={inputCls}>
              {collations.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>

            <label className="text-[color:var(--fg-secondary)] self-start pt-1">Description:</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={isCreating} className={`${inputCls} h-[54px] resize-none`} />
            <label className="text-[color:var(--fg-secondary)]">Charset:</label>
            <select value={charset} onChange={(e) => setCharset(e.target.value)} disabled={isCreating} className={inputCls}>
              {DATABASE_CHARSET_OPTIONS.map((opt) => <option key={opt.charset} value={opt.charset}>{opt.charset}</option>)}
            </select>
            <div className="col-span-2 text-[11px] text-[color:var(--fg-muted)]">Target database: <span className="font-mono">{dbName}</span></div>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          <aside className="w-[120px] border-r border-[color:var(--border-subtle)] bg-titlebar text-[12px]">
            {['Columns', 'Constraints', 'Foreign Keys', 'References', 'Triggers', 'Indexes', 'Partitions', 'Statistics', 'DDL'].map((item, idx) => (
              <div key={item} className={`px-3 py-2 border-b border-[color:var(--border-subtle)] ${idx === 0 ? 'bg-[color:var(--card-bg)] font-semibold text-[color:var(--fg-primary)]' : 'text-[color:var(--fg-secondary)]'}`}>
                {item}
              </div>
            ))}
          </aside>

          <main className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-[color:var(--border-subtle)] bg-titlebar">
              <span className="text-[12px] font-semibold text-[color:var(--fg-primary)]">Columns</span>
              <button onClick={addColumn} disabled={isCreating} className="flex items-center gap-1 px-2 py-1 rounded text-[12px] text-[color:var(--fg-secondary)] hover:bg-black/5 dark:hover:bg-white/10">
                <Plus size={13} /> Add Column
              </button>
            </div>

            <div className="flex-1 overflow-auto">
              <table className="w-full text-[12px] border-collapse">
                <thead className="sticky top-0 bg-titlebar z-10">
                  <tr>
                    {['Column Name', '# Data Type', 'Not Null', 'Auto Increment', 'Key', 'Default', 'Comment', ''].map((h) => (
                      <th key={h} className="text-left px-2 py-1.5 border-b border-r border-[color:var(--border-subtle)] text-[color:var(--fg-muted)] font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {columns.map((col, idx) => (
                    <tr key={idx}>
                      <CellInput value={col.name} onChange={(v) => patchColumn(idx, { name: v })} disabled={isCreating} placeholder="column_name" />
                      <CellTypeInput value={col.type} onChange={(v) => patchColumn(idx, { type: v })} disabled={isCreating} />
                      <CellCheck checked={col.notNull} onChange={(v) => patchColumn(idx, { notNull: v })} disabled={isCreating} />
                      <CellCheck checked={col.autoIncrement} onChange={(v) => patchColumn(idx, { autoIncrement: v, notNull: v ? true : col.notNull })} disabled={isCreating} />
                      <td className="border-b border-r border-[color:var(--border-subtle)] px-1">
                        <select value={col.key} onChange={(e) => patchColumn(idx, { key: e.target.value })} disabled={isCreating} className={cellInputCls}>
                          <option value=""> </option>
                          <option value="PRIMARY">PRIMARY</option>
                        </select>
                      </td>
                      <CellInput value={col.defaultValue} onChange={(v) => patchColumn(idx, { defaultValue: v })} disabled={isCreating} placeholder="NULL" mono />
                      <CellInput value={col.comment} onChange={(v) => patchColumn(idx, { comment: v })} disabled={isCreating} placeholder="" />
                      <td className="w-9 border-b border-r border-[color:var(--border-subtle)] text-center">
                        <button onClick={() => removeColumn(idx)} disabled={isCreating || columns.length <= 1} className="text-[color:var(--fg-muted)] hover:text-red-500 disabled:opacity-30">
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(localError || error) && <div className="px-3 py-2 text-[12px] text-red-500 border-t border-red-500/30 bg-red-500/10">{localError || error}</div>}
          </main>
        </div>

        <div className="flex justify-end gap-3 px-4 py-3 border-t border-[color:var(--border-subtle)] bg-titlebar">
          <button onClick={onCancel} disabled={isCreating} className="px-4 py-1.5 rounded border border-[color:var(--border-strong)] text-[12px] text-[color:var(--fg-secondary)] hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-60">
            Cancel
          </button>
          <button onClick={submit} disabled={!canCreate} className="px-5 py-1.5 rounded bg-[color:var(--accent)] text-[color:var(--fg-on-accent)] text-[12px] font-medium hover:bg-[color:var(--accent-hover)] disabled:opacity-50">
            {isCreating ? 'Creating...' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputCls = 'w-full bg-[color:var(--bg-elev-2)] text-[color:var(--fg-primary)] border border-[color:var(--border-strong)] rounded px-2 py-1 outline-none focus:border-[color:var(--accent)] disabled:opacity-60'
const cellInputCls = 'w-full bg-transparent text-[color:var(--fg-primary)] px-1 py-1 outline-none focus:bg-[color:var(--bg-elev-2)]'

function CellInput({ value, onChange, disabled, placeholder, mono = false }) {
  return (
    <td className="border-b border-r border-[color:var(--border-subtle)]">
      <input value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={placeholder} className={`${cellInputCls} ${mono ? 'font-mono' : ''}`} />
    </td>
  )
}

function CellTypeInput({ value, onChange, disabled }) {
  const [open, setOpen] = useState(false)
  return (
    <td className="relative border-b border-r border-[color:var(--border-subtle)]">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(false)}
        disabled={disabled}
        placeholder="VARCHAR(255)"
        className={`${cellInputCls} pr-7 font-mono`}
        title="Edit data type, or use the dropdown to choose a common MySQL type"
      />
      <button
        type="button"
        disabled={disabled}
        onMouseDown={(e) => {
          e.preventDefault()
          setOpen((cur) => !cur)
        }}
        className="absolute right-0 top-0 h-full w-7 flex items-center justify-center text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)] hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
        title="Choose data type"
      >
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-[10000] max-h-56 min-w-full overflow-auto rounded border border-[color:var(--border-strong)] bg-[color:var(--card-bg)] shadow-lg">
          {MYSQL_COLUMN_TYPE_OPTIONS.map((type) => (
            <button
              key={type}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                onChange(type)
                setOpen(false)
              }}
              className="block w-full px-2 py-1 text-left font-mono text-[12px] text-[color:var(--fg-primary)] hover:bg-[color:var(--bg-elev-2)]"
            >
              {type}
            </button>
          ))}
        </div>
      )}
    </td>
  )
}

function CellCheck({ checked, onChange, disabled }) {
  return (
    <td className="border-b border-r border-[color:var(--border-subtle)] text-center">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
    </td>
  )
}
