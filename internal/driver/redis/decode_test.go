package redis

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"encoding/binary"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
	kpsnappy "github.com/klauspost/compress/snappy"
	"github.com/klauspost/compress/zstd"
	lz4 "github.com/pierrec/lz4/v4"
	"github.com/vmihailenco/msgpack/v5"
)

func TestDecodeText(t *testing.T) {
	r := DecodeValue([]byte("hello"), "text")
	if !r.OK || r.Text != "hello" {
		t.Fatalf("%+v", r)
	}
}

func TestDecodeJSON(t *testing.T) {
	r := DecodeValue([]byte(`{"a":1}`), "json")
	if !r.OK || !strings.Contains(r.Text, "\"a\": 1") {
		t.Fatalf("%+v", r)
	}
	bad := DecodeValue([]byte("not json"), "json")
	if bad.OK {
		t.Fatalf("expected failure, got %+v", bad)
	}
}

func TestDecodeHex(t *testing.T) {
	r := DecodeValue([]byte{0x01, 0xff}, "hex")
	if !r.OK || r.Text != "01ff" {
		t.Fatalf("%+v", r)
	}
}

func TestDecodeBinaryHexdump(t *testing.T) {
	r := DecodeValue([]byte("AB"), "binary")
	if !r.OK || !strings.Contains(r.Text, "41 42") || !strings.Contains(r.Text, "|AB|") {
		t.Fatalf("%+v", r)
	}
}

func TestDecodeGzipJSON(t *testing.T) {
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	w.Write([]byte(`{"a":1}`))
	w.Close()
	r := DecodeValue(b.Bytes(), "gzip")
	if !r.OK || !strings.Contains(r.Text, "\"a\"") {
		t.Fatalf("%+v", r)
	}
}

func TestDecodeDeflate(t *testing.T) {
	var b bytes.Buffer
	w, _ := flate.NewWriter(&b, flate.DefaultCompression)
	w.Write([]byte("plain text"))
	w.Close()
	r := DecodeValue(b.Bytes(), "deflate")
	if !r.OK || !strings.Contains(r.Text, "plain text") {
		t.Fatalf("%+v", r)
	}
}

func TestDecodeBrotli(t *testing.T) {
	var b bytes.Buffer
	w := brotli.NewWriter(&b)
	w.Write([]byte("brotli payload"))
	w.Close()
	r := DecodeValue(b.Bytes(), "brotli")
	if !r.OK || !strings.Contains(r.Text, "brotli payload") {
		t.Fatalf("%+v", r)
	}
}

func TestDecodeLZ4(t *testing.T) {
	var b bytes.Buffer
	w := lz4.NewWriter(&b)
	w.Write([]byte("lz4 payload"))
	w.Close()
	r := DecodeValue(b.Bytes(), "lz4")
	if !r.OK || !strings.Contains(r.Text, "lz4 payload") {
		t.Fatalf("%+v", r)
	}
}

func TestDecodeSnappy(t *testing.T) {
	var b bytes.Buffer
	w := kpsnappy.NewBufferedWriter(&b)
	w.Write([]byte("snappy payload"))
	w.Close()
	r := DecodeValue(b.Bytes(), "snappy")
	if !r.OK || !strings.Contains(r.Text, "snappy payload") {
		t.Fatalf("%+v", r)
	}
}

func TestDecodeZstd(t *testing.T) {
	var b bytes.Buffer
	w, _ := zstd.NewWriter(&b)
	w.Write([]byte("zstd payload"))
	w.Close()
	r := DecodeValue(b.Bytes(), "zstd")
	if !r.OK || !strings.Contains(r.Text, "zstd payload") {
		t.Fatalf("%+v", r)
	}
}

func TestDecodeMsgpack(t *testing.T) {
	data, _ := msgpack.Marshal(map[string]any{"a": 1, "b": "two"})
	r := DecodeValue(data, "msgpack")
	if !r.OK || !strings.Contains(r.Text, "\"b\"") {
		t.Fatalf("%+v", r)
	}
}

func TestDecodePHP(t *testing.T) {
	// a:2:{s:4:"name";s:5:"Alice";s:3:"age";i:30;}
	php := `a:2:{s:4:"name";s:5:"Alice";s:3:"age";i:30;}`
	r := DecodeValue([]byte(php), "php")
	if !r.OK || !strings.Contains(r.Text, "Alice") || !strings.Contains(r.Text, "30") {
		t.Fatalf("%+v", r)
	}
}

func TestDecodeProtobufBestEffort(t *testing.T) {
	// field 1, varint 150 → tag 0x08, value 0x96 0x01
	data := []byte{0x08, 0x96, 0x01}
	r := DecodeValue(data, "protobuf")
	if !r.OK || r.Note == "" || !strings.Contains(r.Text, "150") {
		t.Fatalf("%+v", r)
	}
}

func TestDecodePickleBestEffort(t *testing.T) {
	// pickle of the int 7: PROTO 2, BININT1 7, STOP
	data := []byte{0x80, 0x02, 'K', 0x07, '.'}
	r := DecodeValue(data, "pickle")
	if !r.OK || !strings.Contains(r.Text, "7") {
		t.Fatalf("%+v", r)
	}
}

func TestDecodeUnknownFormat(t *testing.T) {
	r := DecodeValue([]byte("x"), "rot13")
	if r.OK {
		t.Fatalf("expected failure for unknown format")
	}
}

func TestParseInfoSections(t *testing.T) {
	raw := "# Server\r\nredis_version:7.2.4\r\nuptime_in_seconds:100\r\n\r\n# Clients\r\nconnected_clients:3\r\n"
	info := parseInfo(raw)
	if info["Server"]["redis_version"] != "7.2.4" {
		t.Fatalf("server section: %+v", info["Server"])
	}
	if info["Clients"]["connected_clients"] != "3" {
		t.Fatalf("clients section: %+v", info["Clients"])
	}
}

// helper to silence unused import if a test is removed
var _ = binary.LittleEndian
