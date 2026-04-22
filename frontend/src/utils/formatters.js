/**
 * formatters.js — generic display-formatting utilities for GripLite.
 *
 * All functions are pure and side-effect-free so they can be used safely
 * in both React render paths and utility contexts.
 */

// ─────────────────────────────────────────────────────────────────────────────
// formatBytes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a raw byte count into a compact, human-readable string.
 *
 * The output mirrors the ultra-minimal DataGrip / IntelliJ style:
 *
 *   formatBytes(0)            → "0 B"
 *   formatBytes(512)          → "512 B"
 *   formatBytes(1024)         → "1 K"
 *   formatBytes(32_768)       → "32 K"
 *   formatBytes(1_572_864)    → "1.5 M"
 *   formatBytes(1_500_000)    → "1.4 M"
 *   formatBytes(1_073_741_824) → "1 G"
 *   formatBytes(-1)           → null   (not available — caller should hide the badge)
 *   formatBytes(null)         → null
 *
 * Rules:
 *   - Returns null for any negative value or non-finite / non-numeric input
 *     so callers can conditionally omit the badge with a simple null check.
 *   - Uses 1 decimal place when the rounded value has a fractional part
 *     that is non-zero; otherwise shows an integer (e.g. "32 K" not "32.0 K").
 *   - Unit thresholds are powers of 1024 (kibibytes), matching most DB tools.
 *
 * @param {number | null | undefined} bytes   raw byte count
 * @returns {string | null}
 */
export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null

  const B  = 1
  const K  = 1_024
  const M  = 1_024 * K
  const G  = 1_024 * M
  const T  = 1_024 * G

  let value, unit
  if (bytes < K) {
    return `${bytes} B`               // sub-kibibyte: always show raw
  } else if (bytes < M) {
    value = bytes / K;  unit = 'K'
  } else if (bytes < G) {
    value = bytes / M;  unit = 'M'
  } else if (bytes < T) {
    value = bytes / G;  unit = 'G'
  } else {
    value = bytes / T;  unit = 'T'
  }

  // Show one decimal only when the rounded-to-1dp value has a non-zero
  // fractional part, keeping the output as terse as possible.
  const rounded = Math.round(value * 10) / 10
  const str = rounded % 1 === 0 ? String(Math.round(rounded)) : rounded.toFixed(1)
  return `${str} ${unit}`
}

// ─────────────────────────────────────────────────────────────────────────────
// formatRowCount  (bonus: compact row-count badge used alongside size)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a row count into a compact string.
 *
 *   formatRowCount(0)         → "0"
 *   formatRowCount(999)       → "999"
 *   formatRowCount(1000)      → "1 K"
 *   formatRowCount(1_500_000) → "1.5 M"
 *   formatRowCount(-1)        → null   (not available)
 *
 * @param {number | null | undefined} count
 * @returns {string | null}
 */
export function formatRowCount(count) {
  if (count == null || !Number.isFinite(count) || count < 0) return null
  if (count < 1_000)   return String(count)
  if (count < 1_000_000) {
    const v = count / 1_000
    return `${v % 1 === 0 ? Math.round(v) : (Math.round(v * 10) / 10).toFixed(1)} K`
  }
  const v = count / 1_000_000
  return `${v % 1 === 0 ? Math.round(v) : (Math.round(v * 10) / 10).toFixed(1)} M`
}
