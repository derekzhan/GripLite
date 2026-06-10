# Redis Support Design

## Goal

Add Redis support to GripLite with a feature set inspired by Another Redis Desktop
Manager (ARDM), implemented with GripLite's own driver/registry and `kind`-branching
patterns (not a port of ARDM source).

Scope for this effort covers phases P1–P5:

- **P1 — Connection + key browsing**: create/save standalone Redis connections
  (host/port/username/password/default DB/TLS), browse logical DBs `db0`–`db15`, and
  navigate a `SCAN`-backed key tree with `:`-namespace folding and prefix filtering.
- **P2 — Five core types + key ops**: view and edit `string`, `hash`, `list`, `set`,
  `zset`; view/set TTL; rename and delete keys.
- **P3 — CLI console**: run raw Redis commands and view output, reusing the console tab.
- **P4 — Stream type + value decoding**: `stream` type viewer, plus a value decoder
  supporting Text / JSON / Hex / Binary, decompression (GZip, Deflate, Brotli, LZ4,
  Snappy, ZSTD), and serialization (Msgpack, Protobuf, Pickle, PHP). Protobuf (no
  schema) and Pickle are best-effort structural decodes.
- **P5 — Server tooling**: `INFO` overview, Pub/Sub, slow log, client list.

Cluster, Sentinel, and SSH-tunnel connection modes (P6) are explicitly out of scope here.

## Current Project Context

GripLite is a Wails + React app. The backend exposes exported methods from `app.go`
to the frontend. The driver layer is organized around:

- `internal/driver/types.go`, defining `DatabaseDriver`, the `DriverKind` enum
  (`mysql`, `mongodb`), the `Register`/`New` registry, and optional extension
  interfaces (`PagedQueryDriver`, `AdvancedSchemaDriver`, ...).
- `internal/driver/mysql` and `internal/driver/mongodb`, the two existing drivers.
  MongoDB is the closest analog to Redis: a non-`database/sql` store that shares the
  generic IPC surface and adds a small number of driver-specific App methods
  (`ApplyMongoChanges`, paging) plus frontend `kind`-branching.
- `internal/store`, which persists connection records (encrypted passwords) in
  `griplite.db`; the `kind` column is already free-text, so no schema migration is
  required to add `redis`.
- `frontend/src/components/{ConnectionDialog,DatabaseExplorer,SqlEditor,TableViewer}.jsx`
  and `frontend/src/lib/{bridge,mongoQuery}.js`, which implement connection, explorer,
  console, and data flows and branch on `connectionKind`.

Redis must reuse these boundaries the same way MongoDB does, and must NOT be wired into
the MySQL-only `internal/database` pool manager.

## MySQL / MongoDB Non-Regression Requirement

Redis support must be additive. Existing MySQL and MongoDB behavior is the baseline and
must not change except for the minimal integration needed to coexist with a new driver:

- Existing saved connections, connection testing, console execution, explorer, data
  views, editing, autocomplete, paging, and query history for MySQL and MongoDB must
  continue to work unchanged.
- Default connection kind remains `mysql` for old records and new connections unless
  the user selects Redis.
- Shared frontend components must branch on connection kind only where behavior is
  genuinely backend-specific.
- Shared backend methods (`RunQuery`, `FetchDatabases`, `ListConnections`, store
  methods) preserve their current request/response shapes. Redis-specific fields are
  optional and ignored by other callers.

## Backend Architecture

### Redis Driver Package

Create `internal/driver/redis` and register it with the driver registry:

- Add `DriverRedis DriverKind = "redis"` in `internal/driver/types.go`.
- Use the official client `github.com/redis/go-redis/v9`.
- Implement the minimal `DatabaseDriver` surface:
  - `Kind()` returns `DriverRedis`.
  - `Connect()` dials with host/port/username/password/TLS and a select-on-connect
    default DB, then `PING`s; records server version from `INFO server`.
  - `Close()`, `Ping()`.
  - `FetchDatabases()` returns logical DBs `db0`–`db15` (count derived from
    `CONFIG GET databases`, default 16), each carrying its key count from `DBSIZE`.
  - `ServerVersion()` returns the parsed `redis_version`.
- Redis does NOT implement table/column schema interfaces. Key browsing and value
  operations use dedicated App methods (below), because key spaces can be huge and do
  not map to `FetchTables`.

Connection options support host, port, username (ACL), password, default DB index, and
TLS. Read-only enforcement happens at the App/driver layer: when a connection is marked
read-only, mutating commands are rejected before reaching the server.

### Redis-Specific App Methods

Following the `ApplyMongoChanges` precedent, add Redis App methods in `app.go` (thin
wrappers that resolve the live driver via `ensureLive` and dispatch to the redis driver):

- Browsing: `RedisScanKeys(connID, db, pattern, cursor, count)` → `{keys, nextCursor}`
  using `SCAN ... MATCH ... COUNT`.
- Read: `RedisGetKey(connID, db, key)` → `{type, ttl, sizeBytes, encoding, value}`
  where `value` is type-shaped (string payload; hash field/value pairs; list elements;
  set members; zset member/score pairs; stream entries).
- Writes (string): `RedisSetString(connID, db, key, value, ttl)`.
- Writes (hash): `RedisHashSet(connID, db, key, field, value)`, `RedisHashDelete(...)`.
- Writes (list): `RedisListSet(connID, db, key, index, value)`,
  `RedisListPush(connID, db, key, value, left bool)`, `RedisListRemove(...)`.
- Writes (set): `RedisSetAdd(...)`, `RedisSetRemove(...)`.
- Writes (zset): `RedisZAdd(connID, db, key, member, score)`, `RedisZRemove(...)`.
- Writes (stream): `RedisStreamAdd(connID, db, key, id, fields)`,
  `RedisStreamDelete(connID, db, key, id)`.
- Key ops: `RedisRenameKey`, `RedisDeleteKey`, `RedisSetTTL` (and persist/remove TTL).
- Console: `RedisExecCommand(connID, db, rawCommand)` → normalized result for the CLI.
- Decoding: `RedisDecodeValue(base64Data, format)` → `{ok, text, error}`. This is a
  pure function with no connection dependency, so it is unit-testable in isolation.
- Server tooling (P5): `RedisServerInfo(connID)` → parsed `INFO` sections;
  `RedisSlowLog(connID, count)`; `RedisClientList(connID)`.
- Pub/Sub (P5): `RedisSubscribe(connID, channels)` starts a goroutine that streams
  messages to the frontend via `runtime.EventsEmit("redis:message:<subID>", msg)`;
  `RedisUnsubscribe(connID, subID)` stops it. Subscriptions are tracked per connection
  and torn down on disconnect.

### Value Decoding

`RedisDecodeValue` accepts raw bytes (base64 over IPC) and a target format and returns a
display string:

- `text` (UTF-8, default), `json` (parsed + pretty-printed), `hex`, `binary`.
- Decompression: `gzip`, `deflate`, `brotli`, `lz4`, `snappy`, `zstd` — decode then
  render as text/JSON.
- Serialization: `msgpack`, `protobuf`, `pickle`, `php`. `msgpack` and `php` decode to
  JSON-ish structures; `protobuf` (no schema) and `pickle` are best-effort structural
  decodes and clearly flag when the result is approximate.
- On failure, return `{ok:false, error}` so the UI can fall back to the previous format.

Libraries: `klauspost/compress` (gzip/deflate/zstd/snappy), `andybalholm/brotli`,
`pierrec/lz4`, `vmihailenco/msgpack`. Protobuf/Pickle/PHP use lightweight or custom
best-effort decoders.

### Result Conversion

`RedisExecCommand` returns results through the existing `QueryResult` shape where it
fits (status string, array, bulk string), with an optional Redis-specific structured
field for nested replies. Typed reads (`RedisGetKey`) return purpose-built structs
serialized to JSON, not `QueryResult`, because the per-type shapes differ.

## Frontend Design

### Connection Dialog

Extend `ConnectionDialog.jsx`:

- Add `<option value="redis">Redis</option>` to the kind selector.
- `switchConnectionKind` adds a redis branch: default port `6379`, fields = host, port,
  username (ACL, optional), password, default DB index (0–15), TLS toggle. No
  SSH/cluster/sentinel controls for now.
- Displayed URL renders `redis://host:port/db` (and `rediss://` when TLS is on).
- Saved via the existing store; `kind = "redis"`. A redis-appropriate icon is used.

### Explorer

For redis connections, `DatabaseExplorer.jsx` branches:

- Top-level shows logical DBs `db0`–`db15` with key counts (hide empty DBs behind a
  toggle, or show all — match ARDM by showing all 16).
- Expanding a DB shows a key tree built by splitting key names on `:` into folders
  (`redisClient.js` `buildKeyTree`). A filter box at the top sets the `SCAN MATCH`
  pattern; keys are lazy-loaded with a "load more" affordance driven by the SCAN cursor.
- Clicking a key (leaf) opens a Redis key tab (see below). Right-click offers
  rename / delete / set TTL / reload.

### Key Viewer Tab

New `RedisKeyViewer.jsx`, opened as a tab (reusing the tab model like `TableViewer`):

- Header: key name, type badge, TTL (editable, with persist/expire controls), memory
  size, and reload / rename / delete buttons.
- Body renders per type:
  - `string`: value editor with a format/decode dropdown (calls `RedisDecodeValue`).
  - `hash`: field/value table with add/edit/delete rows.
  - `list`: index/value table with push (head/tail), edit, remove.
  - `set`: member list with add/remove.
  - `zset`: member/score table, sorted, with add/edit/remove.
  - `stream`: entries table (ID + field map), with add/delete entry.
- All write affordances are disabled when the connection is read-only.

### Console (CLI)

`SqlEditor.jsx` branches on `connectionKind === 'redis'`:

- Renders a CLI-style console: a command input line and an output log, rather than the
  SQL/Monaco-SQL editor.
- Submitting a line calls `RedisExecCommand`; output is appended to the log with the
  command echoed. Basic command-name autocomplete comes from a static command list in
  `redisClient.js`.

### Server View (P5)

New `RedisServerView.jsx`, openable from the explorer's connection node:

- `INFO` overview cards (memory, clients, ops/sec, uptime, keyspace).
- Pub/Sub panel: subscribe to channels/patterns, live message log via Wails events.
- Slow log table and client list table.

### lib + bridge

- `frontend/src/lib/redisClient.js`: pure functions — `buildKeyTree`, command
  classification/autocomplete, value formatting helpers, key-count parsing — for unit
  tests (analogous to `mongoQuery.js`).
- `frontend/src/lib/bridge.js`: wrap the new App methods for Wails mode and provide
  browser-dev mock data (a `mock-redis-1` connection with sample keys of each type).

## Safety and Error Handling

- Read-only connections block all mutating Redis commands at the App layer before they
  reach the server (string/hash/list/set/zset/stream writes, rename, delete, TTL set,
  and write commands typed into the CLI).
- Destructive CLI commands (`FLUSHALL`, `FLUSHDB`, `KEYS *` on large DBs) should warn or
  be guarded; `FLUSHALL`/`FLUSHDB` require confirmation.
- `SCAN` is always used for browsing; `KEYS` is never used for tree population.
- Subscriptions and any long-lived goroutines respect context cancellation and are torn
  down on disconnect.
- Decode failures degrade gracefully to the previous/raw format.

## Testing Strategy

Backend tests (no live Redis required for most):

- Existing MySQL and MongoDB backend tests continue to pass unchanged.
- Connection URI/option building (TLS, default DB, auth).
- `RedisDecodeValue` for every format using real sample byte fixtures (compressed and
  serialized payloads), including failure fallbacks.
- Key-tree-relevant parsing and read-only command rejection logic.
- Where feasible, gate live-server tests behind an env var so CI without Redis stays green.

Frontend tests (`frontend/scripts/unit-tests.mjs`, plain Node assert):

- Existing tests continue to pass.
- `buildKeyTree` folds `:`-namespaced keys correctly and is stable.
- Redis command classification/autocomplete.
- `ConnectionDialog` switches into redis mode (port 6379, fields) without breaking
  MySQL/MongoDB modes.
- Explorer renders redis DBs and opens a key tab; key viewer renders each type.

Manual verification:

- Re-run a known MySQL flow and a MongoDB flow to confirm non-regression.
- Connect to a local Redis, browse keys, open one key of each type, edit values, set
  TTL, rename, delete.
- Run CLI commands; verify read-only blocking.
- Open the server view; check INFO, subscribe to a channel and receive a message, view
  slow log and clients.

## Implementation Notes

Staged implementation (built in one effort, sequenced for control):

1. Add `go-redis` + decoder deps; scaffold `internal/driver/redis` and register it.
2. P1: connection options, `FetchDatabases` (db0–db15 + counts), `RedisScanKeys`;
   connection dialog redis mode; explorer redis tree.
3. P2: `RedisGetKey` + per-type writes + key ops; `RedisKeyViewer` for the five types.
4. P3: `RedisExecCommand`; CLI console branch in the console tab.
5. P4: stream type in `RedisGetKey`/viewer; `RedisDecodeValue` + format dropdown.
6. P5: `RedisServerInfo`/`RedisSlowLog`/`RedisClientList`/Pub-Sub; `RedisServerView`.
7. Backend + frontend tests at each phase; full regression pass before completion.
