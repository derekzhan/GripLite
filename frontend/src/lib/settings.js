/**
 * settings.js — lightweight, localStorage-backed user preferences.
 *
 * These are non-critical UI preferences (same spirit as the existing page-size
 * and theme preferences). Unlike table *usage* data — which lives in
 * griplite.db so it survives reinstalls — a preference reverting to its
 * sensible default after a rare reinstall is harmless, so localStorage is fine.
 *
 * A `storage` argument is injectable so the helpers can be unit-tested without
 * a real browser.
 */

// ─── Database Explorer: how many frequently-used tables to pin to the top ────
export const DEFAULT_TABLE_USAGE_TOP_N = 10
export const MIN_TABLE_USAGE_TOP_N = 0
export const MAX_TABLE_USAGE_TOP_N = 100
const TABLE_USAGE_TOP_N_KEY = 'griplite_table_usage_top_n_v1'

/** Coerce arbitrary input to an integer within [MIN, MAX], else `fallback`. */
export function clampTableUsageTopN(value, fallback = DEFAULT_TABLE_USAGE_TOP_N) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_TABLE_USAGE_TOP_N, Math.max(MIN_TABLE_USAGE_TOP_N, n))
}

/** Read the preferred top-N (defaults to 10 when unset or unparsable). */
export function loadTableUsageTopN(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(TABLE_USAGE_TOP_N_KEY)
    if (raw == null) return DEFAULT_TABLE_USAGE_TOP_N
    return clampTableUsageTopN(raw)
  } catch {
    return DEFAULT_TABLE_USAGE_TOP_N
  }
}

/** Persist and return the clamped top-N. */
export function saveTableUsageTopN(value, storage = globalThis.localStorage) {
  const n = clampTableUsageTopN(value)
  try {
    storage?.setItem(TABLE_USAGE_TOP_N_KEY, String(n))
  } catch {
    /* ignore quota / privacy-mode errors */
  }
  return n
}
