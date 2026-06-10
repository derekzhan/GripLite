/**
 * RedisServerView — server-level dashboard for a Redis connection.
 *
 *   • INFO sections (Server / Clients / Memory / Stats / Keyspace …) as cards.
 *   • Pub/Sub panel: subscribe to a channel and watch a live message log.
 *   • Slow log: recent slow commands.
 *   • Client list: raw CLIENT LIST lines.
 *
 * The pub/sub subscription is torn down on unmount and whenever the user
 * unsubscribes so we never leak a Wails event listener.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { RotateCw } from 'lucide-react'
import {
  redisServerInfo, redisSlowLog, redisClientList,
  redisSubscribe, redisUnsubscribe, onRedisMessage,
} from '../lib/bridge'
import { normalizeError } from '../lib/errors'
import { toast } from '../lib/toast'

// Preferred INFO section order; any extra sections are appended afterwards.
const PREFERRED_SECTIONS = ['Server', 'Clients', 'Memory', 'Stats', 'Keyspace']

const BTN = 'text-[11px] px-2 py-1 rounded border border-line text-fg-secondary hover:text-fg-primary hover:bg-hover transition-colors select-none disabled:opacity-40 disabled:cursor-not-allowed'
const INPUT = 'bg-sunken text-fg-primary text-[12px] px-2 py-1 rounded border border-line outline-none focus:border-accent transition-colors'

export default function RedisServerView({ connId }) {
  const [info, setInfo] = useState(null)
  const [slowLog, setSlowLog] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [infoRes, slowRes, clientRes] = await Promise.all([
        redisServerInfo(connId),
        redisSlowLog(connId).catch(() => []),
        redisClientList(connId).catch(() => []),
      ])
      setInfo(infoRes ?? {})
      setSlowLog(slowRes ?? [])
      setClients(clientRes ?? [])
    } catch (err) {
      setError(normalizeError(err))
    } finally {
      setLoading(false)
    }
  }, [connId])

  useEffect(() => { load() }, [load])

  const sections = orderSections(info)

  return (
    <div className="flex flex-col h-full bg-app overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-line-subtle flex-shrink-0">
        <span className="text-[13px] font-semibold text-fg-primary">Redis Server</span>
        <button className={`${BTN} ml-auto`} onClick={load} title="Reload">
          <span className="inline-flex items-center gap-1"><RotateCw size={12} strokeWidth={2} />Reload</span>
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
        {loading && <div className="text-[12px] text-fg-muted">Loading…</div>}
        {!loading && error && <div className="text-[12px] text-danger">{error}</div>}

        {!loading && !error && (
          <>
            {/* INFO cards */}
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
              {sections.map(([name, fields]) => (
                <div key={name} className="border border-line rounded bg-sunken overflow-hidden">
                  <div className="px-3 py-1.5 bg-elevated border-b border-line-subtle text-[11px] uppercase tracking-wide text-fg-secondary font-medium">
                    {name}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1">
                    {Object.entries(fields ?? {}).map(([k, v]) => (
                      <div key={k} className="flex items-baseline justify-between gap-3 text-[12px]">
                        <span className="text-fg-muted font-mono truncate" title={k}>{k}</span>
                        <span className="text-fg-primary font-mono text-right truncate" title={String(v)}>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {sections.length === 0 && <div className="text-[12px] text-fg-muted">No INFO returned</div>}
            </div>

            <PubSubPanel connId={connId} />

            {/* Slow log */}
            <Panel title="Slow Log">
              <table className="w-full text-[12px] border border-line rounded overflow-hidden">
                <thead className="bg-sunken text-fg-muted text-[11px]">
                  <tr>
                    <th className="text-left px-2 py-1 w-[60px] font-medium">ID</th>
                    <th className="text-left px-2 py-1 w-[150px] font-medium">Time</th>
                    <th className="text-left px-2 py-1 w-[110px] font-medium">Duration (µs)</th>
                    <th className="text-left px-2 py-1 font-medium">Command</th>
                  </tr>
                </thead>
                <tbody>
                  {slowLog.map((row) => (
                    <tr key={row.id} className="border-t border-line-subtle">
                      <td className="px-2 py-1 tabular-nums text-fg-muted">{row.id}</td>
                      <td className="px-2 py-1 text-fg-secondary">{formatUnixTime(row.time)}</td>
                      <td className="px-2 py-1 tabular-nums text-fg-secondary">{row.duration}</td>
                      <td className="px-2 py-1 font-mono text-fg-primary break-all">{(row.args ?? []).join(' ')}</td>
                    </tr>
                  ))}
                  {slowLog.length === 0 && (
                    <tr><td colSpan={4} className="px-2 py-3 text-fg-muted italic text-[11px]">No slow log entries</td></tr>
                  )}
                </tbody>
              </table>
            </Panel>

            {/* Client list */}
            <Panel title="Clients">
              <div className="border border-line rounded bg-sunken p-2 font-mono text-[11px] flex flex-col gap-1 max-h-[200px] overflow-auto">
                {clients.map((line, i) => (
                  <div key={i} className="text-fg-secondary break-all">{line}</div>
                ))}
                {clients.length === 0 && <div className="text-fg-muted italic">No clients</div>}
              </div>
            </Panel>
          </>
        )}
      </div>
    </div>
  )
}

function Panel({ title, children }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] uppercase tracking-wide text-fg-secondary font-medium">{title}</div>
      {children}
    </div>
  )
}

function PubSubPanel({ connId }) {
  const [channel, setChannel] = useState('')
  const [subbed, setSubbed] = useState(false)
  const [messages, setMessages] = useState([])
  const subRef = useRef(null)       // { subID, unsub }
  const logRef = useRef(null)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const cleanup = useCallback(async () => {
    const cur = subRef.current
    subRef.current = null
    if (cur) {
      try { cur.unsub?.() } catch { /* ignore */ }
      try { await redisUnsubscribe(cur.subID) } catch { /* ignore */ }
    }
  }, [])

  // Tear the subscription down on unmount so we never leak the event listener.
  useEffect(() => () => { cleanup() }, [cleanup])

  const subscribe = useCallback(async () => {
    const ch = channel.trim()
    if (!ch || subbed) return
    try {
      const subID = await redisSubscribe(connId, [ch], [])
      const unsub = await onRedisMessage(subID, (msg) => {
        setMessages((prev) => [...prev, formatMessage(msg)])
      })
      subRef.current = { subID, unsub }
      setSubbed(true)
      setMessages((prev) => [...prev, `— subscribed to ${ch} —`])
    } catch (err) {
      toast.error(normalizeError(err))
    }
  }, [channel, subbed, connId])

  const unsubscribe = useCallback(async () => {
    await cleanup()
    setSubbed(false)
    setMessages((prev) => [...prev, '— unsubscribed —'])
  }, [cleanup])

  return (
    <Panel title="Pub/Sub">
      <div className="flex items-center gap-2">
        <input
          className={`${INPUT} flex-1`}
          placeholder="channel"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          disabled={subbed}
        />
        {subbed
          ? <button className={BTN} onClick={unsubscribe}>Unsubscribe</button>
          : <button className={BTN} onClick={subscribe} disabled={!channel.trim()}>Subscribe</button>}
        <button className={BTN} onClick={() => setMessages([])}>Clear</button>
      </div>
      <div ref={logRef} className="border border-line rounded bg-sunken p-2 font-mono text-[11px] flex flex-col gap-0.5 h-[160px] overflow-auto">
        {messages.length === 0
          ? <div className="text-fg-muted italic">No messages</div>
          : messages.map((m, i) => <div key={i} className="text-fg-primary break-all whitespace-pre-wrap">{m}</div>)}
      </div>
    </Panel>
  )
}

// ── helpers ────────────────────────────────────────────────────────────────
function orderSections(info) {
  if (!info) return []
  const entries = Object.entries(info)
  const known = PREFERRED_SECTIONS
    .filter((name) => info[name])
    .map((name) => [name, info[name]])
  const extra = entries.filter(([name]) => !PREFERRED_SECTIONS.includes(name))
  return [...known, ...extra]
}

function formatUnixTime(sec) {
  if (!sec) return ''
  try { return new Date(sec * 1000).toLocaleString() } catch { return String(sec) }
}

function formatMessage(msg) {
  if (msg == null) return ''
  if (typeof msg === 'string') return msg
  // Common shapes: { channel, payload } or { channel, pattern, payload }
  if (typeof msg === 'object') {
    const ch = msg.channel ?? msg.Channel ?? ''
    const payload = msg.payload ?? msg.Payload ?? msg.data ?? ''
    if (ch || payload) return `${ch ? `[${ch}] ` : ''}${payload}`
    try { return JSON.stringify(msg) } catch { return String(msg) }
  }
  return String(msg)
}
