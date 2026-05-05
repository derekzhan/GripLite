package database

import (
	"context"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestNormalizeCopyDatabaseConfigDefaultsBatchSize(t *testing.T) {
	cfg := NormalizeCopyDatabaseConfig(CopyDatabaseConfig{
		SourceConnID: "src",
		SourceDB:     "shop",
		TargetConnID: "dst",
		TargetDB:     "shop_copy",
		CopyData:     true,
	})

	if cfg.BatchSize != DefaultCopyBatchSize {
		t.Fatalf("BatchSize = %d, want %d", cfg.BatchSize, DefaultCopyBatchSize)
	}
}

func TestNormalizeCopyDatabaseConfigPreservesPositiveBatchSize(t *testing.T) {
	cfg := NormalizeCopyDatabaseConfig(CopyDatabaseConfig{
		SourceConnID: "src",
		SourceDB:     "shop",
		TargetConnID: "dst",
		TargetDB:     "shop_copy",
		BatchSize:    250,
	})

	if cfg.BatchSize != 250 {
		t.Fatalf("BatchSize = %d, want 250", cfg.BatchSize)
	}
}

func TestRewriteCreateTableDDLTargetsQualifiedTable(t *testing.T) {
	ddl := "CREATE TABLE `users` (\n  `id` int NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB"

	got, err := rewriteCreateTableDDL(ddl, "archive", "users_copy")
	if err != nil {
		t.Fatalf("rewriteCreateTableDDL returned error: %v", err)
	}

	if !strings.HasPrefix(got, "CREATE TABLE `archive`.`users_copy` (") {
		t.Fatalf("rewritten DDL = %q", got)
	}
	if !strings.Contains(got, "PRIMARY KEY (`id`)") {
		t.Fatalf("rewritten DDL lost table body: %q", got)
	}
}

func TestManagerCopyTableCopiesStructureWithDrop(t *testing.T) {
	sourceDB, sourceMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer sourceDB.Close()
	targetDB, targetMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer targetDB.Close()

	m := &Manager{pools: map[string]*dbEntry{
		"src": {db: sourceDB},
		"dst": {db: targetDB},
	}}

	targetMock.ExpectQuery(regexp.QuoteMeta(
		"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
	)).
		WithArgs("archive", "users_copy").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	sourceMock.ExpectQuery(regexp.QuoteMeta("SHOW CREATE TABLE `shop`.`users`")).
		WillReturnRows(sqlmock.NewRows([]string{"Table", "Create Table"}).
			AddRow("users", "CREATE TABLE `users` (`id` int NOT NULL) ENGINE=InnoDB"))
	targetMock.ExpectExec(regexp.QuoteMeta("DROP TABLE IF EXISTS `archive`.`users_copy`")).
		WillReturnResult(sqlmock.NewResult(0, 0))
	targetMock.ExpectExec(regexp.QuoteMeta("CREATE TABLE `archive`.`users_copy` (`id` int NOT NULL) ENGINE=InnoDB")).
		WillReturnResult(sqlmock.NewResult(0, 0))

	result := m.CopyTable(context.Background(), CopyTableConfig{
		SourceConnID:       "src",
		SourceDB:           "shop",
		SourceTable:        "users",
		TargetConnID:       "dst",
		TargetDB:           "archive",
		TargetTable:        "users_copy",
		CopyStructure:      true,
		DropTargetIfExists: true,
	}, nil)

	if !result.Success || result.Error != "" {
		t.Fatalf("CopyTable result = %+v", result)
	}
	if err := sourceMock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
	if err := targetMock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestManagerCopyTableRejectsExistingTargetWithoutDrop(t *testing.T) {
	sourceDB, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer sourceDB.Close()
	targetDB, targetMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer targetDB.Close()

	m := &Manager{pools: map[string]*dbEntry{
		"src": {db: sourceDB},
		"dst": {db: targetDB},
	}}

	targetMock.ExpectQuery(regexp.QuoteMeta(
		"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
	)).
		WithArgs("archive", "users").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	result := m.CopyTable(context.Background(), CopyTableConfig{
		SourceConnID:  "src",
		SourceDB:      "shop",
		SourceTable:   "users",
		TargetConnID:  "dst",
		TargetDB:      "archive",
		TargetTable:   "users",
		CopyStructure: true,
	}, nil)

	if result.Success || !strings.Contains(result.Error, "already exists") {
		t.Fatalf("CopyTable result = %+v, want existing-table error", result)
	}
	if err := targetMock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestManagerCopyTableStreamsRowsIntoBatchTransactions(t *testing.T) {
	sourceDB, sourceMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer sourceDB.Close()
	targetDB, targetMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer targetDB.Close()

	m := &Manager{pools: map[string]*dbEntry{
		"src": {db: sourceDB},
		"dst": {db: targetDB},
	}}

	targetMock.ExpectQuery(regexp.QuoteMeta(
		"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
	)).
		WithArgs("archive", "users").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	sourceMock.ExpectQuery(regexp.QuoteMeta("SELECT * FROM `shop`.`users`")).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name"}).
			AddRow(1, "alice").
			AddRow(2, "bob").
			AddRow(3, nil))
	targetMock.ExpectBegin()
	targetMock.ExpectExec(regexp.QuoteMeta("INSERT INTO `archive`.`users` (`id`, `name`) VALUES (?, ?), (?, ?)")).
		WithArgs([]byte("1"), []byte("alice"), []byte("2"), []byte("bob")).
		WillReturnResult(sqlmock.NewResult(0, 2))
	targetMock.ExpectCommit()
	targetMock.ExpectBegin()
	targetMock.ExpectExec(regexp.QuoteMeta("INSERT INTO `archive`.`users` (`id`, `name`) VALUES (?, ?)")).
		WithArgs([]byte("3"), nil).
		WillReturnResult(sqlmock.NewResult(0, 1))
	targetMock.ExpectCommit()

	var progress []CopyProgressEvent
	result := m.CopyTable(context.Background(), CopyTableConfig{
		SourceConnID: "src",
		SourceDB:     "shop",
		SourceTable:  "users",
		TargetConnID: "dst",
		TargetDB:     "archive",
		TargetTable:  "users",
		CopyData:     true,
		BatchSize:    2,
	}, func(evt CopyProgressEvent) {
		progress = append(progress, evt)
	})

	if !result.Success || result.Error != "" {
		t.Fatalf("CopyTable result = %+v", result)
	}
	if !hasProcessedRows(progress, 2) || !hasProcessedRows(progress, 3) {
		t.Fatalf("progress events = %+v, want processed rows 2 and 3", progress)
	}
	if err := sourceMock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
	if err := targetMock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestNormalizeCopyValueFormatsRFC3339TemporalValues(t *testing.T) {
	cases := []struct {
		dbType string
		raw    string
		want   any
	}{
		{dbType: "DATETIME", raw: "2018-07-23T02:15:27Z", want: "2018-07-23 02:15:27"},
		{dbType: "TIMESTAMP", raw: "2018-07-23T02:15:27.123456Z", want: "2018-07-23 02:15:27.123456"},
		{dbType: "DATE", raw: "2018-07-23T00:00:00Z", want: "2018-07-23"},
		{dbType: "VARCHAR", raw: "2018-07-23T02:15:27Z", want: []byte("2018-07-23T02:15:27Z")},
	}

	for _, tc := range cases {
		t.Run(tc.dbType, func(t *testing.T) {
			got := normalizeCopyValue([]byte(tc.raw), tc.dbType)
			if stringWant, ok := tc.want.(string); ok {
				if got != stringWant {
					t.Fatalf("normalizeCopyValue(%q, %q) = %#v, want %q", tc.raw, tc.dbType, got, stringWant)
				}
				return
			}
			bytesWant := tc.want.([]byte)
			bytesGot, ok := got.([]byte)
			if !ok || string(bytesGot) != string(bytesWant) {
				t.Fatalf("normalizeCopyValue(%q, %q) = %#v, want %#v", tc.raw, tc.dbType, got, bytesWant)
			}
		})
	}
}

func TestManagerCopyDatabaseCopiesAllSourceTables(t *testing.T) {
	sourceDB, sourceMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer sourceDB.Close()
	targetDB, targetMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer targetDB.Close()

	m := &Manager{pools: map[string]*dbEntry{
		"src": {db: sourceDB},
		"dst": {db: targetDB},
	}}

	sourceMock.ExpectQuery(regexp.QuoteMeta(
		"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
	)).
		WithArgs("shop").
		WillReturnRows(sqlmock.NewRows([]string{"TABLE_NAME"}).
			AddRow("orders").
			AddRow("users"))

	for _, table := range []string{"orders", "users"} {
		targetMock.ExpectQuery(regexp.QuoteMeta(
			"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
		)).
			WithArgs("archive", table).
			WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
		targetMock.ExpectQuery(regexp.QuoteMeta(
			"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
		)).
			WithArgs("archive", table).
			WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
		sourceMock.ExpectQuery(regexp.QuoteMeta("SHOW CREATE TABLE `shop`.`" + table + "`")).
			WillReturnRows(sqlmock.NewRows([]string{"Table", "Create Table"}).
				AddRow(table, "CREATE TABLE `"+table+"` (`id` int NOT NULL) ENGINE=InnoDB"))
		targetMock.ExpectExec(regexp.QuoteMeta("CREATE TABLE `archive`.`" + table + "` (`id` int NOT NULL) ENGINE=InnoDB")).
			WillReturnResult(sqlmock.NewResult(0, 0))
	}

	var progress []CopyProgressEvent
	result := m.CopyDatabase(context.Background(), CopyDatabaseConfig{
		SourceConnID:  "src",
		SourceDB:      "shop",
		TargetConnID:  "dst",
		TargetDB:      "archive",
		CopyStructure: true,
	}, func(evt CopyProgressEvent) {
		progress = append(progress, evt)
	})

	if !result.Success || result.Error != "" {
		t.Fatalf("CopyDatabase result = %+v", result)
	}
	if !hasProgressStatus(progress, "Copy complete") {
		t.Fatalf("progress events = %+v, want Copy complete", progress)
	}
	if err := sourceMock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
	if err := targetMock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestManagerCopyDatabaseSkipsExistingTargetTables(t *testing.T) {
	sourceDB, sourceMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer sourceDB.Close()
	targetDB, targetMock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer targetDB.Close()

	m := &Manager{pools: map[string]*dbEntry{
		"src": {db: sourceDB},
		"dst": {db: targetDB},
	}}

	sourceMock.ExpectQuery(regexp.QuoteMeta(
		"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
	)).
		WithArgs("shop").
		WillReturnRows(sqlmock.NewRows([]string{"TABLE_NAME"}).
			AddRow("orders").
			AddRow("users"))

	targetMock.ExpectQuery(regexp.QuoteMeta(
		"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
	)).
		WithArgs("archive", "orders").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))

	targetMock.ExpectQuery(regexp.QuoteMeta(
		"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
	)).
		WithArgs("archive", "users").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	targetMock.ExpectQuery(regexp.QuoteMeta(
		"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
	)).
		WithArgs("archive", "users").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	sourceMock.ExpectQuery(regexp.QuoteMeta("SHOW CREATE TABLE `shop`.`users`")).
		WillReturnRows(sqlmock.NewRows([]string{"Table", "Create Table"}).
			AddRow("users", "CREATE TABLE `users` (`id` int NOT NULL) ENGINE=InnoDB"))
	targetMock.ExpectExec(regexp.QuoteMeta("CREATE TABLE `archive`.`users` (`id` int NOT NULL) ENGINE=InnoDB")).
		WillReturnResult(sqlmock.NewResult(0, 0))

	var progress []CopyProgressEvent
	result := m.CopyDatabase(context.Background(), CopyDatabaseConfig{
		SourceConnID:       "src",
		SourceDB:           "shop",
		TargetConnID:       "dst",
		TargetDB:           "archive",
		CopyStructure:      true,
		DropTargetIfExists: false,
	}, func(evt CopyProgressEvent) {
		progress = append(progress, evt)
	})

	if !result.Success || result.Error != "" {
		t.Fatalf("CopyDatabase result = %+v", result)
	}
	if !hasProgressStatus(progress, "Skipped existing table orders") {
		t.Fatalf("progress events = %+v, want skip event", progress)
	}
	if err := sourceMock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
	if err := targetMock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func hasProcessedRows(events []CopyProgressEvent, rows int) bool {
	for _, evt := range events {
		if evt.ProcessedRows == rows {
			return true
		}
	}
	return false
}

func hasProgressStatus(events []CopyProgressEvent, status string) bool {
	for _, evt := range events {
		if evt.Status == status {
			return true
		}
	}
	return false
}
