package main

import (
	"encoding/base64"
	"fmt"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	redisdrv "GripLite/internal/driver/redis"
	"github.com/google/uuid"
)

// redisDriver resolves a live Redis driver for the connection, returning an
// error if the connection is not Redis.
func (a *App) redisDriver(connID string) (*redisdrv.Driver, error) {
	drv, err := a.ensureLive(connID)
	if err != nil {
		return nil, err
	}
	rd, ok := drv.(*redisdrv.Driver)
	if !ok {
		return nil, fmt.Errorf("connection %q is not a Redis data source", connID)
	}
	return rd, nil
}

// requireWritable returns an error when the connection is in read-only mode.
func (a *App) requireWritable(connID string) error {
	a.mu.RLock()
	cfg, ok := a.configs[connID]
	a.mu.RUnlock()
	if ok && cfg.ReadOnly {
		return fmt.Errorf("connection is in read-only mode; write operations are blocked")
	}
	return nil
}

// decodeB64 decodes a base64 IPC payload into a raw string.
func decodeB64(s string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return "", fmt.Errorf("invalid base64 payload: %w", err)
	}
	return string(b), nil
}

// ── Browsing ─────────────────────────────────────────────────────────────────

// RedisDatabases returns logical DB names db0..dbN-1.
func (a *App) RedisDatabases(connID string) ([]string, error) {
	rd, err := a.redisDriver(connID)
	if err != nil {
		return nil, err
	}
	return rd.FetchDatabases(a.ctx)
}

// RedisDBSize returns the key count of a logical DB.
func (a *App) RedisDBSize(connID string, db int) (int64, error) {
	rd, err := a.redisDriver(connID)
	if err != nil {
		return 0, err
	}
	return rd.DBSize(a.ctx, db)
}

// RedisScanKeys walks one page of keys with a glob MATCH pattern.
func (a *App) RedisScanKeys(connID string, db int, pattern string, cursor uint64, count int64) (redisdrv.ScanResult, error) {
	rd, err := a.redisDriver(connID)
	if err != nil {
		return redisdrv.ScanResult{}, err
	}
	return rd.ScanKeys(a.ctx, db, pattern, cursor, count)
}

// RedisGetKey reads a key's metadata and typed value.
func (a *App) RedisGetKey(connID string, db int, key string) (redisdrv.KeyValue, error) {
	rd, err := a.redisDriver(connID)
	if err != nil {
		return redisdrv.KeyValue{}, err
	}
	return rd.GetKey(a.ctx, db, key)
}

// ── String / Hash / List / Set / ZSet writes ───────────────────────────────

// RedisSetString sets a string value (base64). ttl <= 0 means no expiry.
func (a *App) RedisSetString(connID string, db int, key, valueB64 string, ttl int64) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	value, err := decodeB64(valueB64)
	if err != nil {
		return err
	}
	return rd.SetString(a.ctx, db, key, value, ttl)
}

// RedisHashSet sets a hash field (field/value base64).
func (a *App) RedisHashSet(connID string, db int, key, fieldB64, valueB64 string) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	field, err := decodeB64(fieldB64)
	if err != nil {
		return err
	}
	value, err := decodeB64(valueB64)
	if err != nil {
		return err
	}
	return rd.HashSet(a.ctx, db, key, field, value)
}

// RedisHashDelete removes a hash field (base64).
func (a *App) RedisHashDelete(connID string, db int, key, fieldB64 string) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	field, err := decodeB64(fieldB64)
	if err != nil {
		return err
	}
	return rd.HashDelete(a.ctx, db, key, field)
}

// RedisListSet overwrites the element at index (value base64).
func (a *App) RedisListSet(connID string, db int, key string, index int64, valueB64 string) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	value, err := decodeB64(valueB64)
	if err != nil {
		return err
	}
	return rd.ListSet(a.ctx, db, key, index, value)
}

// RedisListPush pushes an element (value base64) to head (left) or tail.
func (a *App) RedisListPush(connID string, db int, key, valueB64 string, left bool) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	value, err := decodeB64(valueB64)
	if err != nil {
		return err
	}
	return rd.ListPush(a.ctx, db, key, value, left)
}

// RedisListRemove removes up to count occurrences of value (base64).
func (a *App) RedisListRemove(connID string, db int, key string, count int64, valueB64 string) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	value, err := decodeB64(valueB64)
	if err != nil {
		return err
	}
	return rd.ListRemove(a.ctx, db, key, count, value)
}

// RedisSetAdd adds a member (base64) to a set.
func (a *App) RedisSetAdd(connID string, db int, key, memberB64 string) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	member, err := decodeB64(memberB64)
	if err != nil {
		return err
	}
	return rd.SetAdd(a.ctx, db, key, member)
}

// RedisSetRemove removes a member (base64) from a set.
func (a *App) RedisSetRemove(connID string, db int, key, memberB64 string) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	member, err := decodeB64(memberB64)
	if err != nil {
		return err
	}
	return rd.SetRemove(a.ctx, db, key, member)
}

// RedisZAdd adds/updates a sorted-set member (base64) with a score.
func (a *App) RedisZAdd(connID string, db int, key, memberB64 string, score float64) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	member, err := decodeB64(memberB64)
	if err != nil {
		return err
	}
	return rd.ZAdd(a.ctx, db, key, member, score)
}

// RedisZRemove removes a sorted-set member (base64).
func (a *App) RedisZRemove(connID string, db int, key, memberB64 string) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	member, err := decodeB64(memberB64)
	if err != nil {
		return err
	}
	return rd.ZRemove(a.ctx, db, key, member)
}

// ── Stream writes ───────────────────────────────────────────────────────────

// RedisStreamAdd appends a stream entry. id "*" lets the server assign the ID.
func (a *App) RedisStreamAdd(connID string, db int, key, id string, fields map[string]string) (string, error) {
	if err := a.requireWritable(connID); err != nil {
		return "", err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return "", err
	}
	vals := make(map[string]any, len(fields))
	for k, v := range fields {
		vals[k] = v
	}
	return rd.StreamAdd(a.ctx, db, key, id, vals)
}

// RedisStreamDelete removes a stream entry by ID.
func (a *App) RedisStreamDelete(connID string, db int, key, id string) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	return rd.StreamDelete(a.ctx, db, key, id)
}

// ── Key operations ──────────────────────────────────────────────────────────

// RedisRenameKey renames a key.
func (a *App) RedisRenameKey(connID string, db int, oldKey, newKey string) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	return rd.RenameKey(a.ctx, db, oldKey, newKey)
}

// RedisDeleteKey deletes a key.
func (a *App) RedisDeleteKey(connID string, db int, key string) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	return rd.DeleteKey(a.ctx, db, key)
}

// RedisSetTTL sets a key's TTL in seconds; ttl <= 0 persists the key.
func (a *App) RedisSetTTL(connID string, db int, key string, ttl int64) error {
	if err := a.requireWritable(connID); err != nil {
		return err
	}
	rd, err := a.redisDriver(connID)
	if err != nil {
		return err
	}
	return rd.SetTTL(a.ctx, db, key, ttl)
}

// ── CLI console ─────────────────────────────────────────────────────────────

// RedisExecCommand runs a raw command line. Write commands are blocked on
// read-only connections.
func (a *App) RedisExecCommand(connID string, db int, raw string) (redisdrv.CommandResult, error) {
	rd, err := a.redisDriver(connID)
	if err != nil {
		return redisdrv.CommandResult{}, err
	}
	a.mu.RLock()
	cfg, ok := a.configs[connID]
	a.mu.RUnlock()
	if ok && cfg.ReadOnly {
		if name := firstToken(raw); redisdrv.IsWriteCommand(name) {
			return redisdrv.CommandResult{OK: false, Error: "connection is in read-only mode; write commands are blocked"}, nil
		}
	}
	return rd.ExecCommand(a.ctx, db, raw)
}

// firstToken returns the leading whitespace-delimited token of a command line.
func firstToken(raw string) string {
	for i := 0; i < len(raw); i++ {
		if raw[i] == ' ' || raw[i] == '\t' {
			return raw[:i]
		}
	}
	return raw
}

// ── Value decoding ──────────────────────────────────────────────────────────

// RedisDecodeValue renders a base64 payload in the requested display format.
func (a *App) RedisDecodeValue(dataB64, format string) redisdrv.DecodeResult {
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return redisdrv.DecodeResult{OK: false, Error: "invalid base64 payload"}
	}
	return redisdrv.DecodeValue(data, format)
}

// ── Server tooling ──────────────────────────────────────────────────────────

// RedisServerInfo returns parsed INFO sections.
func (a *App) RedisServerInfo(connID string) (map[string]map[string]string, error) {
	rd, err := a.redisDriver(connID)
	if err != nil {
		return nil, err
	}
	return rd.ServerInfo(a.ctx)
}

// RedisSlowLog returns recent slow-log entries.
func (a *App) RedisSlowLog(connID string, count int64) ([]redisdrv.SlowLogEntry, error) {
	rd, err := a.redisDriver(connID)
	if err != nil {
		return nil, err
	}
	return rd.SlowLog(a.ctx, count)
}

// RedisClientList returns connected clients (one raw line per client).
func (a *App) RedisClientList(connID string) ([]string, error) {
	rd, err := a.redisDriver(connID)
	if err != nil {
		return nil, err
	}
	return rd.ClientList(a.ctx)
}

// ── Pub/Sub ─────────────────────────────────────────────────────────────────

// RedisSubscribe subscribes to channels and/or glob patterns. It returns a
// subscription ID; messages are emitted to the frontend on the Wails event
// "redis:message:<subID>". Call RedisUnsubscribe to stop.
func (a *App) RedisSubscribe(connID string, channels, patterns []string) (string, error) {
	rd, err := a.redisDriver(connID)
	if err != nil {
		return "", err
	}
	sub, err := rd.Subscribe(a.ctx, channels, patterns)
	if err != nil {
		return "", err
	}
	subID := uuid.NewString()
	a.redisMu.Lock()
	a.redisSubs[subID] = sub
	a.redisMu.Unlock()

	go func() {
		event := "redis:message:" + subID
		for msg := range sub.Messages {
			wailsruntime.EventsEmit(a.ctx, event, msg)
		}
	}()
	return subID, nil
}

// RedisUnsubscribe stops a subscription started by RedisSubscribe.
func (a *App) RedisUnsubscribe(subID string) error {
	a.redisMu.Lock()
	sub, ok := a.redisSubs[subID]
	delete(a.redisSubs, subID)
	a.redisMu.Unlock()
	if !ok {
		return nil
	}
	return sub.Stop()
}
