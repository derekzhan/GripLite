/**
 * sqlSplit.js — tolerant SQL statement splitter.
 *
 * Used by the SQL Console to implement DBeaver-style "Run current" vs
 * "Run all" behaviours on top of a driver (go-sql-driver/mysql) that does
 * NOT allow multi-statement queries by default.
 *
 * Requirements
 * ────────────
 *   • Split on `;`   — BUT only when outside of strings and comments.
 *   • Preserve:      — single-quoted  'abc;def'
 *                    — double-quoted  "abc;def"        (some dialects)
 *                    — backtick ident `foo;bar`        (MySQL)
 *                    — line comments  -- rest of line
 *                    — block comments /* ... *\/       (nestable = no in MySQL)
 *   • Understand backslash / doubled-quote escapes INSIDE string literals.
 *   • Skip whitespace-only / comment-only "empty" statements.
 *   • Return original offsets so callers can map the cursor back to the
 *     Monaco buffer (needed by findStatementAt).
 *
 * Non-goals
 * ─────────
 *   • Full SQL parsing — this is a pragmatic tokeniser.  Edge cases like
 *     DELIMITER switching (used in routine creation) are out of scope and
 *     will fall back to a single-statement split.  Users can always paste
 *     the CREATE PROCEDURE body into a single session if needed.
 *
 * @typedef {{sql: string, startOffset: number, endOffset: number}} Statement
 */

/**
 * splitSql — tokenise `text` and return each non-empty statement.
 *
 * Whitespace / comments around the body are trimmed in the returned `sql`
 * but `startOffset` / `endOffset` still reference the original text so the
 * editor can highlight / scroll to the correct range.
 *
 * @param {string} text
 * @returns {Statement[]}
 */
export function splitSql(text) {
  if (!text) return []

  const out = []
  const n   = text.length
  let i     = 0
  let start = 0  // start of the current statement

  while (i < n) {
    const ch = text[i]
    const next = i + 1 < n ? text[i + 1] : ''

    // ── Line comment: --... or #... (MySQL supports both) ───────────────
    if ((ch === '-' && next === '-') || ch === '#') {
      while (i < n && text[i] !== '\n') i++
      continue
    }

    // ── Block comment: /* ... */ (MySQL is non-nested) ──────────────────
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      if (i < n) i += 2   // skip closing */
      continue
    }

    // ── String literals ────────────────────────────────────────────────
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < n) {
        const c = text[i]
        // Backslash escape (MySQL default — NO_BACKSLASH_ESCAPES ignored).
        if (c === '\\' && i + 1 < n) { i += 2; continue }
        // Doubled quote = literal quote.
        if (c === quote && text[i + 1] === quote) { i += 2; continue }
        if (c === quote) { i++; break }
        i++
      }
      continue
    }

    // ── Statement terminator ───────────────────────────────────────────
    if (ch === ';') {
      pushSegment(text, start, i, out)
      i++
      start = i
      continue
    }

    i++
  }

  // Trailing segment without a closing ; — still counts as a statement.
  if (start < n) pushSegment(text, start, n, out)

  return out
}

function pushSegment(text, startOffset, endOffset, out) {
  const raw = text.slice(startOffset, endOffset)
  if (!hasExecutableContent(raw)) return
  out.push({
    sql:         raw.trim(),
    startOffset,
    endOffset,
  })
}

/**
 * hasExecutableContent — returns true if the segment contains anything
 * other than whitespace / line comments / block comments.  Used to skip
 * "empty" statements produced by e.g. trailing `;` or comment-only blocks.
 */
function hasExecutableContent(s) {
  if (!s.trim()) return false

  const n = s.length
  let i = 0

  while (i < n) {
    const ch = s[i]
    const next = i + 1 < n ? s[i + 1] : ''

    if ((ch === '-' && next === '-') || ch === '#') {
      while (i < n && s[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++
      if (i < n) i += 2
      continue
    }
    if (/\s/.test(ch)) { i++; continue }

    // Found a non-whitespace, non-comment character → has content.
    return true
  }
  return false
}

/**
 * findStatementAt — return the statement whose range covers `offset`.
 *
 * If the cursor is in a gap (e.g. blank line between two statements), we
 * prefer the NEXT statement (the one the user is about to edit / run),
 * falling back to the PREVIOUS one when no next exists.  When the text
 * has no executable content, returns null.
 *
 * @param {string} text
 * @param {number} offset  0-based character index of the cursor
 * @returns {Statement|null}
 */
export function findStatementAt(text, offset) {
  const stmts = splitSql(text)
  if (stmts.length === 0) return null
  if (stmts.length === 1) return stmts[0]

  // Exact hit: cursor inside [start, end].
  for (const s of stmts) {
    if (offset >= s.startOffset && offset <= s.endOffset) return s
  }

  // Cursor is past all statements → run the last one.
  if (offset >= stmts[stmts.length - 1].endOffset) {
    return stmts[stmts.length - 1]
  }

  // Cursor before first: run the first.
  return stmts[0]
}
