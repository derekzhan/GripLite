package main

import (
	"context"
	"testing"
	"time"

	"GripLite/internal/driver"
)

type queryContextDriver struct {
	sawDeadline bool
}

func (d *queryContextDriver) Connect(ctx context.Context) error { return nil }
func (d *queryContextDriver) Close(ctx context.Context) error   { return nil }
func (d *queryContextDriver) Ping(ctx context.Context) error    { return nil }
func (d *queryContextDriver) FetchDatabases(ctx context.Context) ([]string, error) {
	return nil, nil
}
func (d *queryContextDriver) FetchTables(ctx context.Context, dbName string) ([]driver.TableInfo, error) {
	return nil, nil
}
func (d *queryContextDriver) FetchTableDetail(ctx context.Context, dbName, tableName string) (*driver.TableDetail, error) {
	return nil, nil
}
func (d *queryContextDriver) ExecuteQuery(ctx context.Context, query string) (*driver.ResultSet, error) {
	return d.ExecuteQueryOnDB(ctx, "", query)
}
func (d *queryContextDriver) ExecuteQueryOnDB(ctx context.Context, dbName, query string) (*driver.ResultSet, error) {
	if _, ok := ctx.Deadline(); ok {
		d.sawDeadline = true
	}
	return &driver.ResultSet{
		Columns: []driver.ColumnInfo{{Name: "id", DatabaseType: "INT"}},
		Rows:    &emptyRowIterator{},
	}, nil
}
func (d *queryContextDriver) Kind() driver.DriverKind { return driver.DriverMySQL }
func (d *queryContextDriver) ServerVersion() string   { return "8.0-test" }

type mongoKindDriver struct {
	queryContextDriver
}

func (d *mongoKindDriver) Kind() driver.DriverKind { return driver.DriverMongoDB }

type emptyRowIterator struct{}

func (it *emptyRowIterator) Next() bool   { return false }
func (it *emptyRowIterator) Row() []any   { return nil }
func (it *emptyRowIterator) Err() error   { return nil }
func (it *emptyRowIterator) Close() error { return nil }

type blockingQueryDriver struct {
	started chan struct{}
}

func (d *blockingQueryDriver) Connect(ctx context.Context) error { return nil }
func (d *blockingQueryDriver) Close(ctx context.Context) error   { return nil }
func (d *blockingQueryDriver) Ping(ctx context.Context) error    { return nil }
func (d *blockingQueryDriver) FetchDatabases(ctx context.Context) ([]string, error) {
	return nil, nil
}
func (d *blockingQueryDriver) FetchTables(ctx context.Context, dbName string) ([]driver.TableInfo, error) {
	return nil, nil
}
func (d *blockingQueryDriver) FetchTableDetail(ctx context.Context, dbName, tableName string) (*driver.TableDetail, error) {
	return nil, nil
}
func (d *blockingQueryDriver) ExecuteQuery(ctx context.Context, query string) (*driver.ResultSet, error) {
	return d.ExecuteQueryOnDB(ctx, "", query)
}
func (d *blockingQueryDriver) ExecuteQueryOnDB(ctx context.Context, dbName, query string) (*driver.ResultSet, error) {
	close(d.started)
	<-ctx.Done()
	return nil, ctx.Err()
}
func (d *blockingQueryDriver) Kind() driver.DriverKind { return driver.DriverMySQL }
func (d *blockingQueryDriver) ServerVersion() string   { return "8.0-test" }

func appWithDriver(id string, drv driver.DatabaseDriver) *App {
	app := NewApp()
	app.ctx = context.Background()
	app.connections[id] = drv
	return app
}

func TestBuildPagedQuery(t *testing.T) {
	sql, err := buildPagedQuery(" select * from users; \n", 200, 400)
	if err != nil {
		t.Fatalf("buildPagedQuery returned error: %v", err)
	}
	want := "SELECT * FROM (select * from users) _griplite_page LIMIT 200 OFFSET 400"
	if sql != want {
		t.Fatalf("buildPagedQuery() = %q, want %q", sql, want)
	}
}

func TestBuildPagedQueryPreservesInnerLimit(t *testing.T) {
	sql, err := buildPagedQuery("SELECT * FROM users LIMIT 100000", 200, 0)
	if err != nil {
		t.Fatalf("buildPagedQuery returned error: %v", err)
	}
	want := "SELECT * FROM (SELECT * FROM users LIMIT 100000) _griplite_page LIMIT 200 OFFSET 0"
	if sql != want {
		t.Fatalf("buildPagedQuery() = %q, want %q", sql, want)
	}
}

func TestBuildPagedQueryRejectsNonSelect(t *testing.T) {
	if _, err := buildPagedQuery("SHOW TABLES", 200, 0); err == nil {
		t.Fatal("expected non-select query to be rejected")
	}
}

func TestRunQueryPageRejectsMongoDBDriver(t *testing.T) {
	app := appWithDriver("mongo-1", &mongoKindDriver{})

	result, err := app.RunQueryPage("mongo-1", "shop", "SELECT * FROM users", 0, 100)
	if err != nil {
		t.Fatalf("RunQueryPage returned error: %v", err)
	}
	if result.Error == "" {
		t.Fatalf("RunQueryPage should return an in-band error for MongoDB drivers")
	}
}

func TestConnectionSuccessMessageUsesDriverKind(t *testing.T) {
	mysqlMsg := connectionSuccessMessage(driver.DriverMySQL, "8.0.23")
	if mysqlMsg != "Successfully connected · MySQL 8.0.23" {
		t.Fatalf("mysql message = %q", mysqlMsg)
	}

	mongoMsg := connectionSuccessMessage(driver.DriverMongoDB, "8.0.23")
	if mongoMsg != "Successfully connected · MongoDB 8.0.23" {
		t.Fatalf("mongo message = %q", mongoMsg)
	}
}

func TestRunQueryDoesNotSetAutomaticQueryDeadline(t *testing.T) {
	drv := &queryContextDriver{}
	app := appWithDriver("conn-1", drv)

	result, err := app.RunQuery("conn-1", "shop", "SELECT * FROM orders")
	if err != nil {
		t.Fatalf("RunQuery returned error: %v", err)
	}
	if result.Error != "" {
		t.Fatalf("RunQuery result error = %q", result.Error)
	}
	if drv.sawDeadline {
		t.Fatal("RunQuery passed a context deadline to the driver; long queries should only stop on user cancel or app shutdown")
	}
}

func TestRunQueryPageDoesNotSetAutomaticQueryDeadline(t *testing.T) {
	drv := &queryContextDriver{}
	app := appWithDriver("conn-1", drv)

	result, err := app.RunQueryPage("conn-1", "shop", "SELECT * FROM orders", 0, 200)
	if err != nil {
		t.Fatalf("RunQueryPage returned error: %v", err)
	}
	if result.Error != "" {
		t.Fatalf("RunQueryPage result error = %q", result.Error)
	}
	if drv.sawDeadline {
		t.Fatal("RunQueryPage passed a context deadline to the driver; long queries should only stop on user cancel or app shutdown")
	}
}

func TestCancelQueryCancelsRunningQuery(t *testing.T) {
	drv := &blockingQueryDriver{started: make(chan struct{})}
	app := appWithDriver("conn-1", drv)
	done := make(chan *QueryResult, 1)

	go func() {
		result, err := app.RunQuery("conn-1", "shop", "SELECT SLEEP(100)")
		if err != nil {
			done <- &QueryResult{Error: err.Error()}
			return
		}
		done <- result
	}()

	select {
	case <-drv.started:
	case <-time.After(time.Second):
		t.Fatal("RunQuery did not start")
	}

	if err := app.CancelQuery("conn-1"); err != nil {
		t.Fatalf("CancelQuery returned error: %v", err)
	}

	select {
	case result := <-done:
		if result == nil || result.Error == "" {
			t.Fatalf("expected canceled query to return an error result, got %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("RunQuery did not return after CancelQuery")
	}
}
