package redis

import (
	"context"
	"fmt"

	goredis "github.com/redis/go-redis/v9"
)

// readStream materialises up to listScanLimit stream entries via XRANGE.
func readStream(ctx context.Context, c *goredis.Client, key string) ([]StreamEntry, error) {
	msgs, err := c.XRangeN(ctx, key, "-", "+", listScanLimit).Result()
	if err != nil {
		return nil, err
	}
	out := make([]StreamEntry, 0, len(msgs))
	for _, m := range msgs {
		fields := make(map[string]string, len(m.Values))
		for f, v := range m.Values {
			fields[f] = fmt.Sprintf("%v", v)
		}
		out = append(out, StreamEntry{ID: m.ID, Fields: fields})
	}
	return out, nil
}

// StreamAdd appends an entry. id "*" lets the server assign the ID.
func (d *Driver) StreamAdd(ctx context.Context, db int, key, id string, fields map[string]any) (string, error) {
	c, err := d.clientForDB(db)
	if err != nil {
		return "", err
	}
	if id == "" {
		id = "*"
	}
	return c.XAdd(ctx, &goredis.XAddArgs{Stream: key, ID: id, Values: fields}).Result()
}

// StreamDelete removes an entry by ID.
func (d *Driver) StreamDelete(ctx context.Context, db int, key, id string) error {
	c, err := d.clientForDB(db)
	if err != nil {
		return err
	}
	return c.XDel(ctx, key, id).Err()
}
