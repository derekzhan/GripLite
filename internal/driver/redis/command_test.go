package redis

import (
	"reflect"
	"testing"
)

func TestSplitCommandQuotes(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{`SET a "hello world"`, []string{"SET", "a", "hello world"}},
		{`GET foo`, []string{"GET", "foo"}},
		{`HSET h f 'a b c'`, []string{"HSET", "h", "f", "a b c"}},
		{`  PING  `, []string{"PING"}},
		{`SET k ""`, []string{"SET", "k", ""}},
	}
	for _, c := range cases {
		got := splitCommand(c.in)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("splitCommand(%q) = %#v, want %#v", c.in, got, c.want)
		}
	}
}

func TestIsWriteCommand(t *testing.T) {
	writes := []string{"SET", "del", "Expire", "HSET", "ZADD", "FLUSHALL", "lpush"}
	reads := []string{"GET", "ping", "TYPE", "TTL", "SCAN", "INFO", "ZRANGE"}
	for _, w := range writes {
		if !IsWriteCommand(w) {
			t.Errorf("IsWriteCommand(%q) = false, want true", w)
		}
	}
	for _, r := range reads {
		if IsWriteCommand(r) {
			t.Errorf("IsWriteCommand(%q) = true, want false", r)
		}
	}
}

func TestRenderReply(t *testing.T) {
	if got := renderReply(nil, 0); got != "(nil)" {
		t.Errorf("nil → %q", got)
	}
	if got := renderReply(int64(5), 0); got != "(integer) 5" {
		t.Errorf("int → %q", got)
	}
	if got := renderReply([]any{"a", "b"}, 0); got != "1) a\n2) b" {
		t.Errorf("array → %q", got)
	}
	if got := renderReply([]any{}, 0); got != "(empty array)" {
		t.Errorf("empty → %q", got)
	}
}
