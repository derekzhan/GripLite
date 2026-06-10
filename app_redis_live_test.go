package main

import (
	"context"
	"encoding/base64"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"GripLite/internal/driver"
)

// liveRedisApp builds an App wired to a real Redis server described by the
// GRIPLITE_REDIS_* environment variables. It skips when GRIPLITE_REDIS_HOST is
// unset so CI without a Redis stays green.
//
//	GRIPLITE_REDIS_HOST, GRIPLITE_REDIS_PORT, GRIPLITE_REDIS_DB,
//	GRIPLITE_REDIS_PASSWORD, GRIPLITE_REDIS_USER
func liveRedisApp(t *testing.T) (*App, string, int) {
	t.Helper()
	host := os.Getenv("GRIPLITE_REDIS_HOST")
	if host == "" {
		t.Skip("set GRIPLITE_REDIS_HOST to run live Redis tests")
	}
	port, _ := strconv.Atoi(os.Getenv("GRIPLITE_REDIS_PORT"))
	if port == 0 {
		port = 6379
	}
	db := os.Getenv("GRIPLITE_REDIS_DB")
	if db == "" {
		db = "0"
	}
	dbIdx, _ := strconv.Atoi(db)

	a := NewApp()
	a.ctx = context.Background()
	cfg := driver.ConnectionConfig{
		ID:       "live-redis",
		Name:     "live",
		Kind:     driver.DriverRedis,
		Host:     host,
		Port:     port,
		Database: db,
		Username: os.Getenv("GRIPLITE_REDIS_USER"),
		Password: os.Getenv("GRIPLITE_REDIS_PASSWORD"),
	}
	if _, err := a.AddConnection(cfg); err != nil {
		t.Fatalf("AddConnection: %v", err)
	}
	return a, "live-redis", dbIdx
}

func enc(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
func dec(t *testing.T, s string) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("base64 decode %q: %v", s, err)
	}
	return string(b)
}

func TestLiveRedisEndToEnd(t *testing.T) {
	a, conn, db := liveRedisApp(t)

	const pfx = "griplite:test:"
	// Clean up any prior test keys.
	cleanup := func() {
		res, _ := a.RedisScanKeys(conn, db, pfx+"*", 0, 1000)
		for _, k := range res.Keys {
			_ = a.RedisDeleteKey(conn, db, k)
		}
	}
	cleanup()
	defer cleanup()

	t.Run("databases", func(t *testing.T) {
		dbs, err := a.RedisDatabases(conn)
		if err != nil {
			t.Fatal(err)
		}
		want := "db" + strconv.Itoa(db)
		found := false
		for _, d := range dbs {
			if d == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("databases %v missing %s", dbs, want)
		}
		if _, err := a.RedisDBSize(conn, db); err != nil {
			t.Fatalf("DBSize: %v", err)
		}
	})

	t.Run("string+ttl", func(t *testing.T) {
		key := pfx + "str"
		if err := a.RedisSetString(conn, db, key, enc("hello world"), 0); err != nil {
			t.Fatal(err)
		}
		kv, err := a.RedisGetKey(conn, db, key)
		if err != nil {
			t.Fatal(err)
		}
		if kv.Meta.Type != "string" {
			t.Fatalf("type = %q", kv.Meta.Type)
		}
		if got := dec(t, kv.Str); got != "hello world" {
			t.Fatalf("value = %q", got)
		}
		if err := a.RedisSetTTL(conn, db, key, 100); err != nil {
			t.Fatal(err)
		}
		kv, _ = a.RedisGetKey(conn, db, key)
		if kv.Meta.TTL <= 0 || kv.Meta.TTL > 100 {
			t.Fatalf("ttl after set = %d, want ~100", kv.Meta.TTL)
		}
		if err := a.RedisSetTTL(conn, db, key, 0); err != nil {
			t.Fatal(err)
		}
		kv, _ = a.RedisGetKey(conn, db, key)
		if kv.Meta.TTL != -1 {
			t.Fatalf("ttl after persist = %d, want -1", kv.Meta.TTL)
		}
	})

	t.Run("hash", func(t *testing.T) {
		key := pfx + "hash"
		if err := a.RedisHashSet(conn, db, key, enc("name"), enc("Alice")); err != nil {
			t.Fatal(err)
		}
		if err := a.RedisHashSet(conn, db, key, enc("age"), enc("30")); err != nil {
			t.Fatal(err)
		}
		kv, err := a.RedisGetKey(conn, db, key)
		if err != nil || kv.Meta.Type != "hash" {
			t.Fatalf("get hash: %v type=%s", err, kv.Meta.Type)
		}
		got := map[string]string{}
		for _, hf := range kv.Hash {
			got[dec(t, hf.Field)] = dec(t, hf.Value)
		}
		if got["name"] != "Alice" || got["age"] != "30" {
			t.Fatalf("hash = %v", got)
		}
		if err := a.RedisHashDelete(conn, db, key, enc("age")); err != nil {
			t.Fatal(err)
		}
		kv, _ = a.RedisGetKey(conn, db, key)
		if len(kv.Hash) != 1 {
			t.Fatalf("after hdel len = %d", len(kv.Hash))
		}
	})

	t.Run("list", func(t *testing.T) {
		key := pfx + "list"
		if err := a.RedisListPush(conn, db, key, enc("a"), false); err != nil {
			t.Fatal(err)
		}
		if err := a.RedisListPush(conn, db, key, enc("b"), false); err != nil {
			t.Fatal(err)
		}
		if err := a.RedisListPush(conn, db, key, enc("head"), true); err != nil {
			t.Fatal(err)
		}
		kv, err := a.RedisGetKey(conn, db, key)
		if err != nil || kv.Meta.Type != "list" {
			t.Fatalf("get list: %v type=%s", err, kv.Meta.Type)
		}
		got := make([]string, len(kv.List))
		for i, v := range kv.List {
			got[i] = dec(t, v)
		}
		if strings.Join(got, ",") != "head,a,b" {
			t.Fatalf("list = %v", got)
		}
		if err := a.RedisListSet(conn, db, key, 1, enc("A")); err != nil {
			t.Fatal(err)
		}
		kv, _ = a.RedisGetKey(conn, db, key)
		if dec(t, kv.List[1]) != "A" {
			t.Fatalf("lset failed: %s", dec(t, kv.List[1]))
		}
	})

	t.Run("set", func(t *testing.T) {
		key := pfx + "set"
		for _, m := range []string{"red", "green", "blue"} {
			if err := a.RedisSetAdd(conn, db, key, enc(m)); err != nil {
				t.Fatal(err)
			}
		}
		kv, err := a.RedisGetKey(conn, db, key)
		if err != nil || kv.Meta.Type != "set" || len(kv.Set) != 3 {
			t.Fatalf("get set: %v type=%s len=%d", err, kv.Meta.Type, len(kv.Set))
		}
		if err := a.RedisSetRemove(conn, db, key, enc("green")); err != nil {
			t.Fatal(err)
		}
		kv, _ = a.RedisGetKey(conn, db, key)
		if len(kv.Set) != 2 {
			t.Fatalf("after srem len = %d", len(kv.Set))
		}
	})

	t.Run("zset", func(t *testing.T) {
		key := pfx + "zset"
		if err := a.RedisZAdd(conn, db, key, enc("alice"), 100); err != nil {
			t.Fatal(err)
		}
		if err := a.RedisZAdd(conn, db, key, enc("bob"), 80); err != nil {
			t.Fatal(err)
		}
		kv, err := a.RedisGetKey(conn, db, key)
		if err != nil || kv.Meta.Type != "zset" || len(kv.ZSet) != 2 {
			t.Fatalf("get zset: %v", err)
		}
		// ZRANGE is ascending by score: bob(80) then alice(100).
		if dec(t, kv.ZSet[0].Member) != "bob" || kv.ZSet[0].Score != 80 {
			t.Fatalf("zset order = %+v", kv.ZSet)
		}
		if err := a.RedisZRemove(conn, db, key, enc("bob")); err != nil {
			t.Fatal(err)
		}
		kv, _ = a.RedisGetKey(conn, db, key)
		if len(kv.ZSet) != 1 {
			t.Fatalf("after zrem len = %d", len(kv.ZSet))
		}
	})

	t.Run("stream", func(t *testing.T) {
		key := pfx + "stream"
		id, err := a.RedisStreamAdd(conn, db, key, "*", map[string]string{"kind": "login", "user": "alice"})
		if err != nil || id == "" {
			t.Fatalf("xadd: %v id=%q", err, id)
		}
		kv, err := a.RedisGetKey(conn, db, key)
		if err != nil || kv.Meta.Type != "stream" || len(kv.Stream) != 1 {
			t.Fatalf("get stream: %v len=%d", err, len(kv.Stream))
		}
		if kv.Stream[0].Fields["kind"] != "login" {
			t.Fatalf("stream fields = %v", kv.Stream[0].Fields)
		}
		if err := a.RedisStreamDelete(conn, db, key, id); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("scan+rename+delete", func(t *testing.T) {
		key := pfx + "rename:src"
		dst := pfx + "rename:dst"
		if err := a.RedisSetString(conn, db, key, enc("v"), 0); err != nil {
			t.Fatal(err)
		}
		res, err := a.RedisScanKeys(conn, db, pfx+"rename:*", 0, 100)
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Keys) == 0 {
			t.Fatal("scan found no rename keys")
		}
		if err := a.RedisRenameKey(conn, db, key, dst); err != nil {
			t.Fatal(err)
		}
		kv, _ := a.RedisGetKey(conn, db, dst)
		if dec(t, kv.Str) != "v" {
			t.Fatalf("rename target value = %q", dec(t, kv.Str))
		}
		if err := a.RedisDeleteKey(conn, db, dst); err != nil {
			t.Fatal(err)
		}
		kv, _ = a.RedisGetKey(conn, db, dst)
		if kv.Meta.Type != "none" {
			t.Fatalf("after delete type = %q", kv.Meta.Type)
		}
	})

	t.Run("cli", func(t *testing.T) {
		r, err := a.RedisExecCommand(conn, db, "PING")
		if err != nil || !r.OK || !strings.Contains(strings.ToUpper(r.Text), "PONG") {
			t.Fatalf("PING: %v %+v", err, r)
		}
		key := pfx + "cli"
		if r, err := a.RedisExecCommand(conn, db, "SET "+key+" clival"); err != nil || !r.OK {
			t.Fatalf("SET: %v %+v", err, r)
		}
		r, err = a.RedisExecCommand(conn, db, "GET "+key)
		if err != nil || !r.OK || r.Text != "clival" {
			t.Fatalf("GET: %v %+v", err, r)
		}
	})

	t.Run("server", func(t *testing.T) {
		info, err := a.RedisServerInfo(conn)
		if err != nil {
			t.Fatal(err)
		}
		if info["Server"]["redis_version"] == "" {
			t.Fatalf("no redis_version in INFO: %v", info["Server"])
		}
		if _, err := a.RedisSlowLog(conn, 16); err != nil {
			t.Fatalf("slowlog: %v", err)
		}
		if _, err := a.RedisClientList(conn); err != nil {
			t.Fatalf("clientlist: %v", err)
		}
	})

	t.Run("pubsub", func(t *testing.T) {
		ch := pfx + "channel"
		subID, err := a.RedisSubscribe(conn, []string{ch}, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer a.RedisUnsubscribe(subID)
		// Give the subscription a moment to register before publishing.
		time.Sleep(200 * time.Millisecond)
		if r, err := a.RedisExecCommand(conn, db, "PUBLISH "+ch+" hi"); err != nil || !r.OK {
			t.Fatalf("publish: %v %+v", err, r)
		}
		// We can't read the Wails event bus here, but a successful subscribe +
		// publish round-trip without error exercises the path. Receipt is
		// verified manually in the running app.
	})
}
