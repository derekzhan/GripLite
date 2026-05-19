package mongodb

import (
	"testing"

	"GripLite/internal/driver"
)

func TestNewRegistersMongoDBDriver(t *testing.T) {
	drv, err := driver.New(driver.ConnectionConfig{
		ID:   "mongo-1",
		Kind: driver.DriverMongoDB,
		Host: "localhost",
		Port: 27017,
	})
	if err != nil {
		t.Fatalf("driver.New returned error: %v", err)
	}
	if drv.Kind() != driver.DriverMongoDB {
		t.Fatalf("Kind() = %q, want %q", drv.Kind(), driver.DriverMongoDB)
	}
}

func TestBuildURIStandardAndSRV(t *testing.T) {
	std := buildURI(driver.ConnectionConfig{
		Host:     "localhost",
		Port:     27017,
		Username: "user",
		Password: "pass",
		Database: "admin",
	}, "standard")
	if std != "mongodb://user:pass@localhost:27017/admin" {
		t.Fatalf("standard URI = %q", std)
	}

	srv := buildURI(driver.ConnectionConfig{
		Host:     "cluster.example.mongodb.net",
		Username: "user",
		Password: "pass",
		Database: "admin",
	}, "srv")
	if srv != "mongodb+srv://user:pass@cluster.example.mongodb.net/admin" {
		t.Fatalf("srv URI = %q", srv)
	}
}

func TestBuildURIIncludesTLSAndAdvancedParams(t *testing.T) {
	uri := buildURI(driver.ConnectionConfig{
		Host:     "localhost",
		Port:     27017,
		Database: "admin",
		TLS:      true,
		AdvancedParams: []driver.AdvancedParam{
			{Key: "authSource", Value: "admin", Enabled: true},
			{Key: connectionModeParam, Value: "srv", Enabled: true},
			{Key: "ignored", Value: "true", Enabled: false},
		},
	}, "standard")
	want := "mongodb://localhost:27017/admin?authSource=admin&tls=true"
	if uri != want {
		t.Fatalf("URI = %q, want %q", uri, want)
	}
}

func TestEffectiveFindLimitDefaultsWhenUnset(t *testing.T) {
	if got := effectiveFindLimit(0); got != defaultFindLimit {
		t.Fatalf("effectiveFindLimit(0) = %d, want %d", got, defaultFindLimit)
	}
	if got := effectiveFindLimit(25); got != 25 {
		t.Fatalf("effectiveFindLimit(25) = %d, want 25", got)
	}
}
