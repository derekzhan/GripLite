package redis

import (
	"crypto/tls"
	"strconv"
	"time"

	"GripLite/internal/driver"
	goredis "github.com/redis/go-redis/v9"
)

// defaultDatabaseCount is the Redis default when CONFIG GET databases is
// unavailable (e.g. the command is restricted).
const defaultDatabaseCount = 16

// buildOptions translates a driver.ConnectionConfig into go-redis options.
// The DB index is parsed from cfg.Database (Redis uses numeric logical DBs);
// an empty or non-numeric value falls back to DB 0.
func buildOptions(cfg driver.ConnectionConfig) (*goredis.Options, error) {
	db := parseDBIndex(cfg.Database)
	o := &goredis.Options{
		Addr:     cfg.Host + ":" + strconv.Itoa(cfg.Port),
		Username: cfg.Username,
		Password: cfg.Password,
		DB:       db,
	}
	if cfg.ConnectTimeout > 0 {
		o.DialTimeout = cfg.ConnectTimeout
	} else {
		o.DialTimeout = 10 * time.Second
	}
	if cfg.TLS {
		o.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: cfg.Host}
	}
	return o, nil
}

// parseDBIndex returns the numeric logical DB index from a string, defaulting
// to 0 when empty or invalid.
func parseDBIndex(s string) int {
	if s == "" {
		return 0
	}
	if n, err := strconv.Atoi(s); err == nil && n >= 0 {
		return n
	}
	return 0
}
