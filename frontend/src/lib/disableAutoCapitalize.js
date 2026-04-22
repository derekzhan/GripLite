/**
 * Disables macOS / browser auto-capitalization, auto-correct, spellcheck,
 * and the mobile predictive-text bar globally — for a DB-client app these
 * behaviours are actively harmful (typing "demo" becomes "Demo", "utf8mb4"
 * becomes "Utf8mb4", SQL keywords get red-underlined, etc.).
 *
 * Strategy
 * ────────
 * There is no CSS property that disables autocorrect/capitalize reliably
 * across Chromium / WebKit.  The only portable switch is the HTML-attribute
 * set: `autocomplete="off" autocapitalize="off" autocorrect="off"
 * spellcheck="false"` plus `data-gramm="false"` to silence Grammarly if it
 * is installed as a browser extension.
 *
 * Rather than decorating every single <input> / <textarea> by hand we run
 * a one-time sweep on DOMContentLoaded and a lightweight MutationObserver
 * to cover inputs mounted later (React trees, modals, popovers).  Inputs
 * whose type is `password` / `email` / `url` / `tel` / `search` are
 * deliberately left alone — the user may still want browser autofill for
 * those.
 */

const EXCLUDED_TYPES = new Set(['password', 'email', 'url', 'tel', 'number'])

function patchInput(el) {
  if (!el || el.nodeType !== 1) return
  const tag = el.tagName
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return

  // Mark so we don't reprocess the same node on every mutation burst.
  if (el.dataset.acNormalized === '1') return
  el.dataset.acNormalized = '1'

  if (tag === 'INPUT') {
    const t = (el.getAttribute('type') || 'text').toLowerCase()
    if (EXCLUDED_TYPES.has(t)) return
  }

  if (!el.hasAttribute('autocapitalize')) el.setAttribute('autocapitalize', 'off')
  if (!el.hasAttribute('autocorrect'))    el.setAttribute('autocorrect', 'off')
  if (!el.hasAttribute('autocomplete'))   el.setAttribute('autocomplete', 'off')
  if (!el.hasAttribute('spellcheck'))     el.setAttribute('spellcheck', 'false')
  if (!el.hasAttribute('data-gramm'))     el.setAttribute('data-gramm', 'false')
}

function sweep(root) {
  const scope = root && root.querySelectorAll ? root : document
  scope.querySelectorAll('input, textarea').forEach(patchInput)
}

export function installAutoCapitalizeShim() {
  if (typeof document === 'undefined') return
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => sweep(document), { once: true })
  } else {
    sweep(document)
  }

  const mo = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1) continue
        if (node.matches && node.matches('input, textarea')) patchInput(node)
        sweep(node)
      }
    }
  })
  mo.observe(document.documentElement, { childList: true, subtree: true })
}
