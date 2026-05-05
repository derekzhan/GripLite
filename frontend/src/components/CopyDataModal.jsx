import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowRight, CheckCircle2, Copy, Database, Loader2, Table2, X } from 'lucide-react'
import { cancelCopy, copyDatabase, fetchDatabases, fetchTables, onCopyProgress } from '../lib/bridge'
import {
  buildCopyDatabaseConfig,
  copyProgressPercent,
  DEFAULT_COPY_BATCH_SIZE,
  tableNamesForCopySelection,
} from '../lib/copyData'
import { normalizeError } from '../lib/errors'

export default function CopyDataModal({ isOpen, source, connections = [], onClose }) {
  const connectedConnections = useMemo(
    () => connections.filter((conn) => conn.connected),
    [connections],
  )

  const sourceConn = connectedConnections.find((conn) => conn.id === source?.connId)
    ?? connections.find((conn) => conn.id === source?.connId)
    ?? null

  const [targetConnId, setTargetConnId] = useState('')
  const [targetDbs, setTargetDbs] = useState([])
  const [targetDb, setTargetDb] = useState('')
  const [loadingDbs, setLoadingDbs] = useState(false)
  const [dbError, setDbError] = useState('')
  const [sourceTables, setSourceTables] = useState([])
  const [selectedTables, setSelectedTables] = useState([])
  const [loadingTables, setLoadingTables] = useState(false)
  const [tableError, setTableError] = useState('')
  const [copyStructure, setCopyStructure] = useState(true)
  const [copyData, setCopyData] = useState(true)
  const [dropTargetIfExists, setDropTargetIfExists] = useState(false)
  const [batchSize, setBatchSize] = useState(DEFAULT_COPY_BATCH_SIZE)
  const [phase, setPhase] = useState('form')
  const [progress, setProgress] = useState({ status: '', processedRows: 0, totalRows: 0 })
  const [error, setError] = useState('')
  const [cancelRequested, setCancelRequested] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    const firstTarget = connectedConnections[0]?.id ?? ''
    setTargetConnId(firstTarget)
    setTargetDb(source?.dbName ?? '')
    setSourceTables([])
    setSelectedTables([])
    setTableError('')
    setCopyStructure(true)
    setCopyData(true)
    setDropTargetIfExists(false)
    setBatchSize(DEFAULT_COPY_BATCH_SIZE)
    setPhase('form')
    setProgress({ status: '', processedRows: 0, totalRows: 0 })
    setError('')
    setCancelRequested(false)
  }, [isOpen, source?.dbName, connectedConnections])

  useEffect(() => {
    if (!isOpen || !source?.connId || !source?.dbName) return
    let cancelled = false
    setLoadingTables(true)
    setTableError('')
    fetchTables(source.connId, source.dbName)
      .then((tables) => {
        if (cancelled) return
        const names = tableNamesForCopySelection(tables)
        setSourceTables(names)
        setSelectedTables(names)
      })
      .catch((err) => {
        if (!cancelled) {
          setSourceTables([])
          setSelectedTables([])
          setTableError(normalizeError(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingTables(false)
      })
    return () => { cancelled = true }
  }, [isOpen, source?.connId, source?.dbName])

  useEffect(() => {
    if (!isOpen || !targetConnId) return
    let cancelled = false
    setLoadingDbs(true)
    setDbError('')
    fetchDatabases(targetConnId)
      .then((dbs) => {
        if (cancelled) return
        const list = dbs ?? []
        setTargetDbs(list)
        setTargetDb((cur) => list.includes(cur) ? cur : (list.includes(source?.dbName) ? source.dbName : list[0] ?? ''))
      })
      .catch((err) => {
        if (!cancelled) setDbError(normalizeError(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingDbs(false)
      })
    return () => { cancelled = true }
  }, [isOpen, targetConnId, source?.dbName])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape' && phase !== 'copying') onClose?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose, phase])

  if (!isOpen || !source) return null

  const targetConn = connections.find((conn) => conn.id === targetConnId) ?? null
  const percent = copyProgressPercent(progress)
  const selectedTableSet = new Set(selectedTables)
  const allTablesSelected = sourceTables.length > 0 && selectedTables.length === sourceTables.length
  const canStart = !!source.connId && !!source.dbName && !!targetConnId && !!targetDb
    && (copyStructure || copyData) && !loadingTables && !tableError && selectedTables.length > 0

  const toggleTable = (tableName) => {
    setSelectedTables((prev) => (
      prev.includes(tableName)
        ? prev.filter((name) => name !== tableName)
        : [...prev, tableName]
    ))
  }

  const toggleAllTables = () => {
    setSelectedTables(allTablesSelected ? [] : sourceTables)
  }

  const startCopy = async () => {
    setPhase('copying')
    setError('')
    setCancelRequested(false)
    setProgress({ status: 'Preparing copy job...', processedRows: 0, totalRows: 0 })
    let unsubscribe = null
    try {
      unsubscribe = await onCopyProgress((payload) => {
        setProgress({
          status: payload?.status ?? '',
          processedRows: payload?.processedRows ?? 0,
          totalRows: payload?.totalRows ?? 0,
        })
      })
      const result = await copyDatabase(buildCopyDatabaseConfig({
        source: { connId: source.connId, dbName: source.dbName },
        target: { connId: targetConnId, dbName: targetDb },
        copyStructure,
        copyData,
        dropTargetIfExists,
        batchSize,
        tables: selectedTables,
      }))
      if (result?.error) throw new Error(result.error)
      if (result && result.success === false) throw new Error('Copy failed')
      setPhase('done')
    } catch (err) {
      if (cancelRequested || isCancelError(err)) {
        setError('')
        setProgress((prev) => ({ ...prev, status: 'Copy cancelled' }))
        setPhase('cancelled')
      } else {
        setError(normalizeError(err))
        setPhase('error')
      }
    } finally {
      unsubscribe?.()
    }
  }

  const requestCancel = async () => {
    setCancelRequested(true)
    setProgress((prev) => ({ ...prev, status: 'Cancelling copy...' }))
    try { await cancelCopy() } catch { /* copy may have already finished */ }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center overlay-enter"
      style={{ background: 'var(--bg-overlay)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && phase !== 'copying') onClose?.() }}
    >
      <div
        className="modal-enter w-[520px] max-w-[94vw] rounded-lg overflow-hidden bg-[color:var(--card-bg)] border border-[color:var(--border-strong)]"
        style={{ boxShadow: 'var(--card-shadow)' }}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[color:var(--border-subtle)]">
          <div className="w-9 h-9 rounded-lg bg-[color:var(--accent)] text-[color:var(--fg-on-accent)] flex items-center justify-center">
            <Copy size={17} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold text-[color:var(--fg-primary)]">Copy Data To...</h2>
            <p className="text-[11px] text-[color:var(--fg-muted)]">Copy database tables and data</p>
          </div>
          <button
            onClick={onClose}
            disabled={phase === 'copying'}
            className="w-7 h-7 rounded flex items-center justify-center text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)] hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
            title="Close"
          >
            <X size={15} />
          </button>
        </div>

        {phase === 'form' ? (
          <div className="px-5 py-4 space-y-4">
            <SectionTitle icon={Database} text="Source" />
            <div className="rounded-md border border-[color:var(--border-subtle)] bg-black/[0.02] dark:bg-white/[0.02] p-3 text-[12px]">
              <InfoLine label="Connection" value={labelForConnection(sourceConn, source.connId)} />
              <InfoLine label="Database" value={source.dbName} mono />
            </div>

            <SectionTitle icon={ArrowRight} text="Target" />
            <div className="grid grid-cols-[128px_1fr] gap-3 items-center text-[12px]">
              <label className="text-[color:var(--fg-muted)]">Connection</label>
              <select
                value={targetConnId}
                onChange={(e) => setTargetConnId(e.target.value)}
                className="bg-[color:var(--bg-elev-2)] text-[color:var(--fg-primary)] border border-[color:var(--border-strong)] rounded px-2 py-1.5 outline-none focus:border-[color:var(--accent)]"
              >
                {connectedConnections.map((conn) => (
                  <option key={conn.id} value={conn.id}>{labelForConnection(conn, conn.id)}</option>
                ))}
              </select>

              <label className="text-[color:var(--fg-muted)]">Database</label>
              <div className="flex items-center gap-2">
                <select
                  value={targetDb}
                  onChange={(e) => setTargetDb(e.target.value)}
                  disabled={loadingDbs || targetDbs.length === 0}
                  className="flex-1 bg-[color:var(--bg-elev-2)] text-[color:var(--fg-primary)] border border-[color:var(--border-strong)] rounded px-2 py-1.5 outline-none focus:border-[color:var(--accent)] disabled:opacity-60"
                >
                  {targetDbs.map((db) => <option key={db} value={db}>{db}</option>)}
                </select>
                {loadingDbs && <Loader2 size={14} className="animate-spin text-[color:var(--fg-muted)]" />}
              </div>
            </div>

            {dbError && <InlineError message={`Failed to load target databases: ${dbError}`} />}

            <SectionTitle icon={Table2} text="Tables" />
            <div className="rounded-md border border-[color:var(--border-subtle)] overflow-hidden text-[12px]">
              <div className="flex items-center justify-between gap-3 px-3 py-2 bg-black/[0.02] dark:bg-white/[0.02] border-b border-[color:var(--border-subtle)]">
                <label className="flex items-center gap-2 text-[color:var(--fg-secondary)]">
                  <input
                    type="checkbox"
                    checked={allTablesSelected}
                    disabled={loadingTables || sourceTables.length === 0}
                    onChange={toggleAllTables}
                  />
                  <span>Select all tables</span>
                </label>
                <span className="text-[color:var(--fg-muted)] tabular-nums">
                  {loadingTables ? 'Loading...' : `${selectedTables.length} / ${sourceTables.length} selected`}
                </span>
              </div>
              <div className="max-h-40 overflow-y-auto p-2 space-y-1">
                {loadingTables ? (
                  <div className="flex items-center gap-2 px-1 py-2 text-[color:var(--fg-muted)]">
                    <Loader2 size={14} className="animate-spin" />
                    <span>Loading source tables...</span>
                  </div>
                ) : sourceTables.length === 0 ? (
                  <div className="px-1 py-2 text-[color:var(--fg-muted)]">
                    No tables found in source database.
                  </div>
                ) : (
                  sourceTables.map((tableName) => (
                    <label key={tableName} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-black/5 dark:hover:bg-white/10 text-[color:var(--fg-secondary)]">
                      <input
                        type="checkbox"
                        checked={selectedTableSet.has(tableName)}
                        onChange={() => toggleTable(tableName)}
                      />
                      <span className="font-mono text-[color:var(--fg-primary)] truncate" title={tableName}>{tableName}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
            {tableError && <InlineError message={`Failed to load source tables: ${tableError}`} />}

            <SectionTitle icon={Copy} text="Options" />
            <div className="space-y-2 text-[12px]">
              <CheckRow checked={copyStructure} onChange={setCopyStructure} label="Copy Structure (DDL)" />
              <CheckRow checked={copyData} onChange={setCopyData} label="Copy Data" />
              <div className="pt-1 space-y-1.5">
                <div className="text-[color:var(--fg-muted)]">If target table exists</div>
                <label className="flex items-center gap-2 text-[color:var(--fg-secondary)]">
                  <input
                    type="radio"
                    name="existing-table-action"
                    checked={!dropTargetIfExists}
                    onChange={() => setDropTargetIfExists(false)}
                  />
                  <span>Skip existing table</span>
                </label>
                <label className="flex items-center gap-2 text-[color:var(--fg-secondary)]">
                  <input
                    type="radio"
                    name="existing-table-action"
                    checked={dropTargetIfExists}
                    onChange={() => setDropTargetIfExists(true)}
                  />
                  <span>Delete target table and copy again</span>
                </label>
              </div>
              <label className="flex items-center gap-3 pt-1">
                <span className="w-[128px] text-[color:var(--fg-muted)]">Batch size</span>
                <input
                  type="number"
                  min="1"
                  value={batchSize}
                  onChange={(e) => setBatchSize(e.target.value)}
                  className="w-28 bg-[color:var(--bg-elev-2)] text-[color:var(--fg-primary)] border border-[color:var(--border-strong)] rounded px-2 py-1 outline-none focus:border-[color:var(--accent)]"
                />
              </label>
            </div>
          </div>
        ) : (
          <ProgressView phase={phase} progress={progress} percent={percent} error={error} />
        )}

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[color:var(--border-subtle)] bg-black/[0.02] dark:bg-white/[0.02]">
          {phase === 'form' ? (
            <>
              <button onClick={onClose} className="px-3 py-1.5 rounded text-[12px] text-[color:var(--fg-secondary)] hover:bg-black/5 dark:hover:bg-white/10">
                Cancel
              </button>
              <button
                onClick={startCopy}
                disabled={!canStart}
                className="px-4 py-1.5 rounded text-[12px] font-medium bg-[color:var(--accent)] text-[color:var(--fg-on-accent)] hover:bg-[color:var(--accent-hover)] disabled:opacity-50"
              >
                Start Copy
              </button>
            </>
          ) : phase === 'copying' ? (
            <button
              onClick={requestCancel}
              disabled={cancelRequested}
              className="px-4 py-1.5 rounded text-[12px] font-medium border border-red-500 text-red-500 hover:bg-red-500 hover:text-white disabled:opacity-50"
            >
              {cancelRequested ? 'Cancelling...' : 'Cancel'}
            </button>
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded text-[12px] font-medium bg-[color:var(--accent)] text-[color:var(--fg-on-accent)] hover:bg-[color:var(--accent-hover)] disabled:opacity-50"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function labelForConnection(conn, fallback) {
  if (!conn) return fallback ?? ''
  return conn.name || `${conn.host}:${conn.port}`
}

function SectionTitle({ icon: Icon, text }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
      <Icon size={13} />
      <span>{text}</span>
    </div>
  )
}

function InfoLine({ label, value, mono = false }) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-3 py-0.5">
      <span className="text-[color:var(--fg-muted)]">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} text-[color:var(--fg-primary)] truncate`} title={value}>{value || '-'}</span>
    </div>
  )
}

function CheckRow({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 text-[color:var(--fg-secondary)]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

function InlineError({ message }) {
  return (
    <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-500">
      <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
      <span>{message}</span>
    </div>
  )
}

function isCancelError(err) {
  const text = String(err?.message ?? err ?? '').toLowerCase()
  return text.includes('context canceled') || text.includes('cancelled') || text.includes('canceled')
}

function ProgressView({ phase, progress, percent, error }) {
  const isDone = phase === 'done'
  const isError = phase === 'error'
  const isCancelled = phase === 'cancelled'
  return (
    <div className="px-6 py-8">
      <div className="flex flex-col items-center text-center gap-4">
        {isDone ? (
          <CheckCircle2 size={36} className="text-[color:var(--success)]" />
        ) : isCancelled ? (
          <AlertCircle size={36} className="text-[color:var(--fg-muted)]" />
        ) : isError ? (
          <AlertCircle size={36} className="text-red-500" />
        ) : (
          <Loader2 size={36} className="animate-spin text-[color:var(--accent)]" />
        )}
        <div>
          <div className="text-[15px] font-semibold text-[color:var(--fg-primary)]">
            {isDone ? 'Copy complete' : isCancelled ? 'Copy cancelled' : isError ? 'Copy failed' : 'Copying database...'}
          </div>
          <div className="text-[12px] text-[color:var(--fg-muted)] mt-1">
            {error || progress.status || 'Waiting for progress...'}
          </div>
        </div>
        <div className="w-full">
          <div className="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
            <div
              className="h-full bg-[color:var(--accent)] transition-all duration-200"
              style={{ width: `${isDone ? 100 : percent}%` }}
            />
          </div>
          <div className="mt-2 text-[11px] text-[color:var(--fg-muted)] tabular-nums">
            {progress.processedRows ?? 0} / {progress.totalRows ?? 0} rows
          </div>
        </div>
      </div>
    </div>
  )
}
