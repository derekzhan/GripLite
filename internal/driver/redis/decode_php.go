package redis

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// decodePHP parses PHP serialize() output into a JSON structure.
func decodePHP(data []byte) DecodeResult {
	p := &phpParser{s: string(data)}
	v, err := p.parse()
	if err != nil {
		return DecodeResult{OK: false, Error: "php: " + err.Error()}
	}
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return DecodeResult{OK: false, Error: "php: " + err.Error()}
	}
	return DecodeResult{OK: true, Text: string(out), Note: "php serialize → JSON"}
}

type phpParser struct {
	s string
	i int
}

func (p *phpParser) parse() (any, error) {
	if p.i >= len(p.s) {
		return nil, fmt.Errorf("unexpected end")
	}
	switch p.s[p.i] {
	case 'N': // N;
		p.i += 2
		return nil, nil
	case 'b': // b:1;
		p.i += 2
		end := p.indexFrom(';')
		tok := p.s[p.i:end]
		p.i = end + 1
		return tok == "1", nil
	case 'i': // i:42;
		p.i += 2
		end := p.indexFrom(';')
		n, err := strconv.ParseInt(p.s[p.i:end], 10, 64)
		p.i = end + 1
		return n, err
	case 'd': // d:3.14;
		p.i += 2
		end := p.indexFrom(';')
		f, err := strconv.ParseFloat(p.s[p.i:end], 64)
		p.i = end + 1
		return f, err
	case 's': // s:5:"hello";
		return p.parseString()
	case 'a': // a:2:{...}
		return p.parseArray()
	case 'O': // O:8:"ClassName":n:{...}
		return p.parseObject()
	default:
		return nil, fmt.Errorf("unsupported token %q at %d", p.s[p.i], p.i)
	}
}

func (p *phpParser) parseString() (string, error) {
	p.i += 2 // skip s:
	colon := p.indexFrom(':')
	length, err := strconv.Atoi(p.s[p.i:colon])
	if err != nil {
		return "", err
	}
	// after colon there is a quote
	start := colon + 2 // skip :"
	if start+length > len(p.s) {
		return "", fmt.Errorf("string length out of range")
	}
	val := p.s[start : start+length]
	p.i = start + length + 2 // skip closing ";
	return val, nil
}

func (p *phpParser) parseArray() (any, error) {
	p.i += 2 // skip a:
	colon := p.indexFrom(':')
	count, err := strconv.Atoi(p.s[p.i:colon])
	if err != nil {
		return nil, err
	}
	p.i = colon + 2 // skip :{
	m := make(map[string]any, count)
	for n := 0; n < count; n++ {
		k, err := p.parse()
		if err != nil {
			return nil, err
		}
		v, err := p.parse()
		if err != nil {
			return nil, err
		}
		m[fmt.Sprintf("%v", k)] = v
	}
	p.i++ // skip }
	return m, nil
}

func (p *phpParser) parseObject() (any, error) {
	p.i += 2 // skip O:
	colon := p.indexFrom(':')
	nameLen, err := strconv.Atoi(p.s[p.i:colon])
	if err != nil {
		return nil, err
	}
	nameStart := colon + 2
	className := p.s[nameStart : nameStart+nameLen]
	p.i = nameStart + nameLen + 2 // skip ":
	colon2 := p.indexFrom(':')
	count, err := strconv.Atoi(p.s[p.i:colon2])
	if err != nil {
		return nil, err
	}
	p.i = colon2 + 2 // skip :{
	m := map[string]any{"__class__": className}
	for n := 0; n < count; n++ {
		k, err := p.parse()
		if err != nil {
			return nil, err
		}
		v, err := p.parse()
		if err != nil {
			return nil, err
		}
		m[fmt.Sprintf("%v", k)] = v
	}
	p.i++ // skip }
	return m, nil
}

func (p *phpParser) indexFrom(ch byte) int {
	for j := p.i; j < len(p.s); j++ {
		if p.s[j] == ch {
			return j
		}
	}
	return len(p.s)
}
