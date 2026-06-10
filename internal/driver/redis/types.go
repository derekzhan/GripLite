// Package redis implements the GripLite DatabaseDriver for Redis servers.
//
// Unlike the SQL/Mongo drivers, Redis exposes a key/value surface rather than
// tables. Key browsing and value operations are surfaced through dedicated
// App methods (RedisScanKeys, RedisGetKey, …) instead of FetchTables, because
// Redis key spaces can be far larger than a relational schema.
package redis

// KeyMeta describes a single Redis key's lightweight metadata.
type KeyMeta struct {
	Key       string `json:"key"`
	Type      string `json:"type"` // string|hash|list|set|zset|stream|none
	TTL       int64  `json:"ttl"`  // seconds; -1 no expire; -2 key missing
	SizeBytes int64  `json:"sizeBytes"`
	Encoding  string `json:"encoding"`
}

// ScanResult is one page of a SCAN cursor walk.
type ScanResult struct {
	Keys       []string `json:"keys"`
	NextCursor uint64   `json:"nextCursor"`
}

// HashField is one field/value pair of a hash. Both values are base64 of the
// raw bytes so binary-safe payloads survive the JSON IPC bridge.
type HashField struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

// ZMember is one member/score pair of a sorted set.
type ZMember struct {
	Member string  `json:"member"`
	Score  float64 `json:"score"`
}

// StreamEntry is one entry of a stream.
type StreamEntry struct {
	ID     string            `json:"id"`
	Fields map[string]string `json:"fields"`
}

// KeyValue is the typed read payload returned by GetKey. Only the field
// matching Meta.Type is populated. String/list/set/hash values are base64.
type KeyValue struct {
	Meta      KeyMeta       `json:"meta"`
	Str       string        `json:"str,omitempty"`
	Hash      []HashField   `json:"hash,omitempty"`
	List      []string      `json:"list,omitempty"`
	Set       []string      `json:"set,omitempty"`
	ZSet      []ZMember     `json:"zset,omitempty"`
	Stream    []StreamEntry `json:"stream,omitempty"`
	Truncated bool          `json:"truncated,omitempty"`
}

// CommandResult is the rendered reply of a CLI command.
type CommandResult struct {
	OK    bool   `json:"ok"`
	Text  string `json:"text"`
	Error string `json:"error,omitempty"`
}

// DecodeResult is the output of DecodeValue for a chosen format.
type DecodeResult struct {
	OK    bool   `json:"ok"`
	Text  string `json:"text"`
	Note  string `json:"note,omitempty"`
	Error string `json:"error,omitempty"`
}

// SlowLogEntry is one SLOWLOG GET row.
type SlowLogEntry struct {
	ID       int64    `json:"id"`
	Time     int64    `json:"time"` // unix seconds
	Duration int64    `json:"duration"` // microseconds
	Args     []string `json:"args"`
	Client   string   `json:"client"`
	Name     string   `json:"name"`
}

// PubSubMessage is one message forwarded from a subscription.
type PubSubMessage struct {
	Channel string `json:"channel"`
	Pattern string `json:"pattern,omitempty"`
	Payload string `json:"payload"`
}

// listScanLimit caps how many elements GetKey materialises for collection
// types so a single huge key cannot exhaust memory or stall the IPC bridge.
const listScanLimit = 1000
