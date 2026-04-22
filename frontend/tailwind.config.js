/** @type {import('tailwindcss').Config} */
//
// Theme tokens are defined as CSS custom properties in src/style.css.  Tailwind
// is taught here to surface them as ordinary utility classes — for example
// `bg-panel` resolves to `background-color: var(--bg-panel)`, which then
// switches automatically with the active light/dark theme.
//
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Surfaces
        app:        'var(--bg-app)',
        sunken:     'var(--bg-sunken)',
        panel:      'var(--bg-panel)',
        elevated:   'var(--bg-elevated)',
        titlebar:   'var(--bg-titlebar)',
        statusbar:  'var(--bg-statusbar)',

        // Interaction states (use as bg-hover / bg-active / bg-selected)
        hover:      'var(--bg-hover)',
        active:     'var(--bg-active)',
        selected:   'var(--bg-selected)',

        // Foreground families.  Tailwind exposes these as both text-* and
        // bg-* utilities; the `fg.` namespace keeps them out of the way of
        // user-defined "primary" tokens.
        fg: {
          primary:   'var(--fg-primary)',
          secondary: 'var(--fg-secondary)',
          muted:     'var(--fg-muted)',
          faint:     'var(--fg-faint)',
          'on-accent': 'var(--fg-on-accent)',
        },

        // Borders
        line:        'var(--border)',
        'line-subtle': 'var(--border-subtle)',

        // Accent / status
        accent:        'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-subtle':'var(--accent-subtle)',
        'accent-text': 'var(--accent-text)',

        success:    'var(--success)',
        warn:       'var(--warn)',
        'warn-bg':  'var(--warn-bg)',
        danger:     'var(--danger)',
        'danger-bg': 'var(--danger-bg)',

        // Syntactic colours used by the explorer / cell-style overrides
        'syntax-keyword': 'var(--syntax-keyword)',
        'syntax-type':    'var(--syntax-type)',
        'syntax-string':  'var(--syntax-string)',
        'syntax-user':    'var(--syntax-user)',
        'syntax-pk':      'var(--syntax-pk)',
      },
    },
  },
  plugins: [],
}
