package redis

import (
	"context"
	"fmt"
	"strings"
)

// splitCommand splits a raw command line into arguments, honouring single and
// double quotes so values containing spaces survive (e.g. SET a "hello world").
func splitCommand(raw string) []string {
	var args []string
	var cur strings.Builder
	inSingle, inDouble, has := false, false, false
	flush := func() {
		if has {
			args = append(args, cur.String())
			cur.Reset()
			has = false
		}
	}
	for _, r := range raw {
		switch {
		case inSingle:
			if r == '\'' {
				inSingle = false
			} else {
				cur.WriteRune(r)
			}
			has = true
		case inDouble:
			if r == '"' {
				inDouble = false
			} else {
				cur.WriteRune(r)
			}
			has = true
		case r == '\'':
			inSingle = true
			has = true
		case r == '"':
			inDouble = true
			has = true
		case r == ' ' || r == '\t' || r == '\n' || r == '\r':
			flush()
		default:
			cur.WriteRune(r)
			has = true
		}
	}
	flush()
	return args
}

// writeCommands is the set of Redis commands that mutate data or server state.
// Used to block writes on read-only connections.
var writeCommands = map[string]bool{
	"SET": true, "SETNX": true, "SETEX": true, "PSETEX": true, "SETRANGE": true,
	"APPEND": true, "GETSET": true, "GETDEL": true, "INCR": true, "INCRBY": true,
	"INCRBYFLOAT": true, "DECR": true, "DECRBY": true, "MSET": true, "MSETNX": true,
	"DEL": true, "UNLINK": true, "EXPIRE": true, "PEXPIRE": true, "EXPIREAT": true,
	"PEXPIREAT": true, "PERSIST": true, "RENAME": true, "RENAMENX": true, "MOVE": true,
	"COPY": true, "RESTORE": true, "FLUSHDB": true, "FLUSHALL": true, "SWAPDB": true,
	"HSET": true, "HSETNX": true, "HMSET": true, "HDEL": true, "HINCRBY": true,
	"HINCRBYFLOAT": true, "LPUSH": true, "RPUSH": true, "LPUSHX": true, "RPUSHX": true,
	"LPOP": true, "RPOP": true, "LSET": true, "LREM": true, "LINSERT": true,
	"LTRIM": true, "RPOPLPUSH": true, "LMOVE": true, "SADD": true, "SREM": true,
	"SPOP": true, "SMOVE": true, "SINTERSTORE": true, "SUNIONSTORE": true,
	"SDIFFSTORE": true, "ZADD": true, "ZREM": true, "ZINCRBY": true, "ZPOPMIN": true,
	"ZPOPMAX": true, "ZREMRANGEBYRANK": true, "ZREMRANGEBYSCORE": true,
	"ZREMRANGEBYLEX": true, "ZRANGESTORE": true, "XADD": true, "XDEL": true,
	"XTRIM": true, "XSETID": true, "XGROUP": true, "XACK": true, "XCLAIM": true,
	"XAUTOCLAIM": true, "GEOADD": true, "PFADD": true, "PFMERGE": true,
	"SETBIT": true, "BITOP": true, "BITFIELD": true, "PUBLISH": true,
}

// IsWriteCommand reports whether the named command (case-insensitive) mutates
// data or server state.
func IsWriteCommand(name string) bool {
	return writeCommands[strings.ToUpper(strings.TrimSpace(name))]
}

// ExecCommand runs a raw command line against a logical DB and renders the
// reply as text. Parsing errors and Redis errors are returned in the result.
func (d *Driver) ExecCommand(ctx context.Context, db int, raw string) (CommandResult, error) {
	args := splitCommand(raw)
	if len(args) == 0 {
		return CommandResult{OK: false, Error: "empty command"}, nil
	}
	c, err := d.clientForDB(db)
	if err != nil {
		return CommandResult{}, err
	}
	ifaceArgs := make([]any, len(args))
	for i, a := range args {
		ifaceArgs[i] = a
	}
	res, err := c.Do(ctx, ifaceArgs...).Result()
	if err != nil {
		return CommandResult{OK: false, Error: err.Error()}, nil
	}
	return CommandResult{OK: true, Text: renderReply(res, 0)}, nil
}

// renderReply formats a go-redis reply value into human-readable text.
func renderReply(v any, depth int) string {
	switch t := v.(type) {
	case nil:
		return "(nil)"
	case string:
		return t
	case int64:
		return fmt.Sprintf("(integer) %d", t)
	case []any:
		if len(t) == 0 {
			return "(empty array)"
		}
		var b strings.Builder
		for i, item := range t {
			if i > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(fmt.Sprintf("%d) %s", i+1, renderReply(item, depth+1)))
		}
		return b.String()
	case map[any]any:
		var b strings.Builder
		i := 0
		for k, val := range t {
			if i > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(fmt.Sprintf("%v => %s", k, renderReply(val, depth+1)))
			i++
		}
		return b.String()
	default:
		return fmt.Sprintf("%v", t)
	}
}
