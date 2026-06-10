/**
 * redisClient.js — pure helpers for the Redis UI.
 *
 * No Wails / DOM dependencies so these can be unit-tested in plain Node.
 */

/**
 * buildKeyTree folds a flat list of keys into a namespace tree by splitting on
 * a separator (default ':'). Folder nodes carry { label, path, children };
 * leaf nodes carry { label, key, leaf: true }. Folders sort before leaves,
 * alphabetically within each group.
 *
 * @param {string[]} keys
 * @param {string} separator
 * @returns {Array}
 */
export function buildKeyTree(keys, separator = ':') {
  const root = { children: new Map(), leaves: [] }

  for (const key of keys) {
    const parts = separator ? key.split(separator) : [key]
    let node = root
    let path = ''
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      path = path ? `${path}${separator}${part}` : part
      const isLast = i === parts.length - 1
      if (isLast) {
        node.leaves.push({ label: part, key, leaf: true })
      } else {
        if (!node.children.has(part)) {
          node.children.set(part, { label: part, path, children: new Map(), leaves: [] })
        }
        node = node.children.get(part)
      }
    }
  }

  const materialize = (node) => {
    const folders = [...node.children.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((f) => ({ label: f.label, path: f.path, children: materialize(f) }))
    const leaves = [...node.leaves].sort((a, b) => a.label.localeCompare(b.label))
    return [...folders, ...leaves]
  }

  return materialize(root)
}

/**
 * REDIS_COMMANDS — a representative command list for CLI autocomplete.
 */
export const REDIS_COMMANDS = [
  'GET', 'SET', 'DEL', 'EXISTS', 'EXPIRE', 'TTL', 'PERSIST', 'TYPE', 'KEYS', 'SCAN',
  'RENAME', 'INCR', 'DECR', 'APPEND', 'STRLEN', 'GETSET', 'MGET', 'MSET',
  'HGET', 'HSET', 'HDEL', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS',
  'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LRANGE', 'LLEN', 'LSET', 'LREM', 'LINDEX',
  'SADD', 'SREM', 'SMEMBERS', 'SCARD', 'SISMEMBER', 'SPOP',
  'ZADD', 'ZREM', 'ZRANGE', 'ZRANGEBYSCORE', 'ZCARD', 'ZSCORE', 'ZRANK',
  'XADD', 'XRANGE', 'XLEN', 'XDEL', 'XREAD',
  'PING', 'INFO', 'DBSIZE', 'SELECT', 'FLUSHDB', 'FLUSHALL', 'CONFIG', 'CLIENT',
  'SUBSCRIBE', 'PUBLISH', 'SLOWLOG', 'MEMORY', 'OBJECT',
]

const WRITE_COMMANDS = new Set([
  'SET', 'SETNX', 'SETEX', 'PSETEX', 'SETRANGE', 'APPEND', 'GETSET', 'GETDEL',
  'INCR', 'INCRBY', 'INCRBYFLOAT', 'DECR', 'DECRBY', 'MSET', 'MSETNX',
  'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT', 'PERSIST',
  'RENAME', 'RENAMENX', 'MOVE', 'COPY', 'RESTORE', 'FLUSHDB', 'FLUSHALL', 'SWAPDB',
  'HSET', 'HSETNX', 'HMSET', 'HDEL', 'HINCRBY', 'HINCRBYFLOAT',
  'LPUSH', 'RPUSH', 'LPUSHX', 'RPUSHX', 'LPOP', 'RPOP', 'LSET', 'LREM', 'LINSERT',
  'LTRIM', 'RPOPLPUSH', 'LMOVE', 'SADD', 'SREM', 'SPOP', 'SMOVE',
  'SINTERSTORE', 'SUNIONSTORE', 'SDIFFSTORE', 'ZADD', 'ZREM', 'ZINCRBY',
  'ZPOPMIN', 'ZPOPMAX', 'ZREMRANGEBYRANK', 'ZREMRANGEBYSCORE', 'ZREMRANGEBYLEX',
  'XADD', 'XDEL', 'XTRIM', 'XSETID', 'XGROUP', 'XACK', 'XCLAIM',
  'GEOADD', 'PFADD', 'PFMERGE', 'SETBIT', 'BITOP', 'BITFIELD', 'PUBLISH',
])

/**
 * classifyRedisCommand parses a command line into its (upper-cased) name and
 * whether it mutates data/server state.
 *
 * @param {string} raw
 * @returns {{ name: string, isWrite: boolean }}
 */
export function classifyRedisCommand(raw) {
  const name = (String(raw).trim().split(/\s+/)[0] || '').toUpperCase()
  return { name, isWrite: WRITE_COMMANDS.has(name) }
}

/**
 * DECODE_FORMATS — display/decoding formats offered in the value viewer.
 * Each entry has an id (sent to the backend) and a human label.
 */
export const DECODE_FORMATS = [
  { id: 'text', label: 'Text' },
  { id: 'json', label: 'JSON' },
  { id: 'hex', label: 'Hex' },
  { id: 'binary', label: 'Binary' },
  { id: 'gzip', label: 'GZip' },
  { id: 'deflate', label: 'Deflate' },
  { id: 'brotli', label: 'Brotli' },
  { id: 'lz4', label: 'LZ4' },
  { id: 'snappy', label: 'Snappy' },
  { id: 'zstd', label: 'ZSTD' },
  { id: 'msgpack', label: 'Msgpack' },
  { id: 'protobuf', label: 'Protobuf' },
  { id: 'pickle', label: 'Pickle' },
  { id: 'php', label: 'PHP Serialize' },
]

/** formatTTL renders a TTL in seconds as a friendly string. */
export function formatTTL(ttl) {
  if (ttl === -1) return 'No expiry'
  if (ttl === -2) return 'Key missing'
  if (ttl < 60) return `${ttl}s`
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m ${ttl % 60}s`
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h ${Math.floor((ttl % 3600) / 60)}m`
  return `${Math.floor(ttl / 86400)}d ${Math.floor((ttl % 86400) / 3600)}h`
}
