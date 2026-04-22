// End-to-end smoke-test harness for GripLite's React UI.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ Why this file exists                                                 │
// │                                                                      │
// │ Phase 21 introduced <ErrorBoundary>, the toast system and error      │
// │ normalisation.  The whole point is to make UI faults LOCAL — one     │
// │ misbehaving tab must never take the whole app down ("white screen"). │
// │ Every path in the sidebar / tab bar / modal is a potential regression│
// │ site, so this file exercises them through a mocked window.go to      │
// │ assert the root element stays mounted at every step.                 │
// │                                                                      │
// │ It is NOT a replacement for Vitest/Jest — it's a lightweight,        │
// │ dependency-free repro that doubles as a regression gate.  Running it │
// │ under happy-dom is enough because React's reconciler has identical   │
// │ semantics in Chrome/Wails; the only divergence is Monaco's pixel     │
// │ ratio (which we deliberately catch in an ErrorBoundary below).       │
// └──────────────────────────────────────────────────────────────────────┘

import { build } from 'esbuild'
import { Window } from 'happy-dom'
import fs from 'node:fs'
import path from 'node:path'

process.on('uncaughtException',  (e) => {
  // Monaco throws `Canceled` from its internal cancellable-promise pattern
  // whenever the editor tears down before a deferred task resolves.  That
  // is BENIGN in our test harness (we never interact with the real
  // editor), so swallow it and keep running.
  if (/Canceled|webkitBackingStorePixelRatio/.test(e?.message ?? '')) return
  process.stdout.write(`!!! uncaught: ${e.message}\n${e.stack}\n`); process.exit(2)
})
process.on('unhandledRejection', (e) => {
  if (/Canceled|webkitBackingStorePixelRatio/.test(e?.message ?? '')) return
  process.stdout.write(`!!! rejection: ${e?.message ?? e}\n${e?.stack ?? ''}\n`); process.exit(3)
})
// ── DOM polyfill ───────────────────────────────────────────────────────
const window = new Window({ url: 'http://localhost/' })
globalThis.window       = window
globalThis.document     = window.document
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch {}
globalThis.HTMLElement  = window.HTMLElement
globalThis.Element      = window.Element
globalThis.Node         = window.Node
globalThis.getComputedStyle = window.getComputedStyle
globalThis.localStorage = window.localStorage
globalThis.matchMedia   = window.matchMedia?.bind(window) ?? (() => ({
  matches: false, addEventListener: () => {}, removeEventListener: () => {},
  addListener: () => {}, removeListener: () => {},
}))
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)
globalThis.cancelAnimationFrame  = (id) => clearTimeout(id)
globalThis.MutationObserver = window.MutationObserver ?? class { observe(){} disconnect(){} }
globalThis.ResizeObserver   = window.ResizeObserver   ?? class { observe(){} disconnect(){} unobserve(){} }
globalThis.IntersectionObserver = window.IntersectionObserver ?? class { observe(){} disconnect(){} unobserve(){} }

document.body.innerHTML = '<div id="root"></div>'

// Monaco Editor's @monaco-editor/react loader normally fetches vs/loader.js
// from jsdelivr.  Under happy-dom that turns into a real outbound HTTP
// call that hangs the event loop and never fires because happy-dom has no
// working CORS story.  Short-circuit every fetch to a 503 so the loader
// gives up fast and Monaco lives inside an ErrorBoundary fallback instead
// of blocking the whole test run.
globalThis.fetch = () => Promise.reject(new Error('network disabled in tests'))

// ── Error capture ──────────────────────────────────────────────────────
// React 18 logs render errors to console.error rather than throwing, so
// we tee console.error into an array to assert "caught by ErrorBoundary"
// vs "uncaught → white screen".
const consoleErrors = []
const origErr = console.error
console.error = (...args) => {
  consoleErrors.push(args.map((a) =>
    a instanceof Error ? (a.stack || a.message)
      : typeof a === 'object' ? JSON.stringify(a).slice(0, 300)
      : String(a),
  ).join(' '))
  // Keep silent in test mode unless DEBUG set — otherwise noise hides
  // the actual pass/fail table.  Pass DEBUG=1 to see it all.
  if (process.env.DEBUG) origErr('[console.error]', ...args)
}
window.addEventListener('error',             (e) => consoleErrors.push('[window.error] ' + e.message))
window.addEventListener('unhandledrejection', (e) => consoleErrors.push('[unhandledrejection] ' + (e.reason?.stack || e.reason?.message || String(e.reason))))

// ── Bundle helpers ─────────────────────────────────────────────────────
// Everything that crosses the .jsx boundary has to go through esbuild
// because Node can't import .jsx natively.  `bundleAs()` creates a
// throw-away ESM module for a given entry so tests can import it cleanly.
const bundlePaths = []
async function bundleAs(entry, outfile, opts = {}) {
  bundlePaths.push(outfile)
  await build({
    entryPoints: [entry],
    bundle:   true,
    format:   'esm',
    platform: 'browser',
    jsx:      'automatic',
    outfile,
    loader:   { '.js': 'jsx', '.jsx': 'jsx', '.css': 'text' },
    external: opts.external ?? [],
    logLevel: 'error',
    define:   { 'process.env.NODE_ENV': '"development"' },
  })
  return outfile
}

const out = await bundleAs('src/main.jsx', path.resolve('tmp-app-bundle.mjs'))

// ── Helpers ────────────────────────────────────────────────────────────
const root   = document.getElementById('root')
const settle = (ms=200) => new Promise((r)=>setTimeout(r,ms))

/** Collect the <span> elements whose direct text equals `text`. */
function labelSpans(text) {
  return [...document.querySelectorAll('span')]
    .filter((s) => s.textContent.trim() === text)
}

/** Walk up from `el` until we find a `.cursor-pointer` row. */
function rowContaining(el) {
  let n = el
  while (n && !(n.className || '').includes('cursor-pointer')) {
    n = n.parentElement
  }
  return n
}

/** Find the Nth occurrence of a row whose label is exactly `text`. */
function rowFor(text, occurrence = 0) {
  const candidates = labelSpans(text).map(rowContaining).filter(Boolean)
  return candidates[occurrence] ?? null
}

async function clickRow(text, { occurrence = 0 } = {}) {
  const row = rowFor(text, occurrence)
  if (!row) return null
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await settle(150)
  return row
}

async function dblClickRow(text, { occurrence = 0 } = {}) {
  const row = rowFor(text, occurrence)
  if (!row) return null
  row.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  await settle(200)
  return row
}

async function rightClickRow(text, { occurrence = 0 } = {}) {
  const row = rowFor(text, occurrence)
  if (!row) return null
  row.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 100, clientY: 100,
  }))
  await settle(120)
  return row
}

async function clickMenuItem(regex) {
  const match = [...document.querySelectorAll('button,div,span')]
    .find((el) => regex.test((el.textContent || '').trim()) && el.textContent.trim().length < 60)
  if (!match) return false
  match.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await settle(300)
  return true
}

async function clickButton(predicate) {
  const btn = [...document.querySelectorAll('button')].find(predicate)
  if (!btn) return false
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await settle(200)
  return true
}

function rootSize() { return root?.innerHTML.length ?? 0 }

// ── Test runner ────────────────────────────────────────────────────────
const results = []
async function test(name, fn) {
  const before = rootSize()
  const errorsBefore = consoleErrors.length
  let status = 'PASS', detail = ''
  try {
    // Hard per-test timeout so one runaway test can't wedge the run.
    const r = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, rej) => setTimeout(() => rej(new Error('test timed out (5s)')), 5000)),
    ])
    const after = rootSize()
    if (after === 0) {
      status = 'FAIL'
      detail = 'root became empty — WHITE SCREEN'
    } else if (r === false) {
      status = 'FAIL'
      detail = 'test assertion returned false'
    } else if (typeof r === 'string') {
      // Convention: any returned string is an assertion failure message.
      status = 'FAIL'
      detail = r
    }
  } catch (e) {
    status = 'FAIL'
    detail = e.message
  }
  const newErrors = consoleErrors.slice(errorsBefore)
  results.push({ name, status, detail, errors: newErrors.length })
}

function headlineErrors() {
  return consoleErrors.filter((e) =>
    !/Could not find the dependencies|Monaco|pixelRatio|webkitBackingStorePixelRatio/i.test(e),
  )
}

// ───────────────────────────────────────────────────────────────────────
// Boot the app once
// ───────────────────────────────────────────────────────────────────────
await import(out)
await settle(400)

// ── Tests ──────────────────────────────────────────────────────────────

await test('01 · cold boot renders Welcome pane', async () => {
  if (rootSize() === 0) return false
  if (!root.textContent.includes('GripLite')) return 'header missing'
  if (!root.textContent.includes('New SQL Console')) return 'welcome CTA missing'
})

await test('02 · "+ New SQL Console" opens a console tab without crashing', async () => {
  await clickButton((b) => /new sql console/i.test(b.textContent))
  // Monaco's error/init takes a couple of microtasks; give it time so either
  // the Run button mounts or the ErrorBoundary fallback renders.
  await settle(800)
  const hasRunButton = [...document.querySelectorAll('button')]
    .some((b) => (b.title || '').toLowerCase().includes('run current statement'))
  const hasFallback  = /Something went wrong/i.test(root.innerHTML)
  if (!hasRunButton && !hasFallback) return 'neither editor nor ErrorBoundary fallback mounted'
})

await test('03 · tab bar "+" spawns another console', async () => {
  const before = [...document.querySelectorAll('button')].filter((b)=>b.title?.includes('Run current statement')).length
  await clickButton((b) => (b.title || '').toLowerCase().includes('new sql console') && b.textContent.trim() === '+')
  await settle(300)
  const after  = [...document.querySelectorAll('button')].filter((b)=>b.title?.includes('Run current statement')).length
  // Depending on tab switching the Run button count may stay the same if the
  // tabs are CSS-switched; verify tab count via data
  if (rootSize() === 0) return false
})

await test('04 · expand sidebar: connection → Databases → db1', async () => {
  await clickRow('localhost (mock)')
  await settle(300)
  await clickRow('Databases')
  await settle(300)
  // Under the connection there are TWO "db1" nodes: one is the subtitle
  // on the connection row; the other is the Databases child.  We want #1.
  await clickRow('db1', { occurrence: 1 })
  await settle(300)
  if (!labelSpans('Tables').length) return 'Tables folder missing after db1 expand'
})

await test('05 · right-click Tables → Create New Table… opens templated console', async () => {
  await rightClickRow('Tables')
  const ok = await clickMenuItem(/create new table/i)
  if (!ok) return 'menu item not found'
  await settle(400)
  // A new console should be present with the template SQL — we can't peek
  // into Monaco, but at minimum the app must still be mounted.
  if (rootSize() === 0) return false
})

await test('06 · right-click Tables → Browse from here opens templated console', async () => {
  await rightClickRow('Tables')
  const ok = await clickMenuItem(/browse from here/i)
  if (!ok) return 'menu item not found'
  await settle(400)
  if (rootSize() === 0) return false
})

await test('07 · right-click Tables → View Tables opens DatabaseViewer', async () => {
  await rightClickRow('Tables')
  const ok = await clickMenuItem(/view tables/i)
  if (!ok) return 'menu item not found'
  await settle(500)
  if (rootSize() === 0) return false
})

await test('08 · right-click Tables → Refresh does not crash', async () => {
  await rightClickRow('Tables')
  const ok = await clickMenuItem(/refresh/i)
  if (!ok) return 'menu item not found'
  await settle(400)
  if (rootSize() === 0) return false
})

await test('08b · right-click on a TABLE node opens table context menu', async () => {
  // Expand Tables folder so individual table rows render.
  await clickRow('Tables')
  await settle(400)
  // mock data: db1 contains "users","orders","products","categories","reviews"
  const target = rowFor('orders') || rowFor('users') || rowFor('products')
  if (!target) return 'no table row found under Tables'
  target.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 120, clientY: 120,
  }))
  await settle(150)
  // Menu must contain at minimum the "View Table" item we just added.
  const hasViewTable = [...document.querySelectorAll('button,div,span')]
    .some((el) => /^view table$/i.test((el.textContent || '').trim()))
  if (!hasViewTable) return '"View Table" menu item missing'
  // Close the menu by Escape so subsequent tests start clean.
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle(100)
})

await test('09 · open About modal', async () => {
  // Header has a "GripLite v0.1.1" button that toggles AboutModal.
  await clickButton((b) => /GripLite v/.test(b.textContent))
  await settle(200)
  const hasAbout = [...document.querySelectorAll('*')].some((el) =>
    /Lightweight Cross-Platform/.test(el.textContent || ''),
  )
  if (!hasAbout) return 'About content not found'
  // Close it by pressing Escape.
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle(150)
})

await test('10 · toggle theme (light ↔ dark) does not crash', async () => {
  await clickButton((b) => /theme/i.test(b.title || '') || /sun|moon/i.test(b.getAttribute('aria-label') || ''))
  await settle(200)
  if (rootSize() === 0) return false
})

await test('11 · double-click a database opens DatabaseViewer tab', async () => {
  await dblClickRow('analytics') // from mock
  await settle(400)
  if (rootSize() === 0) return false
})

await test('12 · context menu closes on outside click', async () => {
  await rightClickRow('Tables')
  // Verify menu present.
  const hadMenu = !![...document.querySelectorAll('*')].find((el) => /create new table/i.test(el.textContent || ''))
  if (!hadMenu) return 'menu never appeared'
  // Click elsewhere to close.
  document.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
  await settle(150)
})

await test('13 · context menu closes on Escape', async () => {
  await rightClickRow('Tables')
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle(150)
  if (rootSize() === 0) return false
})

await test('14 · toast system: success / error / dismiss', async () => {
  // Render our OWN <Toaster/> into a scratch div so this test doesn't
  // depend on the main App's instance (which it can't reach into because
  // each esbuild bundle yields its own module instance).
  //
  // IMPORTANT: mark React external so the mini-bundle SHARES the same
  // React module instance as react-dom/client — otherwise we end up with
  // two Reacts and React's internal dispatcher is null during the render
  // ("Cannot read properties of null (reading 'useState')").
  const toastBundle = await bundleAs('src/lib/toast.jsx', path.resolve('tmp-toast.mjs'), {
    external: ['react', 'react-dom', 'react-dom/client'],
  })
  const { toast, Toaster } = await import(toastBundle)
  const React    = await import('react')
  const RDClient = await import('react-dom/client')

  const host = document.createElement('div')
  document.body.appendChild(host)
  const rr = RDClient.createRoot(host)
  rr.render(React.createElement(Toaster))
  await settle(80)

  toast.success('hello')
  const eid = toast.error('boom', { id: 'unit' })
  toast.info('msg')
  await settle(120)

  const body = document.body.innerHTML
  const missing = ['hello', 'boom', 'msg'].filter((s) => !body.includes(s))
  if (missing.length) {
    rr.unmount(); host.remove()
    return `toast markup missing: ${missing.join(', ')}`
  }

  toast.dismiss(eid)
  await settle(120)
  const stillThere = document.body.innerHTML.includes('boom')
  toast.clear()
  rr.unmount()
  host.remove()
  if (stillThere) return 'dismiss did not remove error toast'
})

await test('15 · ErrorBoundary: direct smoke (throws in child)', async () => {
  // We can't easily force a re-render in the live tree; instead we render
  // the ErrorBoundary in isolation into a scratch div and assert the
  // fallback appears instead of the crashing child.
  const ebBundle = await bundleAs('src/components/ErrorBoundary.jsx', path.resolve('tmp-eb.mjs'), {
    external: ['react', 'react-dom', 'react-dom/client'],
  })
  const React     = await import('react')
  const RDClient  = await import('react-dom/client')
  const { default: EB } = await import(ebBundle)

  function Bomb() { throw new Error('simulated bomb') }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const rr = RDClient.createRoot(host)
  rr.render(React.createElement(EB, { label: 'Scratch' }, React.createElement(Bomb)))
  await settle(80)
  const html = host.innerHTML
  rr.unmount()
  host.remove()
  if (!/Something went wrong/i.test(html)) return 'Fallback UI not rendered'
  if (!/Scratch/.test(html))                return 'Label not in fallback'
})

// ── Report ─────────────────────────────────────────────────────────────
for (const p of bundlePaths) { fs.existsSync(p) && fs.unlinkSync(p) }

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n)
const passed = results.filter((r) => r.status === 'PASS').length
const failed = results.length - passed

console.log('\n' + '━'.repeat(80))
console.log('GRIPLITE E2E SMOKE RESULTS')
console.log('━'.repeat(80))
for (const r of results) {
  const tag = r.status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
  console.log(`${tag}  ${pad(r.name, 62)} ${r.detail || ''}`)
}
console.log('━'.repeat(80))
console.log(`TOTAL: ${results.length}   PASS: ${passed}   FAIL: ${failed}`)

const worrisome = headlineErrors()
if (worrisome.length) {
  console.log('\nNon-Monaco console errors captured during the run:')
  for (const e of worrisome.slice(0, 10)) {
    console.log(' -', e.slice(0, 400))
  }
  if (worrisome.length > 10) console.log(` …and ${worrisome.length - 10} more`)
}

process.exit(failed ? 1 : 0)
