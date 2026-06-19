# Aqua UI Refresh — Design Spec

Date: 2026-06-19

## Goal

Modernize GripLite's UI to a polished, Apple-inspired ("Aqua") look that feels
like professional macOS software: translucency/vibrancy, soft layered depth,
refined typography & spacing, spring press feedback, and a tasteful water-ripple
interaction — without changing any layout or behavior.

## Constraints (approved scope)

- **Visual refresh only.** No layout restructuring, no behavior changes.
- **Apple-first aesthetic.** Translucency + subtle motion. Ripple is *subtle*
  and limited to primary buttons and clickable rows (not everywhere).
- **Both themes** polished equally (light + dark).
- **Accent → Apple system blue** (light `#007AFF`, dark `#0A84FF`).
- Risk control: keep every existing design-token *name* so all 33 components
  inherit the refresh automatically. New utilities/components are additive.

## Approach

The app already uses a semantic token system: CSS custom properties in
`style.css`, surfaced as Tailwind utilities (`bg-panel`, `fg-primary`,
`border-line`, …) via `tailwind.config.js`. The refresh works mostly by
**revaluing tokens** plus **adding new ones**, so the visual jump propagates
everywhere with minimal per-component edits.

### 1. Token overhaul (`style.css`, both `:root` and `:root.dark`)

- **Accent ramp:** Apple system blue with hover/pressed/subtle steps.
- **Neutrals:** macOS-like grays — light window `#ECECEE`, panels `#FFFFFF`;
  dark graphite `#1C1C1E`, panels `#2C2C2E`, elevated `#3A3A3C`.
- **Elevation:** multi-stop ambient+key-light shadows (`--shadow-1..3`).
- **Radii:** friendlier scale — `--radius-sm/md/lg/xl` (6/8/10/14px).
- **Materials (vibrancy):** translucent surface tokens
  (`--material-bar`, `--material-sidebar`, `--material-menu`,
  `--material-overlay`) paired with `backdrop-filter: blur(...)`, each with a
  solid fallback color for safety.

### 2. Interaction primitives (additive)

- **`Ripple` component / `useRipple` hook** (`components/Ripple.jsx`): renders an
  absolutely-positioned, accent-tinted circle that expands+fades (~480ms) from
  the pointer location. Pure, self-contained, unit-testable (geometry helper +
  React behavior guarded by a smoke check).
- **`.press` utility** (CSS): `active:scale(0.97)` with a spring cubic-bezier.
- **`.focus-ring` / global focus styles:** 3px accent glow.
- **Motion:** all new animation wrapped in `@media (prefers-reduced-motion: no-preference)`.

### 3. Tailwind exposure (`tailwind.config.js`)

Add `borderRadius`, `boxShadow`, and `backgroundColor` material entries that map
to the new tokens, so components can use `rounded-lg`, `shadow-1`, etc.

### 4. Surface polish (tokens + primitives, no structural change)

- **Title bar** (`App.jsx`): vibrancy material + hairline.
- **Sidebar / `DatabaseExplorer`**: rounded selection pill (accent-subtle), row
  ripple, smoother hover.
- **Tabs** (`App.jsx` TabBar): elevated active "chiclet", smooth transitions.
- **Buttons / toolbars**: primary = accent fill + ripple + press; secondary =
  subtle bordered; icon buttons = circular hover wash.
- **Inputs / selects**: rounded + accent focus glow.
- **Modals**: vibrancy backdrop blur, larger radius, spring entrance.
- **Status bar + scrollbars**: translucent / thin overlay style.

## Testing / Verification

- Add a unit test for the ripple geometry helper in `frontend/scripts/unit-tests.mjs`.
- Must pass: `npm test` (unit-tests + render-smoke) and `vite build`.
- Manual sanity: app mounts, light/dark toggle, a primary button shows ripple.

## Out of scope

- No new screens, no command palette, no layout changes.
- No Go/back-end changes.
