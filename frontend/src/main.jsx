import React from 'react'
import {createRoot} from 'react-dom/client'
import './style.css'
import App from './App'
import { ThemeProvider } from './theme/ThemeProvider'
import { installAutoCapitalizeShim } from './lib/disableAutoCapitalize'

installAutoCapitalizeShim()

// Suppress the WebView's built-in context menu (Reload, Inspect Element, etc.).
// Custom context menus in the app are React-managed and shown programmatically;
// they don't rely on the browser's native contextmenu event at all.
document.addEventListener('contextmenu', (e) => e.preventDefault())

// Glide Data Grid (@glideapps/glide-data-grid v6) renders its cell-edit
// overlay into a DOM node with id="portal" via ReactDOM.createPortal.
// If this element is missing, double-clicking a cell silently fails
// (Glide logs a console.error and no editor appears).  We inject it here
// once at startup so every grid across the app can open its overlay.
// See: node_modules/@glideapps/glide-data-grid/dist/esm/internal/data-grid-overlay-editor/data-grid-overlay-editor.js
if (typeof document !== 'undefined' && !document.getElementById('portal')) {
  const portal = document.createElement('div')
  portal.id = 'portal'
  // Glide positions the overlay absolutely relative to the grid cell;
  // the portal itself just needs to be a top-level sibling of <body>.
  document.body.appendChild(portal)
}

const container = document.getElementById('root')

const root = createRoot(container)

root.render(
    <React.StrictMode>
        <ThemeProvider defaultTheme="dark">
            <App/>
        </ThemeProvider>
    </React.StrictMode>
)
