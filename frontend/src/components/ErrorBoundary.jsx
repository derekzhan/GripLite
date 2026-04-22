/**
 * ErrorBoundary — catch render-time exceptions and render a fallback UI
 * instead of tearing down the whole React tree (aka "white screen").
 *
 * Intended usage
 * ──────────────
 * Wrap each independent panel so a crash in one tab cannot kill the
 * sidebar / toolbar / other tabs:
 *
 *   <ErrorBoundary label="SQL Console">
 *     <SqlEditor ... />
 *   </ErrorBoundary>
 *
 * The fallback shows:
 *   • a red warning glyph
 *   • a short human-readable message
 *   • a collapsible block with the raw error + stack for debugging
 *   • a "Try again" button (remount children) and a "Reload app" button
 *
 * Note: Error Boundaries only catch errors raised DURING the React
 * render/lifecycle phase.  Errors thrown from async callbacks (promise
 * rejections, setTimeout, event handlers) bypass them — those must be
 * handled by the site-local try/catch + toast pattern.
 */

import { Component } from 'react'
import { normalizeError } from '../lib/errors'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Log to the devtools console — the user can open it to see the
    // full stack trace when reporting bugs.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', this.props.label ?? '<root>', error, info)
    this.setState({ error, info })
  }

  reset = () => this.setState({ error: null, info: null })
  reload = () => {
    if (typeof window !== 'undefined') window.location.reload()
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children

    const msg = normalizeError(error)
    const stack = (info && info.componentStack) || (error && error.stack) || ''

    return (
      <div
        className="h-full w-full flex items-center justify-center p-6 overflow-auto"
        style={{ background: 'var(--bg-app, #1e1e1e)' }}
      >
        <div
          className="w-full max-w-[640px] rounded-md border shadow-xl p-5 text-[13px]"
          style={{
            background:  'var(--bg-panel, #252526)',
            borderColor: 'var(--border-subtle, #3c3c3c)',
            color:       'var(--fg-primary, #d4d4d4)',
          }}
        >
          <div className="flex items-start gap-3 mb-3">
            <span
              aria-hidden
              className="flex items-center justify-center rounded-full text-[16px] font-bold flex-shrink-0"
              style={{
                width: 28, height: 28,
                background: '#3a2a2a', color: '#f48771',
                border: '1px solid #6e3a3a',
              }}
            >
              !
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-[14px] mb-0.5">
                Something went wrong in this component.
              </div>
              <div className="text-[11.5px] opacity-70">
                {this.props.label
                  ? <>The <span className="font-mono">{this.props.label}</span> panel crashed.
                      Other tabs should still work — try reloading just this panel first.</>
                  : 'This panel crashed while rendering.'}
              </div>
            </div>
          </div>

          <div
            className="rounded font-mono text-[11px] p-2 mb-3 overflow-auto max-h-[220px] whitespace-pre-wrap select-text"
            style={{
              background:  'var(--bg-input, #1e1e1e)',
              borderColor: 'var(--border-subtle, #3c3c3c)',
              border:      '1px solid',
              color:       '#f48771',
            }}
          >
            {msg}
            {stack ? `\n\n${stack}` : ''}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={this.reset}
              className="px-3 py-1 rounded text-[12px] font-medium
                         border hover:opacity-90 transition"
              style={{
                background:  'var(--bg-input, #2d2d30)',
                borderColor: 'var(--border-subtle, #3c3c3c)',
                color:       'var(--fg-primary, #d4d4d4)',
              }}
            >
              Try again
            </button>
            <button
              onClick={this.reload}
              className="px-3 py-1 rounded text-[12px] font-medium text-white
                         bg-[#007acc] hover:bg-[#0086d9] transition"
            >
              Reload app
            </button>
            <span className="ml-auto text-[11px] opacity-50">
              Check the DevTools console for the full stack.
            </span>
          </div>
        </div>
      </div>
    )
  }
}
