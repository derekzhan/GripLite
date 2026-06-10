# Redis Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Redis support to GripLite (connection, key browsing, all 6 types with editing, TTL/rename/delete, CLI console, full value decoding, and server tooling) inspired by Another Redis Desktop Manager, using GripLite's existing driver registry and `kind`-branching patterns.

**Architecture:** New `internal/driver/redis` package registered with the driver registry (like `internal/driver/mongodb`). Redis-specific operations are exposed as dedicated `App` methods (like `ApplyMongoChanges`) rather than forced through `FetchTables`. Frontend branches on `connectionKind === 'redis'` in `ConnectionDialog`, `DatabaseExplorer`, and the console, plus new `RedisKeyViewer` and `RedisServerView` components. Pure logic lives in `frontend/src/lib/redisClient.js` and is unit-tested.

**Tech Stack:** Go + `github.com/redis/go-redis/v9`; decoders via `klauspost/compress` (present), `andybalholm/brotli`, `pierrec/lz4/v4`, `vmihailenco/msgpack/v5`; React + Wails IPC.

---

## Conventions

- Backend tests: `go test ./...`. Frontend tests: `cd frontend && npm test` (runs `node scripts/unit-tests.mjs`).
- Live-Redis tests are gated behind `GRIPLITE_REDIS_ADDR`; skip when unset so CI stays green.
- All IPC byte payloads are base64 strings.
- Commit after each task with the message shown.
- After backend signature changes, regenerate Wails bindings (or hand-write the additions in `frontend/wailsjs/go/main/App.{js,d.ts}` to match existing style).

## Shared Backend Contracts (defined once, used throughout)

These Go types live in `internal/driver/redis/types.go` and are returned (JSON-tagged) to the frontend.

```go
type KeyMeta struct {
	Key      string `json:"key"`
	Type     string `json:"type"`     // string|hash|list|set|zset|stream|none
	TTL      int64  `json:"ttl"`      // seconds; -1 no expire; -2 missing
	SizeBytes int64 `json:"sizeBytes"` // MEMORY USAGE, 0 if unavailable
	Encoding string `json:"encoding"`
}

type ScanResult struct {
	Keys       []string `json:"keys"`
	NextCursor uint64   `json:"nextCursor"`
}

// KeyValue is the typed read payload. Only the field matching Type is populated.
type KeyValue struct {
	Meta    KeyMeta             `json:"meta"`
	Str     string              `json:"str,omitempty"`     // base64 of raw bytes
	Hash    []HashField         `json:"hash,omitempty"`
	List    []string            `json:"list,omitempty"`    // base64 elements
	Set     []string            `json:"set,omitempty"`     // base64 members
	ZSet    []ZMember           `json:"zset,omitempty"`
	Stream  []StreamEntry       `json:"stream,omitempty"`
}

type HashField struct{ Field, Value string `json:"-"` } // Field/Value base64; see json tags below
type ZMember struct{ Member string `json:"member"`; Score float64 `json:"score"` }
type StreamEntry struct{ ID string `json:"id"`; Fields map[string]string `json:"fields"` }

type CommandResult struct {
	OK     bool   `json:"ok"`
	Text   string `json:"text"`   // human-rendered reply
	Error  string `json:"error,omitempty"`
}

type DecodeResult struct {
	OK    bool   `json:"ok"`
	Text  string `json:"text"`
	Note  string `json:"note,omitempty"`  // e.g. "best-effort protobuf"
	Error string `json:"error,omitempty"`
}
```

(`HashField` actually uses `Field string json:"field"` and `Value string json:"value"`, both base64; the struct tag note above is shorthand.)

---

## Phase 0 — Dependencies & Driver Scaffold

### Task 0.1: Add Go dependencies

**Files:**
- Modify: `go.mod`, `go.sum`

- [ ] **Step 1:** Add deps

```bash
go get github.com/redis/go-redis/v9@latest
go get github.com/andybalholm/brotli@latest
go get github.com/pierrec/lz4/v4@latest
go get github.com/vmihailenco/msgpack/v5@latest
go mod tidy
```

- [ ] **Step 2:** Verify build still green: `go build ./...` → Expected: success.
- [ ] **Step 3:** Commit

```bash
git add go.mod go.sum && git commit -m "build: add go-redis and value-decoder deps"
```

### Task 0.2: Register DriverRedis kind

**Files:**
- Modify: `internal/driver/types.go` (the `DriverKind` const block near line 30)
- Test: `internal/driver/types_test.go` (create if absent)

- [ ] **Step 1: Failing test**

```go
func TestDriverRedisKindRegistered(t *testing.T) {
	if DriverRedis != "redis" { t.Fatalf("want redis, got %q", DriverRedis) }
}
```

- [ ] **Step 2:** Run `go test ./internal/driver/ -run TestDriverRedisKind` → FAIL (undefined `DriverRedis`).
- [ ] **Step 3:** Add to the const block:

```go
DriverRedis DriverKind = "redis"
```

- [ ] **Step 4:** Run test → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(driver): add DriverRedis kind"`.

### Task 0.3: Driver skeleton + registry

**Files:**
- Create: `internal/driver/redis/driver.go`, `internal/driver/redis/types.go`
- Test: `internal/driver/redis/driver_test.go`

- [ ] **Step 1:** Create `types.go` with the structs from "Shared Backend Contracts".
- [ ] **Step 2: Failing test** in `driver_test.go`:

```go
func TestKindIsRedis(t *testing.T) {
	d := &Driver{}
	if d.Kind() != driver.DriverRedis { t.Fatalf("got %v", d.Kind()) }
}
```

- [ ] **Step 3:** Create `driver.go` skeleton:

```go
package redis

import (
	"context"
	"crypto/tls"
	"fmt"

	"GripLite/internal/driver"
	goredis "github.com/redis/go-redis/v9"
)

type Driver struct {
	cfg    driver.ConnectionConfig
	client *goredis.Client
	version string
}

func init() { driver.Register(driver.DriverRedis, func(cfg driver.ConnectionConfig) (driver.DatabaseDriver, error) { return &Driver{cfg: cfg}, nil }) }

func (d *Driver) Kind() driver.DriverKind { return driver.DriverRedis }
func (d *Driver) ServerVersion() string   { return d.version }
```

- [ ] **Step 4:** Run `go test ./internal/driver/redis/` → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): driver skeleton + registry"`.

### Task 0.4: Blank-import in app.go

**Files:**
- Modify: `app.go` (import block near line 24, alongside `_ "GripLite/internal/driver/mongodb"`)

- [ ] **Step 1:** Add `_ "GripLite/internal/driver/redis"`.
- [ ] **Step 2:** `go build ./...` → success.
- [ ] **Step 3:** Commit `git commit -am "feat(redis): wire driver registration into app"`.

---

## Phase 1 — Connection & Key Browsing

### Task 1.1: Connect/Close/Ping + options

**Files:**
- Modify: `internal/driver/redis/driver.go`
- Create: `internal/driver/redis/options.go`
- Test: `internal/driver/redis/options_test.go`

- [ ] **Step 1: Failing test** — `buildOptions` produces address/DB/TLS from a config:

```go
func TestBuildOptionsDefaults(t *testing.T) {
	o, err := buildOptions(driver.ConnectionConfig{Host: "localhost", Port: 6379, Database: "3", Username: "u", Password: "p"})
	if err != nil { t.Fatal(err) }
	if o.Addr != "localhost:6379" { t.Fatalf("addr %q", o.Addr) }
	if o.DB != 3 { t.Fatalf("db %d", o.DB) }
	if o.Username != "u" || o.Password != "p" { t.Fatal("auth") }
}

func TestBuildOptionsTLS(t *testing.T) {
	o, _ := buildOptions(driver.ConnectionConfig{Host: "h", Port: 6380, TLS: true})
	if o.TLSConfig == nil { t.Fatal("want TLS config") }
}
```

- [ ] **Step 2:** Run → FAIL (undefined `buildOptions`).
- [ ] **Step 3:** Implement `options.go`:

```go
package redis

import (
	"crypto/tls"
	"strconv"

	"GripLite/internal/driver"
	goredis "github.com/redis/go-redis/v9"
)

func buildOptions(cfg driver.ConnectionConfig) (*goredis.Options, error) {
	db := 0
	if cfg.Database != "" { if n, err := strconv.Atoi(cfg.Database); err == nil { db = n } }
	o := &goredis.Options{
		Addr:     cfg.Host + ":" + strconv.Itoa(cfg.Port),
		Username: cfg.Username,
		Password: cfg.Password,
		DB:       db,
	}
	if cfg.TLS { o.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: cfg.Host} }
	return o, nil
}
```

(Confirm exact `ConnectionConfig` field names in `internal/driver/types.go` — `Host`, `Port`, `Username`, `Password`, `Database`, `TLS` — and adjust if they differ.)

- [ ] **Step 4:** Implement `Connect`/`Close`/`Ping` in `driver.go`:

```go
func (d *Driver) Connect(ctx context.Context) error {
	o, err := buildOptions(d.cfg)
	if err != nil { return err }
	d.client = goredis.NewClient(o)
	if err := d.client.Ping(ctx).Err(); err != nil { return fmt.Errorf("redis ping: %w", err) }
	if info, err := d.client.Info(ctx, "server").Result(); err == nil { d.version = parseRedisVersion(info) }
	return nil
}
func (d *Driver) Close() error { if d.client != nil { return d.client.Close() }; return nil }
func (d *Driver) Ping(ctx context.Context) error { return d.client.Ping(ctx).Err() }
```

Add `parseRedisVersion(info string) string` (scan for `redis_version:` line).

- [ ] **Step 5:** Run unit tests → PASS. Commit `git commit -am "feat(redis): connect/close/ping + options"`.

### Task 1.2: FetchDatabases returns db0..dbN with counts

**Files:**
- Modify: `internal/driver/redis/driver.go`
- Test: `internal/driver/redis/driver_test.go` (live-gated)

- [ ] **Step 1: Failing test** (live-gated helper `liveDriver(t)` that skips when `GRIPLITE_REDIS_ADDR` unset):

```go
func TestFetchDatabasesLive(t *testing.T) {
	d := liveDriver(t)
	dbs, err := d.FetchDatabases(context.Background())
	if err != nil { t.Fatal(err) }
	if len(dbs) < 1 { t.Fatal("want >=1 db") }
}
```

- [ ] **Step 2:** Run → FAIL (method undefined).
- [ ] **Step 3:** Implement: read `CONFIG GET databases` (fallback 16), build `[]driver.DatabaseInfo` named `db0`..`dbN-1`; for each, `SELECT` is not needed — use a pipeline of `DBSIZE` per index via separate clients or `client.Do(ctx, "DBSIZE")` after `SELECT`. Simpler: return names only here; counts are fetched lazily by the explorer via `RedisDBSize`. Implement `FetchDatabases` returning names + a `RedisDBSize(ctx, db)` helper.
- [ ] **Step 4:** Run live test (with local redis) → PASS; without env → SKIP.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): FetchDatabases db0..dbN"`.

### Task 1.3: Scan keys

**Files:**
- Create: `internal/driver/redis/keys.go`
- Test: `internal/driver/redis/keys_test.go` (live-gated)

- [ ] **Step 1: Failing live test:** seed `t:1`,`t:2`; `ScanKeys(ctx, db, "t:*", 0, 100)` returns both.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `func (d *Driver) ScanKeys(ctx context.Context, db int, pattern string, cursor uint64, count int64) (ScanResult, error)` using a DB-scoped client (`d.clientForDB(db)`), `SCAN cursor MATCH pattern COUNT count`. Add `clientForDB` that returns a client with the right `DB` (cache per-db clients in a map guarded by a mutex, created from the base options).
- [ ] **Step 4:** Run live → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): SCAN-based key browsing"`.

### Task 1.4: App methods — RedisScanKeys, RedisDBSize, RedisDatabases

**Files:**
- Create: `app_redis.go` (Redis App methods grouped here, like Mongo lives in mongo paths)
- Test: `app_redis_test.go`

- [ ] **Step 1:** Implement App wrappers that resolve the driver and type-assert to `*redis.Driver` (or a `RedisDriver` interface declared in the redis package + asserted here):

```go
func (a *App) RedisScanKeys(connID string, db int, pattern string, cursor uint64, count int64) (redis.ScanResult, error) {
	drv, err := a.ensureLive(connID)
	if err != nil { return redis.ScanResult{}, err }
	rd, ok := drv.(*redis.Driver)
	if !ok { return redis.ScanResult{}, fmt.Errorf("connection %s is not redis", connID) }
	if pattern == "" { pattern = "*" }
	return rd.ScanKeys(a.ctx, db, pattern, cursor, count)
}
```

- [ ] **Step 2:** Add `RedisDatabases(connID)` and `RedisDBSize(connID, db)` similarly.
- [ ] **Step 3:** Build `go build ./...` → success.
- [ ] **Step 4:** Commit `git commit -am "feat(redis): app methods for db list + key scan"`.

### Task 1.5: Wails bindings for Phase-1 methods

**Files:**
- Modify: `frontend/wailsjs/go/main/App.js`, `frontend/wailsjs/go/main/App.d.ts`, `frontend/wailsjs/go/models.ts`

- [ ] **Step 1:** Regenerate bindings (`wails generate module`) or hand-add `RedisScanKeys`, `RedisDatabases`, `RedisDBSize` and the `redis.ScanResult` model, matching existing style.
- [ ] **Step 2:** Commit `git commit -am "chore(redis): wails bindings for phase 1"`.

### Task 1.6: bridge.js wrappers + mocks

**Files:**
- Modify: `frontend/src/lib/bridge.js`

- [ ] **Step 1:** Add `redisScanKeys`, `redisDatabases`, `redisDBSize` following the `isWails()` dynamic-import pattern, with browser mocks returning a `mock-redis-1` keyset (keys like `user:1`, `user:2`, `cache:home`, plus one of each type for later phases).
- [ ] **Step 2:** Commit `git commit -am "feat(redis): bridge wrappers + browser mocks (phase 1)"`.

### Task 1.7: redisClient.js — buildKeyTree (pure, TDD)

**Files:**
- Create: `frontend/src/lib/redisClient.js`
- Test: add cases to `frontend/scripts/unit-tests.mjs`

- [ ] **Step 1: Failing test** in `unit-tests.mjs`:

```js
import { buildKeyTree } from '../src/lib/redisClient.js'
function testBuildKeyTreeFoldsNamespaces() {
  const tree = buildKeyTree(['user:1', 'user:2', 'cache:home'], ':')
  assert.equal(tree.length, 2) // 'user' folder + 'cache' folder
  const user = tree.find((n) => n.label === 'user')
  assert.equal(user.children.length, 2)
  assert.ok(user.children.every((c) => c.leaf))
}
```

- [ ] **Step 2:** Run `cd frontend && npm test` → FAIL (module/function missing).
- [ ] **Step 3:** Implement `buildKeyTree(keys, separator=':')`: split each key by separator, build nested folder nodes `{ label, path, children }` and leaf nodes `{ label, key, leaf: true }`; folders sorted before leaves, alpha within group. Keep it pure.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): buildKeyTree pure helper + test"`.

### Task 1.8: ConnectionDialog redis mode

**Files:**
- Modify: `frontend/src/components/ConnectionDialog.jsx`
- Test: add `testConnectionDialogSupportsRedis` to `unit-tests.mjs` (string/regex assertions, matching existing dialog tests)

- [ ] **Step 1: Failing test:** assert source contains `value="redis"` option and that `switchConnectionKind` sets port 6379 for redis.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add `<option value="redis">Redis</option>`; extend `switchConnectionKind` with a redis branch (default port 6379, clears mongo/mysql-only advanced params, TLS optional). Add a default-DB-index field (0–15) shown only for redis. URL preview: `redis://`/`rediss://`.
- [ ] **Step 4:** Run → PASS; `ReadLints` clean.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): connection dialog redis mode"`.

### Task 1.9: DatabaseExplorer redis tree

**Files:**
- Modify: `frontend/src/components/DatabaseExplorer.jsx`
- Test: `testExplorerRendersRedisDatabases` in `unit-tests.mjs` (regex/string assertions on the source branches, consistent with existing explorer tests)

- [ ] **Step 1: Failing test:** assert explorer branches on `kind === 'redis'` and renders db nodes + a key-filter input.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add redis branch: top-level db0..dbN (via `redisDatabases`/`redisDBSize`), expanding a db calls `redisScanKeys` and renders `buildKeyTree` output; a filter input sets the SCAN pattern; a "Load more" node appears when `nextCursor !== 0`. Clicking a leaf opens a redis key tab (new tab type `rediskey`, dispatched up via the existing open-tab callback).
- [ ] **Step 4:** Run → PASS; lints clean.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): explorer key tree with SCAN paging"`.

### Task 1.10: App.jsx tab plumbing for redis keys

**Files:**
- Modify: `frontend/src/App.jsx`

- [ ] **Step 1:** Add a `rediskey` tab type that renders `RedisKeyViewer` (stub for now returning a placeholder); propagate `connectionKind`. Add redis icon mapping.
- [ ] **Step 2:** `cd frontend && npm run build` → success.
- [ ] **Step 3:** Commit `git commit -am "feat(redis): app tab plumbing for key viewer"`.

---

## Phase 2 — Core Types + Key Ops

### Task 2.1: RedisGetKey (string/hash/list/set/zset)

**Files:**
- Modify: `internal/driver/redis/keys.go`
- Test: `internal/driver/redis/keys_test.go` (live-gated, seed one key per type)

- [ ] **Step 1: Failing live test** per type: set a string/hash/list/set/zset, call `GetKey`, assert `Meta.Type` and the populated typed field. Strings/members returned base64.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `func (d *Driver) GetKey(ctx, db int, key string) (KeyValue, error)`: `TYPE`, `TTL`, `MEMORY USAGE`(best-effort), then dispatch: `GET`; `HGETALL`; `LRANGE 0 -1` (cap N, note truncation); `SMEMBERS`; `ZRANGE WITHSCORES`. Base64-encode raw bytes.
- [ ] **Step 4:** Run live → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): GetKey for 5 core types"`.

### Task 2.2: Write ops (per type) + key ops

**Files:**
- Create: `internal/driver/redis/write.go`
- Test: `internal/driver/redis/write_test.go` (live-gated)

- [ ] **Step 1: Failing live tests:** set string; hset/hdel; lset/lpush/lrem; sadd/srem; zadd/zrem; rename; delete; expire/persist. Each verifies via a follow-up read.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement methods (`SetString`, `HashSet`, `HashDelete`, `ListSet`, `ListPush`, `ListRemove`, `SetAdd`, `SetRemove`, `ZAdd`, `ZRemove`, `RenameKey`, `DeleteKey`, `SetTTL`). Each takes base64 inputs where values are bytes.
- [ ] **Step 4:** Run live → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): write ops for 5 types + key ops"`.

### Task 2.3: Read-only enforcement

**Files:**
- Modify: `app_redis.go`
- Test: `app_redis_test.go`

- [ ] **Step 1: Failing test:** a read-only connection rejects `RedisSetString` with an error and does not call the driver.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** In each mutating App method, check the saved connection's `read_only` flag (same source MySQL/Mongo use) and return an error before dispatching.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): enforce read-only on writes"`.

### Task 2.4: App methods for GetKey + writes + bindings + bridge

**Files:**
- Modify: `app_redis.go`, `frontend/wailsjs/go/main/App.{js,d.ts}`, `frontend/wailsjs/go/models.ts`, `frontend/src/lib/bridge.js`

- [ ] **Step 1:** Add `RedisGetKey` + all write App methods; regenerate/extend bindings; add bridge wrappers + mock implementations that mutate the in-memory mock keyset.
- [ ] **Step 2:** `go build ./...` and `cd frontend && npm run build` → success.
- [ ] **Step 3:** Commit `git commit -am "feat(redis): app methods + bindings + bridge for key ops"`.

### Task 2.5: RedisKeyViewer component (5 types)

**Files:**
- Create: `frontend/src/components/RedisKeyViewer.jsx`
- Test: `testRedisKeyViewerRendersEachType` in `unit-tests.mjs` (string/regex assertions on the source for the type switch + write handlers + read-only gating)

- [ ] **Step 1: Failing test:** assert the component switches on `value.meta.type` and wires `redisSetString`/`redisHashSet`/etc., and disables writes when `readOnly`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement header (key, type badge, TTL editor, size, reload/rename/delete) and per-type bodies (string editor; hash/list/zset tables with add/edit/delete; set list). Decode dropdown stub wired to a no-op until Phase 4. Values base64-decoded for display.
- [ ] **Step 4:** Run → PASS; build + lints clean.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): key viewer for 5 core types + key ops"`.

---

## Phase 3 — CLI Console

### Task 3.1: RedisExecCommand (backend)

**Files:**
- Create: `internal/driver/redis/command.go`
- Test: `internal/driver/redis/command_test.go`

- [ ] **Step 1: Failing tests:** `splitCommand("SET a \"hello world\"")` → `["SET","a","hello world"]` (pure, quote-aware); live test: `ExecCommand(ctx, 0, "PING")` → `OK`/`PONG`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement quote-aware `splitCommand` (pure) and `func (d *Driver) ExecCommand(ctx, db int, raw string) (CommandResult, error)` using `client.Do(ctx, args...)` and a reply renderer (status/int/bulk/array → text).
- [ ] **Step 4:** Run → PASS (pure) / live PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): ExecCommand + quote-aware split"`.

### Task 3.2: App method + read-only guard for write commands

**Files:**
- Modify: `app_redis.go`
- Test: `app_redis_test.go`

- [ ] **Step 1: Failing test:** read-only connection rejects `RedisExecCommand(.., "SET k v")` but allows `GET`/`PING` (maintain a set of write command names in the redis package; expose `IsWriteCommand(name)`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `IsWriteCommand` (pure, table of write commands) + App guard. Add `RedisExecCommand` App method.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): exec command app method + write guard"`.

### Task 3.3: redisClient command classification (pure, TDD)

**Files:**
- Modify: `frontend/src/lib/redisClient.js`
- Test: `unit-tests.mjs`

- [ ] **Step 1: Failing test:** `classifyRedisCommand("get foo")` → `{ name: 'GET', isWrite: false }`; `"set a b"` → `isWrite: true`; autocomplete list contains common commands.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `REDIS_COMMANDS` list + `classifyRedisCommand`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): command classification helper"`.

### Task 3.4: Console branch (CLI UI)

**Files:**
- Modify: `frontend/src/components/SqlEditor.jsx` (or a new `RedisConsole.jsx` rendered by the console tab when `connectionKind==='redis'`)
- Modify: `frontend/src/lib/bridge.js` (add `redisExecCommand` + mock)
- Test: `testRedisConsoleBranch` in `unit-tests.mjs`

- [ ] **Step 1: Failing test:** assert the console renders a CLI input + output log for redis and calls `redisExecCommand` on submit.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement a `RedisConsole` (input line + scrollback log, command echo, history via up/down) and branch the console tab to it for redis. Add bridge wrapper + mock.
- [ ] **Step 4:** Run → PASS; build + lints clean.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): CLI console"`.

---

## Phase 4 — Stream Type + Value Decoding

### Task 4.1: Stream in GetKey + write

**Files:**
- Modify: `internal/driver/redis/keys.go`, `internal/driver/redis/write.go`
- Test: live-gated tests

- [ ] **Step 1: Failing live test:** `XADD` an entry, `GetKey` returns `Type=="stream"` and the entry in `Stream`; `StreamAdd`/`StreamDelete` work.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add `XRANGE - +` (cap N) to `GetKey` for streams; add `StreamAdd(ctx, db, key, id, fields)` (`XADD`), `StreamDelete` (`XDEL`).
- [ ] **Step 4:** Run live → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): stream type read/write"`.

### Task 4.2: RedisDecodeValue (pure decoders, TDD)

**Files:**
- Create: `internal/driver/redis/decode.go`
- Test: `internal/driver/redis/decode_test.go`

- [ ] **Step 1: Failing tests** with fixtures for each format. Example:

```go
func TestDecodeGzipJSON(t *testing.T) {
	var b bytes.Buffer
	w := gzip.NewWriter(&b); w.Write([]byte(`{"a":1}`)); w.Close()
	r := DecodeValue(b.Bytes(), "gzip")
	if !r.OK || !strings.Contains(r.Text, `"a"`) { t.Fatalf("%+v", r) }
}
func TestDecodeHex(t *testing.T) {
	r := DecodeValue([]byte{0x01, 0xff}, "hex")
	if r.Text != "01ff" { t.Fatalf("%q", r.Text) }
}
```

Add analogous tests for `text`, `json`, `binary`, `deflate`, `brotli`, `lz4`, `snappy`, `zstd`, `msgpack`, `php`, and best-effort `protobuf`/`pickle` (assert `OK` + `Note`).

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `func DecodeValue(data []byte, format string) DecodeResult` dispatching per format using `klauspost/compress` (gzip/flate/zstd/snappy), `andybalholm/brotli`, `pierrec/lz4/v4`, `vmihailenco/msgpack/v5`; `php` via a small serialize parser; `protobuf`/`pickle` best-effort with `Note`. Compression formats decode then pretty-print JSON if the result parses as JSON, else as text.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): value decoders (all formats)"`.

### Task 4.3: Decode App method + bridge + viewer dropdown

**Files:**
- Modify: `app_redis.go`, bindings, `frontend/src/lib/bridge.js`, `frontend/src/components/RedisKeyViewer.jsx`, `frontend/src/lib/redisClient.js`
- Test: `unit-tests.mjs` (`testRedisDecodeFormatsList`), `app_redis_test.go`

- [ ] **Step 1:** Add `RedisDecodeValue(base64, format)` App method (no connection needed) + `DECODE_FORMATS` list in `redisClient.js` (TDD the list). Wire the viewer's format dropdown to call `redisDecodeValue` and render the result, falling back on error.
- [ ] **Step 2:** Add stream rendering to the viewer.
- [ ] **Step 3:** Build + tests → success.
- [ ] **Step 4:** Commit `git commit -am "feat(redis): decode dropdown + stream viewer"`.

---

## Phase 5 — Server Tooling

### Task 5.1: INFO / SlowLog / ClientList (backend)

**Files:**
- Create: `internal/driver/redis/server.go`
- Test: `internal/driver/redis/server_test.go`

- [ ] **Step 1: Failing tests:** pure `parseInfo(raw)` returns sections→key/value map; live `ServerInfo`/`SlowLog`/`ClientList` return non-empty.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `parseInfo` (pure), `ServerInfo` (`INFO`), `SlowLog` (`SLOWLOG GET n`), `ClientList` (`CLIENT LIST`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): server info/slowlog/clientlist"`.

### Task 5.2: Pub/Sub streaming

**Files:**
- Create: `internal/driver/redis/pubsub.go`
- Modify: `app_redis.go`
- Test: `internal/driver/redis/pubsub_test.go` (live-gated)

- [ ] **Step 1: Failing live test:** subscribe to a channel, publish, receive the message on the Go channel returned by `Subscribe`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `Subscribe(ctx, channels) (<-chan Message, func() error)`. In `app_redis.go`, `RedisSubscribe` starts a goroutine forwarding messages via `runtime.EventsEmit("redis:message:"+subID, msg)`; `RedisUnsubscribe` cancels. Track subs per connection; tear down on disconnect/close.
- [ ] **Step 4:** Run live → PASS.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): pub/sub streaming via wails events"`.

### Task 5.3: App methods + bindings + bridge for server tooling

**Files:**
- Modify: `app_redis.go`, bindings, `frontend/src/lib/bridge.js`

- [ ] **Step 1:** Add `RedisServerInfo`, `RedisSlowLog`, `RedisClientList`, `RedisSubscribe`, `RedisUnsubscribe` App methods; bindings; bridge wrappers (+ `onRedisMessage(subID, handler)` using Wails `EventsOn`) + mocks.
- [ ] **Step 2:** Build → success.
- [ ] **Step 3:** Commit `git commit -am "feat(redis): app methods + bridge for server tooling"`.

### Task 5.4: RedisServerView component

**Files:**
- Create: `frontend/src/components/RedisServerView.jsx`
- Modify: `frontend/src/components/DatabaseExplorer.jsx` (open server view from connection node), `frontend/src/App.jsx` (new tab type `redisserver`)
- Test: `testRedisServerViewSections` in `unit-tests.mjs`

- [ ] **Step 1: Failing test:** assert the component renders INFO cards, a Pub/Sub panel calling `redisSubscribe`, slow log + client list tables.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the view; add explorer entry + app tab type.
- [ ] **Step 4:** Run → PASS; build + lints clean.
- [ ] **Step 5:** Commit `git commit -am "feat(redis): server view (info/pubsub/slowlog/clients)"`.

---

## Phase 6 — Final Verification

### Task 6.1: Full regression + build

- [ ] **Step 1:** `go test ./...` → all PASS (live-gated redis tests SKIP without env).
- [ ] **Step 2:** `cd frontend && npm test` → all PASS.
- [ ] **Step 3:** `cd frontend && npm run build` → success; `~/go/bin/wails build -platform darwin/arm64` → success.
- [ ] **Step 4:** Manual: connect to local redis, browse keys, open one key per type, edit/TTL/rename/delete, run CLI commands (verify read-only blocking), open server view, subscribe + publish, view slow log/clients. Re-run a MySQL and a MongoDB flow to confirm non-regression.
- [ ] **Step 5:** Commit any binding/lint fixes `git commit -am "test(redis): full regression pass"`.

---

## Self-Review Notes

- **Spec coverage:** P1 (1.1–1.10), P2 (2.1–2.5), P3 (3.1–3.4), P4 (4.1–4.3), P5 (5.1–5.4) — every spec section maps to tasks. Decoders: all formats in 4.2. Read-only: 2.3 + 3.2. Pub/Sub: 5.2.
- **Type consistency:** `KeyMeta`/`KeyValue`/`ScanResult`/`CommandResult`/`DecodeResult` defined once in `types.go`; App methods named `Redis*`; bridge wrappers `redis*` (camelCase).
- **Out of scope (P6 connection modes):** cluster/sentinel/SSH — not in any task by design.
- **Risk:** exact `ConnectionConfig` field names and the `ensureLive`/read-only accessor must be confirmed against current `app.go` during Task 1.1/2.3; adjust signatures accordingly.
