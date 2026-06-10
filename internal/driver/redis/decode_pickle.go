package redis

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
)

// decodePickle is a best-effort decoder for Python pickle streams. It supports
// the common opcodes emitted by protocols 0-5 for primitive values and
// list/tuple/dict containers. Unsupported opcodes abort with a clear note.
func decodePickle(data []byte) DecodeResult {
	v, err := unpickle(data)
	if err != nil {
		return DecodeResult{OK: false, Error: "pickle: " + err.Error()}
	}
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return DecodeResult{OK: false, Error: "pickle: " + err.Error()}
	}
	return DecodeResult{OK: true, Text: string(out), Note: "best-effort pickle → JSON"}
}

type pickleMark struct{}

func unpickle(data []byte) (any, error) {
	var stack []any
	var memo = map[int]any{}
	i := 0
	pop := func() any {
		if len(stack) == 0 {
			return nil
		}
		v := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		return v
	}
	// popMark pops items back to the last mark and returns them in order.
	popMark := func() []any {
		idx := len(stack) - 1
		for idx >= 0 {
			if _, ok := stack[idx].(pickleMark); ok {
				break
			}
			idx--
		}
		items := append([]any{}, stack[idx+1:]...)
		stack = stack[:idx]
		return items
	}
	readLine := func() string {
		start := i
		for i < len(data) && data[i] != '\n' {
			i++
		}
		s := string(data[start:i])
		i++ // skip newline
		return s
	}

	for i < len(data) {
		op := data[i]
		i++
		switch op {
		case '\x80': // PROTO
			i++ // version byte
		case '\x95': // FRAME
			i += 8
		case '.': // STOP
			return normalizePickle(pop()), nil
		case '(': // MARK
			stack = append(stack, pickleMark{})
		case 'N': // NONE
			stack = append(stack, nil)
		case '\x88': // NEWTRUE
			stack = append(stack, true)
		case '\x89': // NEWFALSE
			stack = append(stack, false)
		case 'K': // BININT1
			stack = append(stack, int64(data[i]))
			i++
		case 'M': // BININT2
			stack = append(stack, int64(binary.LittleEndian.Uint16(data[i:])))
			i += 2
		case 'J': // BININT (4-byte signed)
			stack = append(stack, int64(int32(binary.LittleEndian.Uint32(data[i:]))))
			i += 4
		case '\x8a': // LONG1
			n := int(data[i])
			i++
			stack = append(stack, decodeLittleEndianSigned(data[i:i+n]))
			i += n
		case 'G': // BINFLOAT (big-endian double)
			bits := binary.BigEndian.Uint64(data[i:])
			stack = append(stack, math.Float64frombits(bits))
			i += 8
		case 'I': // INT (text)
			stack = append(stack, parseIntLine(readLine()))
		case 'L': // LONG (text, trailing L)
			s := readLine()
			if len(s) > 0 && s[len(s)-1] == 'L' {
				s = s[:len(s)-1]
			}
			stack = append(stack, parseIntLine(s))
		case 'X': // SHORT? no: BINUNICODE (4-byte len)
			n := int(binary.LittleEndian.Uint32(data[i:]))
			i += 4
			stack = append(stack, string(data[i:i+n]))
			i += n
		case '\x8c': // SHORT_BINUNICODE (1-byte len)
			n := int(data[i])
			i++
			stack = append(stack, string(data[i:i+n]))
			i += n
		case 'U': // SHORT_BINSTRING
			n := int(data[i])
			i++
			stack = append(stack, string(data[i:i+n]))
			i += n
		case 'T': // BINSTRING (4-byte len)
			n := int(binary.LittleEndian.Uint32(data[i:]))
			i += 4
			stack = append(stack, string(data[i:i+n]))
			i += n
		case ']': // EMPTY_LIST
			stack = append(stack, &[]any{})
		case ')': // EMPTY_TUPLE
			stack = append(stack, []any{})
		case '}': // EMPTY_DICT
			stack = append(stack, map[string]any{})
		case 'e': // APPENDS
			items := popMark()
			if lst, ok := stack[len(stack)-1].(*[]any); ok {
				*lst = append(*lst, items...)
			}
		case 'a': // APPEND
			v := pop()
			if lst, ok := stack[len(stack)-1].(*[]any); ok {
				*lst = append(*lst, v)
			}
		case 's': // SETITEM
			val := pop()
			key := pop()
			if m, ok := stack[len(stack)-1].(map[string]any); ok {
				m[fmt.Sprintf("%v", key)] = val
			}
		case 'u': // SETITEMS
			items := popMark()
			if m, ok := stack[len(stack)-1].(map[string]any); ok {
				for j := 0; j+1 < len(items); j += 2 {
					m[fmt.Sprintf("%v", items[j])] = items[j+1]
				}
			}
		case 't': // TUPLE
			stack = append(stack, popMark())
		case '\x85': // TUPLE1
			a := pop()
			stack = append(stack, []any{a})
		case '\x86': // TUPLE2
			b := pop()
			a := pop()
			stack = append(stack, []any{a, b})
		case '\x87': // TUPLE3
			c := pop()
			b := pop()
			a := pop()
			stack = append(stack, []any{a, b, c})
		case 'q': // BINPUT
			memo[int(data[i])] = stack[len(stack)-1]
			i++
		case 'r': // LONG_BINPUT
			memo[int(binary.LittleEndian.Uint32(data[i:]))] = stack[len(stack)-1]
			i += 4
		case '\x94': // MEMOIZE
			memo[len(memo)] = stack[len(stack)-1]
		case 'h': // BINGET
			stack = append(stack, memo[int(data[i])])
			i++
		case 'j': // LONG_BINGET
			stack = append(stack, memo[int(binary.LittleEndian.Uint32(data[i:]))])
			i += 4
		default:
			return normalizePickle(pop()), fmt.Errorf("unsupported opcode 0x%02x at %d", op, i-1)
		}
	}
	return normalizePickle(pop()), nil
}

// normalizePickle dereferences *[]any list pointers for JSON marshalling.
func normalizePickle(v any) any {
	switch t := v.(type) {
	case *[]any:
		out := make([]any, len(*t))
		for i, e := range *t {
			out[i] = normalizePickle(e)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = normalizePickle(e)
		}
		return out
	case map[string]any:
		for k, e := range t {
			t[k] = normalizePickle(e)
		}
		return t
	default:
		return v
	}
}

func parseIntLine(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func decodeLittleEndianSigned(b []byte) int64 {
	if len(b) == 0 {
		return 0
	}
	var v int64
	for i := len(b) - 1; i >= 0; i-- {
		v = (v << 8) | int64(b[i])
	}
	// sign extension based on top bit of the most-significant byte
	if b[len(b)-1]&0x80 != 0 {
		v -= int64(1) << (uint(len(b)) * 8)
	}
	return v
}
