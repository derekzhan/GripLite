package mongodb

import (
	"testing"

	"GripLite/internal/driver"

	"go.mongodb.org/mongo-driver/v2/bson"
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

func TestServerCursorLimitUsesSentinelOnlyForDefaultLimit(t *testing.T) {
	if got := serverCursorLimit(0); got != defaultFindLimit+1 {
		t.Fatalf("serverCursorLimit(0) = %d, want %d", got, defaultFindLimit+1)
	}
	if got := serverCursorLimit(25); got != 25 {
		t.Fatalf("serverCursorLimit(25) = %d, want 25", got)
	}
}

func TestAggregatePipelineAddsDefaultLimitWhenUnset(t *testing.T) {
	pipeline := cappedAggregatePipeline([]any{
		map[string]any{"$match": map[string]any{"status": "active"}},
	}, 0)

	if len(pipeline) != 2 {
		t.Fatalf("pipeline len = %d, want 2", len(pipeline))
	}
	limit, ok := pipeline[1].(bson.D)
	if !ok || len(limit) != 1 || limit[0].Key != "$limit" || limit[0].Value != defaultFindLimit+1 {
		t.Fatalf("limit stage = %#v, want $limit default+1", pipeline[1])
	}
}

func TestAggregatePipelinePreservesExplicitLimit(t *testing.T) {
	pipeline := cappedAggregatePipeline([]any{
		map[string]any{"$match": map[string]any{"status": "active"}},
		map[string]any{"$limit": int64(25)},
	}, 0)

	if len(pipeline) != 2 {
		t.Fatalf("pipeline len = %d, want 2", len(pipeline))
	}
	if hasSyntheticLimit(pipeline[:1]) {
		t.Fatalf("synthetic limit detection should not trigger before explicit limit")
	}
}

