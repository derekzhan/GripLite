package redis

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/andybalholm/brotli"
	kpsnappy "github.com/klauspost/compress/snappy"
	"github.com/klauspost/compress/zstd"
	lz4 "github.com/pierrec/lz4/v4"
	"github.com/vmihailenco/msgpack/v5"
)

// DecodeValue renders raw bytes in the requested display format. Compression
// formats are decompressed then pretty-printed as JSON when the payload parses
// as JSON, otherwise as UTF-8 text. Protobuf and Pickle are best-effort
// structural decodes flagged via Note.
func DecodeValue(data []byte, format string) DecodeResult {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "", "text":
		return asText(data)
	case "json":
		return asJSON(data)
	case "hex":
		return DecodeResult{OK: true, Text: hex.EncodeToString(data)}
	case "binary":
		return DecodeResult{OK: true, Text: asBinary(data)}
	case "gzip":
		return decompress(data, "gzip", func(r io.Reader) (io.Reader, error) { return gzip.NewReader(r) })
	case "deflate":
		return decompress(data, "deflate", func(r io.Reader) (io.Reader, error) { return flate.NewReader(r), nil })
	case "brotli":
		return decompress(data, "brotli", func(r io.Reader) (io.Reader, error) { return brotli.NewReader(r), nil })
	case "lz4":
		return decompress(data, "lz4", func(r io.Reader) (io.Reader, error) { return lz4.NewReader(r), nil })
	case "snappy":
		return decompress(data, "snappy", func(r io.Reader) (io.Reader, error) { return kpsnappy.NewReader(r), nil })
	case "zstd":
		return decompress(data, "zstd", func(r io.Reader) (io.Reader, error) { return zstd.NewReader(r) })
	case "msgpack":
		return decodeMsgpack(data)
	case "php":
		return decodePHP(data)
	case "protobuf":
		return decodeProtobuf(data)
	case "pickle":
		return decodePickle(data)
	default:
		return DecodeResult{OK: false, Error: "unknown format: " + format}
	}
}

func asText(data []byte) DecodeResult {
	if !utf8.Valid(data) {
		return DecodeResult{OK: true, Text: hex.EncodeToString(data), Note: "non-UTF-8 bytes shown as hex"}
	}
	return DecodeResult{OK: true, Text: string(data)}
}

func asJSON(data []byte) DecodeResult {
	pretty, err := prettyJSON(data)
	if err != nil {
		return DecodeResult{OK: false, Error: "not valid JSON: " + err.Error()}
	}
	return DecodeResult{OK: true, Text: pretty}
}

// asBinary renders bytes as a space-separated list of two-digit hex octets,
// 16 per line, with a printable-ASCII gutter (hexdump-style).
func asBinary(data []byte) string {
	var b strings.Builder
	for i := 0; i < len(data); i += 16 {
		end := i + 16
		if end > len(data) {
			end = len(data)
		}
		chunk := data[i:end]
		fmt.Fprintf(&b, "%08x  ", i)
		for j := 0; j < 16; j++ {
			if j < len(chunk) {
				fmt.Fprintf(&b, "%02x ", chunk[j])
			} else {
				b.WriteString("   ")
			}
		}
		b.WriteString(" |")
		for _, c := range chunk {
			if c >= 0x20 && c < 0x7f {
				b.WriteByte(c)
			} else {
				b.WriteByte('.')
			}
		}
		b.WriteString("|\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func prettyJSON(data []byte) (string, error) {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return "", err
	}
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// decompress runs data through the reader factory then renders the result as
// JSON (if it parses) or text.
func decompress(data []byte, name string, factory func(io.Reader) (io.Reader, error)) DecodeResult {
	r, err := factory(bytes.NewReader(data))
	if err != nil {
		return DecodeResult{OK: false, Error: name + ": " + err.Error()}
	}
	out, err := io.ReadAll(r)
	if err != nil {
		return DecodeResult{OK: false, Error: name + ": " + err.Error()}
	}
	if pretty, err := prettyJSON(out); err == nil {
		return DecodeResult{OK: true, Text: pretty, Note: name + " → JSON"}
	}
	return asTextWithNote(out, name)
}

func asTextWithNote(data []byte, name string) DecodeResult {
	res := asText(data)
	if res.Note == "" {
		res.Note = name
	} else {
		res.Note = name + "; " + res.Note
	}
	return res
}

func decodeMsgpack(data []byte) DecodeResult {
	var v any
	if err := msgpack.Unmarshal(data, &v); err != nil {
		return DecodeResult{OK: false, Error: "msgpack: " + err.Error()}
	}
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return DecodeResult{OK: false, Error: "msgpack: " + err.Error()}
	}
	return DecodeResult{OK: true, Text: string(out), Note: "msgpack → JSON"}
}

// decodeProtobuf is a best-effort, schema-less protobuf wire-format decoder.
// It lists each field by number and wire type without knowing field names.
func decodeProtobuf(data []byte) DecodeResult {
	fields, err := parseProtobuf(data)
	if err != nil {
		return DecodeResult{OK: false, Error: "protobuf: " + err.Error()}
	}
	out, err := json.MarshalIndent(fields, "", "  ")
	if err != nil {
		return DecodeResult{OK: false, Error: "protobuf: " + err.Error()}
	}
	return DecodeResult{OK: true, Text: string(out), Note: "best-effort protobuf (no schema; field numbers only)"}
}

func parseProtobuf(data []byte) ([]map[string]any, error) {
	var fields []map[string]any
	i := 0
	for i < len(data) {
		tag, n := binary.Uvarint(data[i:])
		if n <= 0 {
			return nil, fmt.Errorf("bad tag at %d", i)
		}
		i += n
		fieldNum := tag >> 3
		wireType := tag & 0x7
		f := map[string]any{"field": fieldNum, "wireType": wireType}
		switch wireType {
		case 0: // varint
			v, n := binary.Uvarint(data[i:])
			if n <= 0 {
				return nil, fmt.Errorf("bad varint at %d", i)
			}
			i += n
			f["value"] = v
		case 1: // 64-bit
			if i+8 > len(data) {
				return nil, fmt.Errorf("truncated 64-bit at %d", i)
			}
			f["value"] = binary.LittleEndian.Uint64(data[i:])
			i += 8
		case 2: // length-delimited
			l, n := binary.Uvarint(data[i:])
			if n <= 0 {
				return nil, fmt.Errorf("bad length at %d", i)
			}
			i += n
			if i+int(l) > len(data) {
				return nil, fmt.Errorf("truncated bytes at %d", i)
			}
			raw := data[i : i+int(l)]
			i += int(l)
			if utf8.Valid(raw) {
				f["value"] = string(raw)
			} else {
				f["value"] = hex.EncodeToString(raw)
			}
		case 5: // 32-bit
			if i+4 > len(data) {
				return nil, fmt.Errorf("truncated 32-bit at %d", i)
			}
			f["value"] = binary.LittleEndian.Uint32(data[i:])
			i += 4
		default:
			return nil, fmt.Errorf("unsupported wire type %d at %d", wireType, i)
		}
		fields = append(fields, f)
	}
	return fields, nil
}
