package mysql

import (
	"strings"
	"testing"
	"time"

	"GripLite/internal/driver"
)

// TestBuildDSN_PlainTCP verifies the basic DSN format for a direct TCP
// connection (no SSH), with the default library parameters applied.
func TestBuildDSN_PlainTCP(t *testing.T) {
	d, err := New(driver.ConnectionConfig{
		Host:     "127.0.0.1",
		Port:     3306,
		Username: "root",
		Password: "pwd",
		Database: "shop",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	dsn := d.buildDSN(10 * time.Second)

	wantSubstrings := []string{
		"root:pwd@",
		"tcp(127.0.0.1:3306)",
		"/shop?",
		"parseTime=true",
		"charset=utf8mb4",
		"timeout=10s",
		"readTimeout=30s",
		"writeTimeout=30s",
	}
	for _, s := range wantSubstrings {
		if !strings.Contains(dsn, s) {
			t.Errorf("DSN missing %q\nfull: %s", s, dsn)
		}
	}
}

// TestBuildDSN_SSHNetwork verifies that when the driver has an SSH network
// name set, buildDSN uses it in place of the literal "tcp".
func TestBuildDSN_SSHNetwork(t *testing.T) {
	d, err := New(driver.ConnectionConfig{
		Host:     "10.0.0.5",
		Port:     3306,
		Username: "app",
		Password: "secret",
		Database: "prod",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	d.sshNetName = "sshnet:abc"

	dsn := d.buildDSN(5 * time.Second)
	if !strings.Contains(dsn, "sshnet:abc(10.0.0.5:3306)") {
		t.Errorf("DSN should route through SSH network, got %s", dsn)
	}
	if strings.Contains(dsn, "tcp(") {
		t.Errorf("DSN should not contain tcp(, got %s", dsn)
	}
}

// TestBuildDSN_AdvancedParamsEnabled verifies enabled AdvancedParams are
// appended as query-string parameters and that disabled ones are dropped.
//
// JDBC keys (serverTimezone / useSSL) are translated to their go-sql-driver
// equivalents (loc / tls) — see translateAdvancedParam.
func TestBuildDSN_AdvancedParamsEnabled(t *testing.T) {
	d, err := New(driver.ConnectionConfig{
		Host:     "db",
		Port:     3306,
		Username: "u",
		Password: "p",
		Database: "x",
		AdvancedParams: []driver.AdvancedParam{
			{Key: "allowMultiQueries", Value: "true", Enabled: true},
			{Key: "serverTimezone", Value: "UTC", Enabled: true}, // JDBC → loc=UTC
			{Key: "useSSL", Value: "false", Enabled: false},       // disabled → dropped
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	dsn := d.buildDSN(10 * time.Second)
	if !strings.Contains(dsn, "allowMultiQueries=true") {
		t.Errorf("DSN missing enabled param allowMultiQueries, got %s", dsn)
	}
	if !strings.Contains(dsn, "loc=UTC") {
		t.Errorf("DSN missing translated JDBC serverTimezone→loc=UTC, got %s", dsn)
	}
	if strings.Contains(dsn, "serverTimezone") {
		t.Errorf("DSN should have stripped JDBC serverTimezone key, got %s", dsn)
	}
	if strings.Contains(dsn, "useSSL") {
		t.Errorf("DSN should not contain disabled param useSSL, got %s", dsn)
	}
}

// TestBuildDSN_JDBCTranslation covers the JDBC-to-go-driver param rewrites.
//
// Users pasting a JDBC URL like
//   jdbc:mysql://host:3306/db?useSSL=false&serverTimezone=America/Vancouver&allowPublicKeyRetrieval=true
// into the Advanced tab would previously fail with MySQL Error 1193
// "Unknown system variable" because go-sql-driver forwards unknown keys as
// SET statements at connect time.
func TestBuildDSN_JDBCTranslation(t *testing.T) {
	d, err := New(driver.ConnectionConfig{
		Host:     "db",
		Port:     3306,
		Username: "u",
		Password: "p",
		Database: "x",
		AdvancedParams: []driver.AdvancedParam{
			{Key: "useSSL", Value: "false", Enabled: true},
			{Key: "serverTimezone", Value: "America/Vancouver", Enabled: true},
			{Key: "allowPublicKeyRetrieval", Value: "true", Enabled: true},
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	dsn := d.buildDSN(10 * time.Second)

	wantContains := []string{
		"tls=false",            // useSSL=false → tls=false
		"loc=America%2FVancouver", // serverTimezone → loc (URL-encoded "/")
	}
	for _, s := range wantContains {
		if !strings.Contains(dsn, s) {
			t.Errorf("DSN missing %q\nfull: %s", s, dsn)
		}
	}

	// JDBC keys themselves must have been stripped from the final DSN.
	wantAbsent := []string{"useSSL", "serverTimezone", "allowPublicKeyRetrieval"}
	for _, s := range wantAbsent {
		if strings.Contains(dsn, s) {
			t.Errorf("DSN should not contain JDBC key %q\nfull: %s", s, dsn)
		}
	}
}

// TestTranslateAdvancedParam covers the individual rewrite rules in isolation.
func TestTranslateAdvancedParam(t *testing.T) {
	cases := []struct {
		inKey, inVal         string
		wantKey, wantVal     string
		wantKeep             bool
	}{
		// JDBC rewrites
		{"useSSL", "false", "tls", "false", true},
		{"USESSL", "TRUE", "tls", "true", true},
		{"serverTimezone", "Asia/Shanghai", "loc", "Asia/Shanghai", true},
		{"allowPublicKeyRetrieval", "true", "", "", false},
		// Unknown key — passthrough unchanged.
		{"allowMultiQueries", "true", "allowMultiQueries", "true", true},
	}
	for _, c := range cases {
		gotKey, gotVal, gotKeep := translateAdvancedParam(c.inKey, c.inVal)
		if gotKey != c.wantKey || gotVal != c.wantVal || gotKeep != c.wantKeep {
			t.Errorf("translate(%q,%q)=(%q,%q,%v); want (%q,%q,%v)",
				c.inKey, c.inVal, gotKey, gotVal, gotKeep,
				c.wantKey, c.wantVal, c.wantKeep)
		}
	}
}

// TestBuildDSN_AdvancedParamsOverride verifies user-supplied AdvancedParams
// override the library's default values (parseTime etc.).
func TestBuildDSN_AdvancedParamsOverride(t *testing.T) {
	d, err := New(driver.ConnectionConfig{
		Host:     "db",
		Port:     3306,
		Username: "u",
		Password: "p",
		Database: "x",
		AdvancedParams: []driver.AdvancedParam{
			{Key: "parseTime", Value: "false", Enabled: true},
			{Key: "charset", Value: "utf8", Enabled: true},
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	dsn := d.buildDSN(10 * time.Second)
	if !strings.Contains(dsn, "parseTime=false") {
		t.Errorf("override parseTime missing, got %s", dsn)
	}
	if strings.Contains(dsn, "parseTime=true") {
		t.Errorf("default parseTime still present, got %s", dsn)
	}
	if !strings.Contains(dsn, "charset=utf8&") && !strings.HasSuffix(dsn, "charset=utf8") {
		t.Errorf("override charset missing, got %s", dsn)
	}
}

// TestNew_RejectsMissingHost ensures New() validates its input.
func TestNew_RejectsMissingHost(t *testing.T) {
	_, err := New(driver.ConnectionConfig{
		Port:     3306,
		Username: "u",
		Password: "p",
	})
	if err == nil {
		t.Fatal("expected error for missing host, got nil")
	}
}

// TestNew_DefaultsPort ensures Port=0 is substituted with 3306.
func TestNew_DefaultsPort(t *testing.T) {
	d, err := New(driver.ConnectionConfig{
		Host:     "db.example.com",
		Port:     0,
		Username: "u",
		Password: "p",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if d.cfg.Port != 3306 {
		t.Errorf("port: want 3306, got %d", d.cfg.Port)
	}
}

// TestSystemSchemasSet — guards that the filter list used by FetchDatabases
// matches the canonical MySQL system schemas.  A regression here would leak
// performance_schema / information_schema into the Explorer tree.
func TestSystemSchemasSet(t *testing.T) {
	for _, s := range []string{
		"information_schema", "mysql", "performance_schema", "sys",
	} {
		if !systemSchemas[s] {
			t.Errorf("systemSchemas should include %q", s)
		}
	}
	for _, s := range []string{"ulala_main", "app", "db1"} {
		if systemSchemas[s] {
			t.Errorf("systemSchemas should NOT include user schema %q", s)
		}
	}
}

// TestKind verifies Kind() returns the expected driver kind.
func TestKind(t *testing.T) {
	d, _ := New(driver.ConnectionConfig{Host: "x", Port: 3306})
	if d.Kind() != driver.DriverMySQL {
		t.Errorf("Kind: want DriverMySQL, got %v", d.Kind())
	}
}

// TestDriverRegistry verifies init() registered the MySQL factory with the
// UDAL driver package.
func TestDriverRegistry(t *testing.T) {
	got, err := driver.New(driver.ConnectionConfig{
		Kind: driver.DriverMySQL,
		Host: "x",
		Port: 3306,
	})
	if err != nil {
		t.Fatalf("driver.New returned unexpected error: %v", err)
	}
	if got == nil {
		t.Fatal("driver.New returned nil")
	}
	if got.Kind() != driver.DriverMySQL {
		t.Errorf("Kind from registry: %v", got.Kind())
	}
}
