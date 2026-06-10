/**
 * RedisKeyViewer — inspect & edit a single Redis key.
 *
 * Loads the key via redisGetKey() on mount / reload, then renders a
 * type-specific editor (string / hash / list / set / zset / stream).  All
 * values returned by the bridge are base64; we decode for display with
 * decodeRedisB64() and pass PLAIN strings back to the write bridge functions
 * (they re-encode internally).  Write controls are disabled when readOnly.
 */
import { useState, useEffect, useCallback } from 'react'
import {
  RotateCw, Pencil, Trash2, Plus, Save, X, Clock,
} from 'lucide-react'
import {
  redisGetKey, redisSetString, redisDecodeValue,
  redisHashSet, redisHashDelete,
  redisListSet, redisListPush, redisListRemove,
  redisSetAdd, redisSetRemove,
  redisZAdd, redisZRemove,
  redisStreamAdd, redisStreamDelete,
  redisRenameKey, redisDeleteKey, redisSetTTL,
  decodeRedisB64,
} from '../lib/bridge'
import { DECODE_FORMATS, formatTTL } from '../lib/redisClient'
import { normalizeError } from '../lib/errors'
import { toast } from '../lib/toast'
import { formatBytes } from '../utils/formatters'

const TYPE_BADGE = {
  string: 'var(--syntax-keyword)',
  hash:   'var(--success)',
  list:   'var(--accent)',
  set:    'var(--syntax-user)',
  zset:   'var(--syntax-pk)',
  stream: 'var(--syntax-keyword)',
  none:   'var(--fg-muted)',
}

// Small shared button styles so every action reads consistently.
const BTN = 'text-[11px] px-2 py-1 rounded border border-line text-fg-secondary hover:text-fg-primary hover:bg-hover transition-colors select-none disabled:opacity-40 disabled:cursor-not-allowed'
const BTN_PRIMARY = 'text-[11px] px-2.5 py-1 rounded bg-accent text-fg-on-accent hover:bg-accent-hover transition-colors select-none disabled:opacity-40 disabled:cursor-not-allowed'
const INPUT = 'bg-sunken text-fg-primary text-[12px] px-2 py-1 rounded border border-line outline-none focus:border-accent transition-colors'

export default function RedisKeyViewer({ connId, dbIndex = 0, redisKey, connectionKind, readOnly = false }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ttlInput, setTtlInput] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const kv = await redisGetKey(connId, dbIndex, redisKey)
      setData(kv)
      setTtlInput('')
    } catch (err) {
      setError(normalizeError(err))
    } finally {
      setLoading(false)
    }
  }, [connId, dbIndex, redisKey])

  useEffect(() => { reload() }, [reload])

  // Generic write wrapper — runs the mutation then reloads so the view always
  // reflects the server state, surfacing failures via toast.
  const mutate = useCallback(async (fn, successMsg) => {
    if (readOnly) return
    try {
      await fn()
      if (successMsg) toast.success(successMsg)
      await reload()
    } catch (err) {
      toast.error(normalizeError(err))
    }
  }, [readOnly, reload])

  const meta = data?.meta ?? null
  const type = meta?.type ?? 'none'

  const handleRename = useCallback(() => {
    const next = window.prompt('Rename key to:', redisKey)
    if (!next || next === redisKey) return
    mutate(() => redisRenameKey(connId, dbIndex, redisKey, next), `Renamed to ${next}`)
  }, [connId, dbIndex, redisKey, mutate])

  const handleDelete = useCallback(() => {
    if (!window.confirm(`Delete key "${redisKey}"? This cannot be undone.`)) return
    mutate(() => redisDeleteKey(connId, dbIndex, redisKey), `Deleted ${redisKey}`)
  }, [connId, dbIndex, redisKey, mutate])

  const handleSetTTL = useCallback(() => {
    const ttl = parseInt(ttlInput, 10)
    if (!Number.isFinite(ttl) || ttl <= 0) {
      toast.error('Enter a positive number of seconds')
      return
    }
    mutate(() => redisSetTTL(connId, dbIndex, redisKey, ttl), `TTL set to ${ttl}s`)
  }, [connId, dbIndex, redisKey, ttlInput, mutate])

  const handlePersist = useCallback(() => {
    mutate(() => redisSetTTL(connId, dbIndex, redisKey, -1), 'TTL removed (persisted)')
  }, [connId, dbIndex, redisKey, mutate])

  return (
    <div className="flex flex-col h-full bg-app overflow-hidden">
      {/* Header */}
      <div className="flex flex-col gap-2 px-4 py-3 border-b border-line-subtle flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium flex-shrink-0 select-none"
            style={{ color: 'var(--fg-on-accent)', background: TYPE_BADGE[type] ?? 'var(--fg-muted)' }}
          >
            {type}
          </span>
          <span className="text-[13px] font-mono text-fg-primary truncate flex-1 min-w-0" title={redisKey}>
            {redisKey}
          </span>
          {readOnly && (
            <span className="text-[9px] text-warn bg-warn/10 border border-warn/30 rounded px-1 select-none flex-shrink-0">READ ONLY</span>
          )}
          <button className={BTN} onClick={reload} title="Reload">
            <RotateCw size={12} strokeWidth={2} />
          </button>
          <button className={BTN} onClick={handleRename} disabled={readOnly} title="Rename key">
            <Pencil size={12} strokeWidth={2} />
          </button>
          <button
            className="text-[11px] px-2 py-1 rounded border border-danger/40 text-danger hover:bg-danger hover:text-white transition-colors select-none disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleDelete}
            disabled={readOnly}
            title="Delete key"
          >
            <Trash2 size={12} strokeWidth={2} />
          </button>
        </div>

        {meta && type !== 'none' && (
          <div className="flex items-center gap-3 flex-wrap text-[11px] text-fg-muted">
            <span className="flex items-center gap-1">
              <Clock size={11} strokeWidth={2} />
              {formatTTL(meta.ttl)}
            </span>
            <input
              type="number"
              min="1"
              value={ttlInput}
              onChange={(e) => setTtlInput(e.target.value)}
              placeholder="seconds"
              disabled={readOnly}
              className={`${INPUT} w-[90px]`}
            />
            <button className={BTN} onClick={handleSetTTL} disabled={readOnly}>Set TTL</button>
            <button className={BTN} onClick={handlePersist} disabled={readOnly}>Persist</button>
            <span className="ml-auto tabular-nums">
              {formatBytes(meta.sizeBytes) || `${meta.sizeBytes} B`}
              {meta.encoding ? ` · ${meta.encoding}` : ''}
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4">
        {loading && <div className="text-[12px] text-fg-muted">Loading…</div>}
        {!loading && error && <div className="text-[12px] text-danger">{error}</div>}
        {!loading && !error && data && (
          <KeyBody
            type={type}
            data={data}
            readOnly={readOnly}
            connId={connId}
            dbIndex={dbIndex}
            redisKey={redisKey}
            mutate={mutate}
          />
        )}
      </div>
    </div>
  )
}

function KeyBody({ type, data, readOnly, connId, dbIndex, redisKey, mutate }) {
  switch (type) {
    case 'string': return <StringBody data={data} readOnly={readOnly} connId={connId} dbIndex={dbIndex} redisKey={redisKey} mutate={mutate} />
    case 'hash':   return <HashBody   data={data} readOnly={readOnly} connId={connId} dbIndex={dbIndex} redisKey={redisKey} mutate={mutate} />
    case 'list':   return <ListBody   data={data} readOnly={readOnly} connId={connId} dbIndex={dbIndex} redisKey={redisKey} mutate={mutate} />
    case 'set':    return <SetBody    data={data} readOnly={readOnly} connId={connId} dbIndex={dbIndex} redisKey={redisKey} mutate={mutate} />
    case 'zset':   return <ZSetBody   data={data} readOnly={readOnly} connId={connId} dbIndex={dbIndex} redisKey={redisKey} mutate={mutate} />
    case 'stream': return <StreamBody data={data} readOnly={readOnly} connId={connId} dbIndex={dbIndex} redisKey={redisKey} mutate={mutate} />
    default:       return <div className="text-[12px] text-fg-muted italic">Key does not exist</div>
  }
}

// ── string ───────────────────────────────────────────────────────────────────
function StringBody({ data, readOnly, connId, dbIndex, redisKey, mutate }) {
  const [text, setText] = useState(() => decodeRedisB64(data.str ?? ''))
  const [format, setFormat] = useState('text')
  const [decoded, setDecoded] = useState(null)
  const [decodeErr, setDecodeErr] = useState('')

  useEffect(() => { setText(decodeRedisB64(data.str ?? '')) }, [data.str])

  const editable = format === 'text'

  const handleFormatChange = useCallback(async (fmt) => {
    setFormat(fmt)
    setDecodeErr('')
    if (fmt === 'text') { setDecoded(null); return }
    try {
      const res = await redisDecodeValue(data.str ?? '', fmt)
      if (res?.ok) setDecoded(res.text ?? '')
      else { setDecoded(''); setDecodeErr(res?.error || 'decode failed') }
    } catch (err) {
      setDecoded('')
      setDecodeErr(normalizeError(err))
    }
  }, [data.str])

  const handleSave = useCallback(() => {
    mutate(() => redisSetString(connId, dbIndex, redisKey, text), 'Value saved')
  }, [connId, dbIndex, redisKey, text, mutate])

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-fg-muted">View as</span>
        <select
          value={format}
          onChange={(e) => handleFormatChange(e.target.value)}
          className={INPUT}
        >
          {DECODE_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <button className={BTN_PRIMARY} onClick={handleSave} disabled={readOnly || !editable} title={editable ? 'Save value' : 'Switch to Text to edit'}>
          <span className="inline-flex items-center gap-1"><Save size={11} strokeWidth={2} />Save</span>
        </button>
      </div>
      {decodeErr && <div className="text-[11px] text-danger">{decodeErr}</div>}
      <textarea
        value={editable ? text : (decoded ?? '')}
        onChange={(e) => setText(e.target.value)}
        readOnly={readOnly || !editable}
        spellCheck={false}
        className="flex-1 min-h-[200px] bg-sunken text-fg-primary text-[12px] font-mono p-3 rounded border border-line outline-none focus:border-accent transition-colors resize-none"
      />
    </div>
  )
}

// ── hash ───────────────────────────────────────────────────────────────────
function HashBody({ data, readOnly, connId, dbIndex, redisKey, mutate }) {
  const rows = (data.hash ?? []).map((h) => ({ field: decodeRedisB64(h.field), value: decodeRedisB64(h.value) }))
  const [newField, setNewField] = useState('')
  const [newValue, setNewValue] = useState('')

  const addRow = useCallback(() => {
    if (!newField) return
    mutate(() => redisHashSet(connId, dbIndex, redisKey, newField, newValue), `Set field ${newField}`)
    setNewField(''); setNewValue('')
  }, [connId, dbIndex, redisKey, newField, newValue, mutate])

  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-[12px] border border-line rounded overflow-hidden">
        <thead className="bg-sunken text-fg-muted text-[11px]">
          <tr><th className="text-left px-2 py-1 font-medium">Field</th><th className="text-left px-2 py-1 font-medium">Value</th><th className="w-[120px]" /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <HashRow key={r.field} row={r} readOnly={readOnly}
              onSave={(v) => mutate(() => redisHashSet(connId, dbIndex, redisKey, r.field, v), `Updated ${r.field}`)}
              onDelete={() => mutate(() => redisHashDelete(connId, dbIndex, redisKey, r.field), `Deleted ${r.field}`)}
            />
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={3} className="px-2 py-3 text-fg-muted italic text-[11px]">No fields</td></tr>
          )}
        </tbody>
      </table>
      {!readOnly && (
        <div className="flex items-center gap-2">
          <input className={`${INPUT} flex-1`} placeholder="field" value={newField} onChange={(e) => setNewField(e.target.value)} />
          <input className={`${INPUT} flex-1`} placeholder="value" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
          <button className={BTN_PRIMARY} onClick={addRow}><span className="inline-flex items-center gap-1"><Plus size={11} strokeWidth={2} />Add</span></button>
        </div>
      )}
    </div>
  )
}

function HashRow({ row, readOnly, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(row.value)
  useEffect(() => { setVal(row.value) }, [row.value])
  return (
    <tr className="border-t border-line-subtle">
      <td className="px-2 py-1 font-mono text-fg-secondary align-top break-all">{row.field}</td>
      <td className="px-2 py-1 font-mono text-fg-primary align-top break-all">
        {editing
          ? <input className={`${INPUT} w-full`} value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
          : <span>{row.value}</span>}
      </td>
      <td className="px-2 py-1 align-top">
        {!readOnly && (editing ? (
          <div className="flex gap-1">
            <button className={BTN} onClick={() => { onSave(val); setEditing(false) }}><Save size={11} strokeWidth={2} /></button>
            <button className={BTN} onClick={() => { setVal(row.value); setEditing(false) }}><X size={11} strokeWidth={2} /></button>
          </div>
        ) : (
          <div className="flex gap-1">
            <button className={BTN} onClick={() => setEditing(true)}><Pencil size={11} strokeWidth={2} /></button>
            <button className={BTN} onClick={onDelete}><Trash2 size={11} strokeWidth={2} /></button>
          </div>
        ))}
      </td>
    </tr>
  )
}

// ── list ───────────────────────────────────────────────────────────────────
function ListBody({ data, readOnly, connId, dbIndex, redisKey, mutate }) {
  const items = (data.list ?? []).map(decodeRedisB64)
  const [pushVal, setPushVal] = useState('')

  return (
    <div className="flex flex-col gap-2">
      {!readOnly && (
        <div className="flex items-center gap-2">
          <input className={`${INPUT} flex-1`} placeholder="value" value={pushVal} onChange={(e) => setPushVal(e.target.value)} />
          <button className={BTN} onClick={() => { mutate(() => redisListPush(connId, dbIndex, redisKey, pushVal, true), 'Pushed to head'); setPushVal('') }}>Push head</button>
          <button className={BTN} onClick={() => { mutate(() => redisListPush(connId, dbIndex, redisKey, pushVal, false), 'Pushed to tail'); setPushVal('') }}>Push tail</button>
        </div>
      )}
      <table className="w-full text-[12px] border border-line rounded overflow-hidden">
        <thead className="bg-sunken text-fg-muted text-[11px]">
          <tr><th className="text-left px-2 py-1 w-[60px] font-medium">#</th><th className="text-left px-2 py-1 font-medium">Value</th><th className="w-[120px]" /></tr>
        </thead>
        <tbody>
          {items.map((v, i) => (
            <ListRow key={i} index={i} value={v} readOnly={readOnly}
              onSave={(nv) => mutate(() => redisListSet(connId, dbIndex, redisKey, i, nv), `Updated index ${i}`)}
              onDelete={() => mutate(() => redisListRemove(connId, dbIndex, redisKey, 1, v), `Removed value`)}
            />
          ))}
          {items.length === 0 && (
            <tr><td colSpan={3} className="px-2 py-3 text-fg-muted italic text-[11px]">Empty list</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function ListRow({ index, value, readOnly, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(value)
  useEffect(() => { setVal(value) }, [value])
  return (
    <tr className="border-t border-line-subtle">
      <td className="px-2 py-1 tabular-nums text-fg-muted align-top">{index}</td>
      <td className="px-2 py-1 font-mono text-fg-primary align-top break-all">
        {editing
          ? <input className={`${INPUT} w-full`} value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
          : <span>{value}</span>}
      </td>
      <td className="px-2 py-1 align-top">
        {!readOnly && (editing ? (
          <div className="flex gap-1">
            <button className={BTN} onClick={() => { onSave(val); setEditing(false) }}><Save size={11} strokeWidth={2} /></button>
            <button className={BTN} onClick={() => { setVal(value); setEditing(false) }}><X size={11} strokeWidth={2} /></button>
          </div>
        ) : (
          <div className="flex gap-1">
            <button className={BTN} onClick={() => setEditing(true)}><Pencil size={11} strokeWidth={2} /></button>
            <button className={BTN} onClick={onDelete}><Trash2 size={11} strokeWidth={2} /></button>
          </div>
        ))}
      </td>
    </tr>
  )
}

// ── set ───────────────────────────────────────────────────────────────────
function SetBody({ data, readOnly, connId, dbIndex, redisKey, mutate }) {
  const members = (data.set ?? []).map(decodeRedisB64)
  const [newMember, setNewMember] = useState('')
  return (
    <div className="flex flex-col gap-2">
      {!readOnly && (
        <div className="flex items-center gap-2">
          <input className={`${INPUT} flex-1`} placeholder="member" value={newMember} onChange={(e) => setNewMember(e.target.value)} />
          <button className={BTN_PRIMARY} onClick={() => { if (newMember) { mutate(() => redisSetAdd(connId, dbIndex, redisKey, newMember), `Added member`); setNewMember('') } }}>
            <span className="inline-flex items-center gap-1"><Plus size={11} strokeWidth={2} />Add</span>
          </button>
        </div>
      )}
      <table className="w-full text-[12px] border border-line rounded overflow-hidden">
        <thead className="bg-sunken text-fg-muted text-[11px]">
          <tr><th className="text-left px-2 py-1 font-medium">Member</th><th className="w-[60px]" /></tr>
        </thead>
        <tbody>
          {members.map((m, i) => (
            <tr key={i} className="border-t border-line-subtle">
              <td className="px-2 py-1 font-mono text-fg-primary break-all">{m}</td>
              <td className="px-2 py-1">
                {!readOnly && <button className={BTN} onClick={() => mutate(() => redisSetRemove(connId, dbIndex, redisKey, m), 'Removed member')}><Trash2 size={11} strokeWidth={2} /></button>}
              </td>
            </tr>
          ))}
          {members.length === 0 && (
            <tr><td colSpan={2} className="px-2 py-3 text-fg-muted italic text-[11px]">Empty set</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ── zset ───────────────────────────────────────────────────────────────────
function ZSetBody({ data, readOnly, connId, dbIndex, redisKey, mutate }) {
  const rows = (data.zset ?? [])
    .map((z) => ({ member: decodeRedisB64(z.member), score: z.score }))
    .sort((a, b) => a.score - b.score)
  const [newMember, setNewMember] = useState('')
  const [newScore, setNewScore] = useState('')

  const add = useCallback(() => {
    if (!newMember) return
    const score = parseFloat(newScore)
    if (!Number.isFinite(score)) { toast.error('Score must be a number'); return }
    mutate(() => redisZAdd(connId, dbIndex, redisKey, newMember, score), `Added ${newMember}`)
    setNewMember(''); setNewScore('')
  }, [connId, dbIndex, redisKey, newMember, newScore, mutate])

  return (
    <div className="flex flex-col gap-2">
      {!readOnly && (
        <div className="flex items-center gap-2">
          <input className={`${INPUT} flex-1`} placeholder="member" value={newMember} onChange={(e) => setNewMember(e.target.value)} />
          <input className={`${INPUT} w-[120px]`} placeholder="score" type="number" value={newScore} onChange={(e) => setNewScore(e.target.value)} />
          <button className={BTN_PRIMARY} onClick={add}><span className="inline-flex items-center gap-1"><Plus size={11} strokeWidth={2} />Add</span></button>
        </div>
      )}
      <table className="w-full text-[12px] border border-line rounded overflow-hidden">
        <thead className="bg-sunken text-fg-muted text-[11px]">
          <tr><th className="text-left px-2 py-1 w-[120px] font-medium">Score</th><th className="text-left px-2 py-1 font-medium">Member</th><th className="w-[120px]" /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <ZSetRow key={r.member} row={r} readOnly={readOnly}
              onSave={(score) => mutate(() => redisZAdd(connId, dbIndex, redisKey, r.member, score), `Updated ${r.member}`)}
              onDelete={() => mutate(() => redisZRemove(connId, dbIndex, redisKey, r.member), `Removed ${r.member}`)}
            />
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={3} className="px-2 py-3 text-fg-muted italic text-[11px]">Empty sorted set</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function ZSetRow({ row, readOnly, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [score, setScore] = useState(String(row.score))
  useEffect(() => { setScore(String(row.score)) }, [row.score])
  return (
    <tr className="border-t border-line-subtle">
      <td className="px-2 py-1 tabular-nums text-fg-secondary align-top">
        {editing
          ? <input className={`${INPUT} w-full`} type="number" value={score} onChange={(e) => setScore(e.target.value)} autoFocus />
          : <span>{row.score}</span>}
      </td>
      <td className="px-2 py-1 font-mono text-fg-primary align-top break-all">{row.member}</td>
      <td className="px-2 py-1 align-top">
        {!readOnly && (editing ? (
          <div className="flex gap-1">
            <button className={BTN} onClick={() => { const s = parseFloat(score); if (Number.isFinite(s)) { onSave(s); setEditing(false) } else toast.error('Score must be a number') }}><Save size={11} strokeWidth={2} /></button>
            <button className={BTN} onClick={() => { setScore(String(row.score)); setEditing(false) }}><X size={11} strokeWidth={2} /></button>
          </div>
        ) : (
          <div className="flex gap-1">
            <button className={BTN} onClick={() => setEditing(true)}><Pencil size={11} strokeWidth={2} /></button>
            <button className={BTN} onClick={onDelete}><Trash2 size={11} strokeWidth={2} /></button>
          </div>
        ))}
      </td>
    </tr>
  )
}

// ── stream ───────────────────────────────────────────────────────────────────
function StreamBody({ data, readOnly, connId, dbIndex, redisKey, mutate }) {
  const entries = data.stream ?? []
  const [id, setId] = useState('*')
  const [field, setField] = useState('')
  const [value, setValue] = useState('')

  const add = useCallback(() => {
    if (!field) { toast.error('Enter a field name'); return }
    mutate(() => redisStreamAdd(connId, dbIndex, redisKey, id || '*', { [field]: value }), 'Entry added')
    setId('*'); setField(''); setValue('')
  }, [connId, dbIndex, redisKey, id, field, value, mutate])

  return (
    <div className="flex flex-col gap-2">
      {!readOnly && (
        <div className="flex items-center gap-2 flex-wrap">
          <input className={`${INPUT} w-[120px]`} placeholder="ID (*)" value={id} onChange={(e) => setId(e.target.value)} />
          <input className={`${INPUT} flex-1`} placeholder="field" value={field} onChange={(e) => setField(e.target.value)} />
          <input className={`${INPUT} flex-1`} placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />
          <button className={BTN_PRIMARY} onClick={add}><span className="inline-flex items-center gap-1"><Plus size={11} strokeWidth={2} />Add</span></button>
        </div>
      )}
      <table className="w-full text-[12px] border border-line rounded overflow-hidden">
        <thead className="bg-sunken text-fg-muted text-[11px]">
          <tr><th className="text-left px-2 py-1 w-[180px] font-medium">ID</th><th className="text-left px-2 py-1 font-medium">Fields</th><th className="w-[60px]" /></tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-line-subtle">
              <td className="px-2 py-1 font-mono text-fg-secondary align-top break-all">{e.id}</td>
              <td className="px-2 py-1 font-mono text-fg-primary align-top break-all">{JSON.stringify(e.fields ?? {})}</td>
              <td className="px-2 py-1 align-top">
                {!readOnly && <button className={BTN} onClick={() => mutate(() => redisStreamDelete(connId, dbIndex, redisKey, e.id), `Deleted ${e.id}`)}><Trash2 size={11} strokeWidth={2} /></button>}
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr><td colSpan={3} className="px-2 py-3 text-fg-muted italic text-[11px]">Empty stream</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
