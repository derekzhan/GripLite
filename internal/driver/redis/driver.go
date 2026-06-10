package redis

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"GripLite/internal/driver"
	goredis "github.com/redis/go-redis/v9"
)

// Driver is the Redis implementation of driver.DatabaseDriver.
//
// A base client is opened against the connection's default DB. Because Redis
// logical DBs are selected per-connection, browsing an arbitrary DB index uses
// a small cache of per-DB clients (clientForDB) rather than mutating the base
// client's selected DB underneath in-flight commands.
type Driver struct {
	cfg     driver.ConnectionConfig
	base    *goredis.Options
	client  *goredis.Client
	version string

	mu      sync.Mutex
	dbCache map[int]*goredis.Client
}

func init() {
	driver.Register(driver.DriverRedis, func(cfg driver.ConnectionConfig) (driver.DatabaseDriver, error) {
		return &Driver{cfg: cfg, dbCache: map[int]*goredis.Client{}}, nil
	})
}

// Kind reports the driver kind.
func (d *Driver) Kind() driver.DriverKind { return driver.DriverRedis }

// ServerVersion returns the redis_version reported during Connect.
func (d *Driver) ServerVersion() string { return d.version }

// Connect dials the server, verifies reachability with PING, and records the
// server version from INFO server.
func (d *Driver) Connect(ctx context.Context) error {
	if d.client != nil {
		return nil
	}
	o, err := buildOptions(d.cfg)
	if err != nil {
		return err
	}
	d.base = o
	d.client = goredis.NewClient(o)
	if err := d.client.Ping(ctx).Err(); err != nil {
		_ = d.client.Close()
		d.client = nil
		return fmt.Errorf("redis ping: %w", err)
	}
	if info, err := d.client.Info(ctx, "server").Result(); err == nil {
		d.version = parseRedisVersion(info)
	}
	return nil
}

// Close releases the base client and any cached per-DB clients.
func (d *Driver) Close(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, c := range d.dbCache {
		_ = c.Close()
	}
	d.dbCache = map[int]*goredis.Client{}
	if d.client != nil {
		err := d.client.Close()
		d.client = nil
		return err
	}
	return nil
}

// Ping verifies the server is reachable.
func (d *Driver) Ping(ctx context.Context) error {
	if d.client == nil {
		return fmt.Errorf("redis: not connected")
	}
	return d.client.Ping(ctx).Err()
}

// clientForDB returns a client bound to the given logical DB index, reusing
// the base client when the index matches the connection default.
func (d *Driver) clientForDB(db int) (*goredis.Client, error) {
	if d.base == nil {
		return nil, fmt.Errorf("redis: not connected")
	}
	if db == d.base.DB {
		return d.client, nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if c, ok := d.dbCache[db]; ok {
		return c, nil
	}
	opt := *d.base
	opt.DB = db
	c := goredis.NewClient(&opt)
	d.dbCache[db] = c
	return c, nil
}

// DatabaseCount returns the number of logical DBs (CONFIG GET databases),
// falling back to the Redis default of 16.
func (d *Driver) DatabaseCount(ctx context.Context) int {
	if d.client == nil {
		return defaultDatabaseCount
	}
	res, err := d.client.ConfigGet(ctx, "databases").Result()
	if err != nil {
		return defaultDatabaseCount
	}
	if v, ok := res["databases"]; ok {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return defaultDatabaseCount
}

// FetchDatabases returns logical DB names db0..dbN-1.
func (d *Driver) FetchDatabases(ctx context.Context) ([]string, error) {
	n := d.DatabaseCount(ctx)
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, "db"+strconv.Itoa(i))
	}
	return out, nil
}

// DBSize returns the number of keys in a logical DB.
func (d *Driver) DBSize(ctx context.Context, db int) (int64, error) {
	c, err := d.clientForDB(db)
	if err != nil {
		return 0, err
	}
	return c.DBSize(ctx).Result()
}

// FetchTables is not meaningful for Redis; key browsing uses ScanKeys instead.
func (d *Driver) FetchTables(ctx context.Context, dbName string) ([]driver.TableInfo, error) {
	return nil, nil
}

// FetchTableDetail is not meaningful for Redis.
func (d *Driver) FetchTableDetail(ctx context.Context, dbName, tableName string) (*driver.TableDetail, error) {
	return nil, fmt.Errorf("redis: table detail not supported")
}

// ExecuteQuery is not used for Redis; the CLI console uses ExecCommand.
func (d *Driver) ExecuteQuery(ctx context.Context, query string) (*driver.ResultSet, error) {
	return nil, fmt.Errorf("redis: use RedisExecCommand for command execution")
}

// ExecuteQueryOnDB is not used for Redis.
func (d *Driver) ExecuteQueryOnDB(ctx context.Context, dbName, query string) (*driver.ResultSet, error) {
	return nil, fmt.Errorf("redis: use RedisExecCommand for command execution")
}

// parseRedisVersion extracts redis_version from INFO server output.
func parseRedisVersion(info string) string {
	for _, line := range strings.Split(info, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "redis_version:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "redis_version:"))
		}
	}
	return ""
}

// dbIndexFromName parses "db3" → 3. Returns 0 on malformed input.
func dbIndexFromName(name string) int {
	return parseDBIndex(strings.TrimPrefix(name, "db"))
}
