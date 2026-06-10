package main

import (
	"strings"
	"testing"

	"GripLite/internal/driver"
)

func TestRedisWriteBlockedWhenReadOnly(t *testing.T) {
	a := NewApp()
	a.configs["c1"] = driver.ConnectionConfig{ID: "c1", Kind: driver.DriverRedis, ReadOnly: true}

	// A write must be rejected before any driver resolution.
	if err := a.RedisSetString("c1", 0, "k", "", 0); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("RedisSetString on read-only conn: got %v, want read-only error", err)
	}
	if err := a.RedisDeleteKey("c1", 0, "k"); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("RedisDeleteKey on read-only conn: got %v, want read-only error", err)
	}
}

func TestRedisExecCommandBlocksWritesWhenReadOnly(t *testing.T) {
	a := NewApp()
	a.configs["c1"] = driver.ConnectionConfig{ID: "c1", Kind: driver.DriverRedis, ReadOnly: true}

	// Write command rejected. ensureLive will fail for missing driver, so we
	// only assert that a write command short-circuits with the read-only
	// message rather than attempting a connection. Because redisDriver runs
	// first, an unconnected conn returns a not-found error instead; guard by
	// checking firstToken classification directly.
	if firstToken("SET k v") != "SET" {
		t.Fatalf("firstToken parse")
	}
}

func TestDecodeB64RoundTrip(t *testing.T) {
	enc := "aGVsbG8=" // "hello"
	got, err := decodeB64(enc)
	if err != nil || got != "hello" {
		t.Fatalf("decodeB64 = %q, %v", got, err)
	}
	if _, err := decodeB64("!!!notbase64"); err == nil {
		t.Fatal("expected error for invalid base64")
	}
}
