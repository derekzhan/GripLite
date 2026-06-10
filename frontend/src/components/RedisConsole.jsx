/**
 * RedisConsole — a minimal redis-cli style console.
 *
 * Rendered in place of the SQL/Monaco editor for redis connections.  The user
 * types a command, presses Enter, and the line is sent to redisExecCommand();
 * the command echo + result text (or error) is appended to a scrollback log.
 * Up/Down arrows recall command history.  REDIS_COMMANDS feeds a <datalist>
 * for basic autocomplete.
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { redisExecCommand } from '../lib/bridge'
import { REDIS_COMMANDS } from '../lib/redisClient'
import { normalizeError } from '../lib/errors'

let nextLineId = 1

export default function RedisConsole({ connId, dbIndex = 0, connectionLabel = '' }) {
  const [lines, setLines] = useState([])      // { id, kind: 'cmd'|'out'|'err', text }
  const [input, setInput] = useState('')
  const [history, setHistory] = useState([])
  const [histIdx, setHistIdx] = useState(-1)  // -1 = current (not browsing)
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const append = useCallback((kind, text) => {
    setLines((prev) => [...prev, { id: nextLineId++, kind, text }])
  }, [])

  const submit = useCallback(async () => {
    const raw = input.trim()
    if (!raw || busy) return
    append('cmd', raw)
    setHistory((prev) => (prev[prev.length - 1] === raw ? prev : [...prev, raw]))
    setHistIdx(-1)
    setInput('')
    setBusy(true)
    try {
      const res = await redisExecCommand(connId, dbIndex, raw)
      if (res?.error) append('err', res.error)
      else append('out', res?.text ?? '')
    } catch (err) {
      append('err', normalizeError(err))
    } finally {
      setBusy(false)
    }
  }, [input, busy, append, connId, dbIndex])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHistIdx((cur) => {
        if (history.length === 0) return cur
        const next = cur === -1 ? history.length - 1 : Math.max(0, cur - 1)
        setInput(history[next] ?? '')
        return next
      })
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHistIdx((cur) => {
        if (cur === -1) return -1
        const next = cur + 1
        if (next >= history.length) { setInput(''); return -1 }
        setInput(history[next] ?? '')
        return next
      })
    }
  }, [submit, history])

  return (
    <div className="flex flex-col h-full bg-app" onClick={() => inputRef.current?.focus()}>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-titlebar border-b border-line-subtle flex-shrink-0">
        <span className="text-[11px] text-fg-secondary font-medium select-none">Redis CLI</span>
        {connectionLabel && <span className="text-[11px] text-fg-muted select-none">{connectionLabel}</span>}
        <span className="text-[11px] text-fg-muted select-none">db{dbIndex}</span>
        <button
          onClick={(e) => { e.stopPropagation(); setLines([]) }}
          className="ml-auto text-[11px] px-2 py-0.5 rounded border border-line text-fg-secondary hover:text-fg-primary hover:bg-hover transition-colors select-none"
        >
          Clear
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed">
        {lines.length === 0 && (
          <div className="text-fg-muted select-none">Type a Redis command and press Enter. Try <span className="text-fg-secondary">PING</span>.</div>
        )}
        {lines.map((line) => (
          <div
            key={line.id}
            className={[
              'whitespace-pre-wrap break-all',
              line.kind === 'cmd' ? 'text-accent' : line.kind === 'err' ? 'text-danger' : 'text-fg-primary',
            ].join(' ')}
          >
            {line.kind === 'cmd' ? `> ${line.text}` : line.text}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-t border-line-subtle flex-shrink-0">
        <span className="text-accent font-mono text-[13px] select-none">{'>'}</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          list="redis-command-list"
          placeholder="GET key"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          className="flex-1 bg-sunken text-fg-primary text-[12px] font-mono px-2 py-1 rounded border border-line outline-none focus:border-accent transition-colors disabled:opacity-60"
        />
        <datalist id="redis-command-list">
          {REDIS_COMMANDS.map((c) => <option key={c} value={c} />)}
        </datalist>
      </div>
    </div>
  )
}
