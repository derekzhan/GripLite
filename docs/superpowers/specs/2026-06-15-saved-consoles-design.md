# Saved Consoles — Design

## Goal

Let users save SQL consoles (DBeaver-style "SQL scripts") and reopen them later
from a new in-app **"Consoles"** menu in the title bar. A saved console is
essentially a named SQL file plus its connection/database association.

## Decisions (locked)

- **Storage:** `griplite.db` (durable, survives reinstall, no OS file dialogs).
- **Menu placement:** a new always-visible in-app **"Consoles"** dropdown in the
  title bar (works identically on macOS/Windows/Linux; the native macOS menu
  bar can't show a live-updating list easily).
- **Save mode:** explicit **"Save current console…"** with a name; re-saving an
  already-saved console updates it in place. Unsaved consoles stay ephemeral.

## Data model

New table in `griplite.db`:

```sql
CREATE TABLE IF NOT EXISTS saved_consoles (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  sql             TEXT NOT NULL,
  conn_id         TEXT,
  db_name         TEXT,
  connection_kind TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`name` is **not** unique — identity is `id`. Duplicate names are allowed.

## Backend (Go App methods)

- `type SavedConsole struct { ID, Name, SQL, ConnID, DBName, ConnectionKind, CreatedAt, UpdatedAt string }`
- `ListSavedConsoles() ([]SavedConsole, error)` — ordered by `updated_at DESC`.
- `SaveConsole(c SavedConsole) (SavedConsole, error)` — when `c.ID == ""`,
  generate an id and INSERT; otherwise UPDATE (`name`, `sql`, `conn_id`,
  `db_name`, `connection_kind`, `updated_at = datetime('now')`). Returns the
  persisted row (with id + timestamps).
- `DeleteSavedConsole(id string) error`.

## Bridge (frontend)

`listSavedConsoles()`, `saveConsole(payload)`, `deleteSavedConsole(id)` — Wails
calls in app mode, `localStorage`-backed mock keyed `griplite_saved_consoles_v1`
in browser dev.

## UI

### `SavedConsolesMenu.jsx` (title-bar dropdown)
- Trigger button labeled "Consoles".
- "Save current console…" item — disabled unless the active tab is a console.
- Divider, then the saved-console list: each row shows the name and a connection
  hint; click opens it, hover reveals a ✕ delete.
- Closes on outside-click / Escape.

### `SaveConsoleModal.jsx`
- Single text input for the console name (prefilled with the current saved name
  or the tab label), Save / Cancel.

## Data flow

### Save
1. Active console tab → read its editor state from
   `localStorage["griplite_sql_editor_<tabId>_v1"]`: active sub-tab `content`
   (the SQL) and `selectedDb`.
2. Open `SaveConsoleModal`, get the name.
3. `saveConsole({ id: tab.savedConsoleId ?? '', name, sql, connId: tab.connId,
   dbName: selectedDb, connectionKind })`.
4. On success: stamp the tab with `savedConsoleId` + `savedConsoleName`, set the
   tab label to the name, and refresh the saved list.

### Open
1. If a console tab already has `savedConsoleId === saved.id`, focus it.
2. Otherwise create a new console tab seeded with `initialSql = saved.sql`,
   `connId = saved.connId`, `defaultDb = saved.dbName`,
   `connectionKind = saved.connectionKind`, `label = saved.name`, and
   `savedConsoleId`/`savedConsoleName` set.

### Persistence of association
`workspaceState.cleanTab` keeps optional `savedConsoleId` + `savedConsoleName`
on `console` tabs so the binding survives restarts.

## Error handling
- All bridge calls are guarded; failures surface via toast and never crash the
  tree. Opening a saved console whose `connId` no longer exists still loads the
  SQL (database list just comes up empty).

## Testing
- Go: extend the schema smoke test to expect `saved_consoles`; add an
  upsert→list→delete test verifying insert-vs-update behavior.
- Frontend: unit-test the SQL-capture helper (reads editor localStorage shape)
  and the open-or-focus selection logic.
