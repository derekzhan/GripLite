package redis

import (
	"context"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// SetString sets a string value. ttlSeconds <= 0 means no expiry.
func (d *Driver) SetString(ctx context.Context, db int, key, value string, ttlSeconds int64) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	var exp time.Duration
	if ttlSeconds > 0 {
		exp = time.Duration(ttlSeconds) * time.Second
	}
	return c.Set(ctx, key, value, exp).Err()
}

// HashSet sets one hash field.
func (d *Driver) HashSet(ctx context.Context, db int, key, field, value string) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	return c.HSet(ctx, key, field, value).Err()
}

// HashDelete removes one hash field.
func (d *Driver) HashDelete(ctx context.Context, db int, key, field string) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	return c.HDel(ctx, key, field).Err()
}

// ListSet overwrites the element at index.
func (d *Driver) ListSet(ctx context.Context, db int, key string, index int64, value string) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	return c.LSet(ctx, key, index, value).Err()
}

// ListPush pushes an element to the head (left) or tail.
func (d *Driver) ListPush(ctx context.Context, db int, key, value string, left bool) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	if left {
		return c.LPush(ctx, key, value).Err()
	}
	return c.RPush(ctx, key, value).Err()
}

// ListRemove removes up to count occurrences of value (LREM semantics).
func (d *Driver) ListRemove(ctx context.Context, db int, key string, count int64, value string) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	return c.LRem(ctx, key, count, value).Err()
}

// SetAdd adds a member to a set.
func (d *Driver) SetAdd(ctx context.Context, db int, key, member string) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	return c.SAdd(ctx, key, member).Err()
}

// SetRemove removes a member from a set.
func (d *Driver) SetRemove(ctx context.Context, db int, key, member string) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	return c.SRem(ctx, key, member).Err()
}

// ZAdd adds or updates a sorted-set member's score.
func (d *Driver) ZAdd(ctx context.Context, db int, key, member string, score float64) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	return c.ZAdd(ctx, key, goredis.Z{Score: score, Member: member}).Err()
}

// ZRemove removes a sorted-set member.
func (d *Driver) ZRemove(ctx context.Context, db int, key, member string) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	return c.ZRem(ctx, key, member).Err()
}

// RenameKey renames a key (RENAME).
func (d *Driver) RenameKey(ctx context.Context, db int, oldKey, newKey string) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	return c.Rename(ctx, oldKey, newKey).Err()
}

// DeleteKey deletes a key.
func (d *Driver) DeleteKey(ctx context.Context, db int, key string) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	return c.Del(ctx, key).Err()
}

// SetTTL sets a key's TTL in seconds; ttlSeconds <= 0 persists (removes expiry).
func (d *Driver) SetTTL(ctx context.Context, db int, key string, ttlSeconds int64) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	if ttlSeconds <= 0 {
		return c.Persist(ctx, key).Err()
	}
	return c.Expire(ctx, key, time.Duration(ttlSeconds)*time.Second).Err()
}
