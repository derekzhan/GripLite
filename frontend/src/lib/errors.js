/**
 * errors.js — canonicalise anything that reaches a `catch` block into a
 * displayable string.
 *
 * Motivation
 * ──────────
 * Wails bridges Go `error` values to the browser with varying shapes:
 *
 *   • real JS `Error`           → has `.message`
 *   • Wails IPC rejection       → `{ name, message }` (Error-like but not instanceof Error)
 *   • bare Go wrapper           → `{ code: N, message: '...' }`
 *   • raw string rejection      → 'connection refused'
 *   • non-string payload        → { some: 'object' }
 *
 * React will happily render strings and numbers, but throws
 * "Objects are not valid as a React child" the instant a plain object
 * gets inlined into JSX — and that throw, raised during render, tears
 * down the whole component tree ("white screen of death").
 *
 * Every `catch (err)` site in the app should go through `normalizeError`
 * before storing the result in state or passing it to `toast.*`.
 */

/**
 * Coerce anything into a user-facing string.  Never returns `undefined`
 * or `null` — callers can safely spread the result into JSX or template
 * literals.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function normalizeError(err) {
  if (err == null) return 'Unknown error'
  if (typeof err === 'string') return err
  if (typeof err === 'number' || typeof err === 'boolean') return String(err)

  if (err instanceof Error) {
    return err.message || err.name || 'Error'
  }

  // Wails / Go structured rejections.
  if (typeof err === 'object') {
    // Common Go error shapes: { message, code, details }.
    if (typeof err.message === 'string' && err.message) return err.message
    if (typeof err.error   === 'string' && err.error)   return err.error
    if (typeof err.reason  === 'string' && err.reason)  return err.reason

    // Fall back to a JSON dump so debugging at least has SOMETHING to
    // read instead of "[object Object]".  Guard against cyclic refs.
    try {
      const s = JSON.stringify(err)
      if (s && s !== '{}') return s
    } catch {
      // circular — fall through
    }
  }

  return String(err)
}

/**
 * Convenience: format an error for the Toast layer.  Appends a short
 * prefix so the user can tell where in the app the error came from
 * (e.g. "Save failed: duplicate column name 'id'").
 *
 * @param {string} prefix   short verb phrase, e.g. "Save failed"
 * @param {unknown} err
 */
export function prefixedError(prefix, err) {
  const msg = normalizeError(err)
  return prefix ? `${prefix}: ${msg}` : msg
}
