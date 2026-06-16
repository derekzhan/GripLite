/**
 * Render smoke test — actually mounts <App/> so runtime crashes (e.g. a
 * temporal-dead-zone "Cannot access X before initialization" from hooks
 * declared out of order) are caught in CI, not by users staring at a blank
 * window.
 *
 * The plain `unit-tests.mjs` suite only reads source text and can't catch these.
 * Here we bundle App with esbuild, set up a DOM via happy-dom, and run a
 * synchronous server render — which executes the App component body and throws
 * on any render-time error.
 */
import { build } from 'esbuild'
import { Window } from 'happy-dom'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function main() {
  // 1. Minimal browser globals (read during render: localStorage, matchMedia…).
  const window = new Window({ url: 'http://localhost/' })
  const g = globalThis
  // Some globals (navigator) are getter-only in modern Node; define them.
  const def = (key, value) => {
    try { Object.defineProperty(g, key, { value, configurable: true, writable: true }) }
    catch { /* leave Node's built-in in place */ }
  }
  def('window', window)
  def('document', window.document)
  if (!g.navigator || !g.navigator.platform) def('navigator', window.navigator)
  def('localStorage', window.localStorage)
  def('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0))
  def('cancelAnimationFrame', (id) => clearTimeout(id))
  if (!g.matchMedia) def('matchMedia', (q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } }))
  for (const key of ['HTMLElement', 'Element', 'Node', 'CSSStyleSheet', 'getComputedStyle', 'MutationObserver', 'CustomEvent', 'Event']) {
    if (g[key] === undefined && window[key] !== undefined) def(key, window[key])
  }
  if (!g.ResizeObserver) def('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })

  // The Glide grid renders its edit overlay into #portal (see main.jsx).
  const portal = window.document.createElement('div')
  portal.id = 'portal'
  window.document.body.appendChild(portal)

  // 2. Bundle a tiny entry that client-renders the app once (portals OK).
  const entry = `
    import ReactDOM from 'react-dom'
    import React from 'react'
    import App from './src/App.jsx'
    import { ThemeProvider } from './src/theme/ThemeProvider.jsx'
    import { FontSettingsProvider } from './src/settings/FontSettingsProvider.jsx'
    export function renderOnce() {
      const root = document.createElement('div')
      root.id = 'root'
      document.body.appendChild(root)
      // Legacy render is synchronous, so a render-time crash (e.g. a
      // temporal-dead-zone hook ordering bug) throws straight to the caller.
      ReactDOM.render(
        React.createElement(
          ThemeProvider,
          { defaultTheme: 'dark' },
          React.createElement(FontSettingsProvider, null, React.createElement(App)),
        ),
        root,
      )
      return root.innerHTML
    }
  `
  const result = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    write: false,
    logLevel: 'silent',
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'text', '.svg': 'text', '.png': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.wasm': 'binary' },
  })

  // 3. Write the bundle to a temp file and import it.
  const dir = mkdtempSync(join(tmpdir(), 'griplite-smoke-'))
  const file = join(dir, 'bundle.mjs')
  writeFileSync(file, result.outputFiles[0].text)
  const mod = await import(pathToFileURL(file).href)

  // 4. Render — throws synchronously on any render-time crash.
  const html = mod.renderOnce()
  if (typeof html !== 'string') {
    throw new Error('App produced no DOM output')
  }
  console.log('render smoke passed (App mounts without runtime error)')
}

main().catch((err) => {
  console.error('render smoke FAILED:\n', err)
  process.exit(1)
})
