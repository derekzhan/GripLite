package redis

import (
	"context"
	"encoding/base64"
	"fmt"
)

// b64 encodes raw bytes for binary-safe transport over the JSON IPC bridge.
func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

// GetKey reads a key's metadata and its typed value (only the field matching
// the type is populated). Collection types are capped at listScanLimit
// elements; Truncated reports when more data exists.
func (d *Driver) GetKey(ctx context.Context, db int, key string) (KeyValue, error) {
	c, err := d.clientForDB(db)
	if err != nil {
		return KeyValue{}, err
	}
	typ, err := c.Type(ctx, key).Result()
	if err != nil {
		return KeyValue{}, err
	}
	if typ == "none" {
		return KeyValue{Meta: KeyMeta{Key: key, Type: "none", TTL: -2}}, nil
	}
	meta := KeyMeta{Key: key, Type: typ, TTL: -1}
	if ttl, err := c.Do(ctx, "TTL", key).Int64(); err == nil {
		meta.TTL = ttl
	}
	if sz, err := c.MemoryUsage(ctx, key).Result(); err == nil {
		meta.SizeBytes = sz
	}
	if enc, err := c.ObjectEncoding(ctx, key).Result(); err == nil {
		meta.Encoding = enc
	}

	out := KeyValue{Meta: meta}
	switch typ {
	case "string":
		v, err := c.Get(ctx, key).Result()
		if err != nil {
			return KeyValue{}, err
		}
		out.Str = b64(v)
	case "hash":
		m, err := c.HGetAll(ctx, key).Result()
		if err != nil {
			return KeyValue{}, err
		}
		out.Hash = make([]HashField, 0, len(m))
		for f, v := range m {
			out.Hash = append(out.Hash, HashField{Field: b64(f), Value: b64(v)})
		}
	case "list":
		total, _ := c.LLen(ctx, key).Result()
		vals, err := c.LRange(ctx, key, 0, listScanLimit-1).Result()
		if err != nil {
			return KeyValue{}, err
		}
		out.List = make([]string, 0, len(vals))
		for _, v := range vals {
			out.List = append(out.List, b64(v))
		}
		out.Truncated = total > int64(len(vals))
	case "set":
		vals, err := c.SMembers(ctx, key).Result()
		if err != nil {
			return KeyValue{}, err
		}
		out.Truncated = len(vals) > listScanLimit
		if out.Truncated {
			vals = vals[:listScanLimit]
		}
		out.Set = make([]string, 0, len(vals))
		for _, v := range vals {
			out.Set = append(out.Set, b64(v))
		}
	case "zset":
		zs, err := c.ZRangeWithScores(ctx, key, 0, listScanLimit-1).Result()
		if err != nil {
			return KeyValue{}, err
		}
		total, _ := c.ZCard(ctx, key).Result()
		out.ZSet = make([]ZMember, 0, len(zs))
		for _, z := range zs {
			member, _ := z.Member.(string)
			out.ZSet = append(out.ZSet, ZMember{Member: b64(member), Score: z.Score})
		}
		out.Truncated = total > int64(len(zs))
	case "stream":
		entries, err := readStream(ctx, c, key)
		if err != nil {
			return KeyValue{}, err
		}
		out.Stream = entries
		if total, err := c.XLen(ctx, key).Result(); err == nil {
			out.Truncated = total > int64(len(entries))
		}
	default:
		return KeyValue{}, fmt.Errorf("redis: unsupported type %q", typ)
	}
	return out, nil
}

// ScanKeys walks one page of keys in a logical DB using SCAN (never KEYS, so
// large key spaces do not block the server). pattern is a glob MATCH; an empty
// pattern is treated as "*". count is a SCAN hint, not a hard limit.
func (d *Driver) ScanKeys(ctx context.Context, db int, pattern string, cursor uint64, count int64) (ScanResult, error) {
	c, err := d.clientForDB(db)
	if err != nil {
		return ScanResult{}, err
	}
	if pattern == "" {
		pattern = "*"
	}
	if count <= 0 {
		count = 200
	}
	keys, next, err := c.Scan(ctx, cursor, pattern, count).Result()
	if err != nil {
		return ScanResult{}, err
	}
	if keys == nil {
		keys = []string{}
	}
	return ScanResult{Keys: keys, NextCursor: next}, nil
}
