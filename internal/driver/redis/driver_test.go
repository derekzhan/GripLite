package redis

import (
	"testing"

	"GripLite/internal/driver"
)

func TestKindIsRedis(t *testing.T) {
	d := &Driver{}
	if d.Kind() != driver.DriverRedis {
		t.Fatalf("Kind() = %v, want redis", d.Kind())
	}
}

func TestBuildOptionsDefaults(t *testing.T) {
	o, err := buildOptions(driver.ConnectionConfig{Host: "localhost", Port: 6379, Database: "3", Username: "u", Password: "p"})
	if err != nil {
		t.Fatal(err)
	}
	if o.Addr != "localhost:6379" {
		t.Fatalf("Addr = %q", o.Addr)
	}
	if o.DB != 3 {
		t.Fatalf("DB = %d, want 3", o.DB)
	}
	if o.Username != "u" || o.Password != "p" {
		t.Fatalf("auth mismatch: %q/%q", o.Username, o.Password)
	}
	if o.TLSConfig != nil {
		t.Fatal("TLSConfig should be nil when TLS disabled")
	}
}

func TestBuildOptionsTLS(t *testing.T) {
	o, _ := buildOptions(driver.ConnectionConfig{Host: "h", Port: 6380, TLS: true})
	if o.TLSConfig == nil {
		t.Fatal("want TLS config when TLS enabled")
	}
	if o.TLSConfig.ServerName != "h" {
		t.Fatalf("ServerName = %q", o.TLSConfig.ServerName)
	}
}

func TestParseDBIndex(t *testing.T) {
	cases := map[string]int{"": 0, "0": 0, "5": 5, "15": 15, "abc": 0, "-2": 0}
	for in, want := range cases {
		if got := parseDBIndex(in); got != want {
			t.Errorf("parseDBIndex(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestParseRedisVersion(t *testing.T) {
	info := "# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n"
	if got := parseRedisVersion(info); got != "7.2.4" {
		t.Fatalf("parseRedisVersion = %q, want 7.2.4", got)
	}
	if got := parseRedisVersion("no version here"); got != "" {
		t.Fatalf("want empty, got %q", got)
	}
}

func TestDBIndexFromName(t *testing.T) {
	cases := map[string]int{"db0": 0, "db7": 7, "db15": 15, "db": 0}
	for in, want := range cases {
		if got := dbIndexFromName(in); got != want {
			t.Errorf("dbIndexFromName(%q) = %d, want %d", in, got, want)
		}
	}
}
