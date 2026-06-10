package redis

import "context"

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
