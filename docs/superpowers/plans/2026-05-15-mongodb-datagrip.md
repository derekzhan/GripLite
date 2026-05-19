# MongoDB DataGrip-Style Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MongoDB connection, Mongo Shell/DataGrip Playground console execution, collection explorer, and collection data display without regressing existing MySQL functionality.

**Architecture:** Add an `internal/driver/mongodb` package registered through the existing driver registry. MongoDB console input is parsed by a controlled Goja JavaScript runtime into typed operation plans, then executed by the official MongoDB Go driver and converted into the existing `QueryResult` shape. Frontend components remain shared and branch on `connection.kind` only where MySQL and MongoDB behavior differs.

**Tech Stack:** Go 1.25, Wails v2, React 18, Monaco editor, `go.mongodb.org/mongo-driver/v2`, `github.com/dop251/goja`, existing `driver.DatabaseDriver`, existing `QueryResult`.

---

## File Map

- Create `internal/driver/mongodb/operation.go`: typed MongoDB operation plan, operation kind constants, read/write classification.
- Create `internal/driver/mongodb/shell.go`: controlled Goja runtime, shell expression evaluation, BSON helper functions, and JSON command detection.
- Create `internal/driver/mongodb/shell_test.go`: shell parser and read-only classification tests.
- Create `internal/driver/mongodb/result.go`: BSON/document conversion into `driver.ResultSet` rows.
- Create `internal/driver/mongodb/result_test.go`: conversion tests for ObjectID, dates, nested values, mixed fields, and write summaries.
- Create `internal/driver/mongodb/driver.go`: MongoDB driver lifecycle, registry, URI building, database/collection introspection, query execution dispatch.
- Create `internal/driver/mongodb/driver_test.go`: URI, driver metadata, and non-network helper tests.
- Modify `app.go`: import MongoDB driver, dispatch MongoDB through existing `RunQuery`, skip SQL pagination for MongoDB, and preserve MySQL behavior.
- Modify `frontend/src/lib/bridge.js`: add MongoDB mock saved connection and MongoDB mock query result/document metadata.
- Modify `frontend/src/components/ConnectionDialog.jsx`: add MySQL/MongoDB kind selector and MongoDB standard/SRV field behavior.
- Modify `frontend/src/components/DatabaseExplorer.jsx`: render collection semantics for `kind === "collection"` while keeping MySQL table/view semantics unchanged.
- Modify `frontend/src/components/SqlEditor.jsx`: show MongoDB placeholder/language when active connection kind is MongoDB.
- Modify `frontend/src/App.jsx`: pass active connection kind to editor/result/table viewer and preserve MySQL defaults.
- Modify `frontend/src/components/TableViewer.jsx`: add collection mode that hides MySQL-only schema editing and defaults collection data to MongoDB `find({}).limit(100)`.
- Modify `frontend/src/components/DataViewer.jsx`: expose `Grid`, `Record`, `Text` labels for MongoDB while keeping existing MySQL mode labels unless explicitly enabled.
- Modify `frontend/scripts/unit-tests.mjs`: add focused tests for MongoDB result mode labeling and mock metadata branching.

No git commit steps are included because commits require an explicit user request in this environment.

---

### Task 1: Backend Dependencies And Mongo Driver Skeleton

**Files:**
- Modify: `go.mod`
- Modify: `go.sum`
- Create: `internal/driver/mongodb/driver.go`
- Test: `internal/driver/mongodb/driver_test.go`

- [ ] **Step 1: Add dependencies**

Run:

```bash
go get go.mongodb.org/mongo-driver/v2 github.com/dop251/goja
```

Expected: `go.mod` includes both packages and `go.sum` updates.

- [ ] **Step 2: Write failing driver registration test**

Create `internal/driver/mongodb/driver_test.go` with:

```go
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
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
go test ./internal/driver/mongodb
```

Expected: fails because package/files do not exist or `buildURI`/registration is missing.

- [ ] **Step 4: Implement minimal driver skeleton**

Create `internal/driver/mongodb/driver.go`:

```go
package mongodb

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"time"

	"GripLite/internal/driver"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
)

const connectionModeParam = "_gripliteMongoConnectionMode"

func init() {
	driver.Register(driver.DriverMongoDB, func(cfg driver.ConnectionConfig) (driver.DatabaseDriver, error) {
		return New(cfg)
	})
}

type mongoDriver struct {
	cfg           driver.ConnectionConfig
	client        *mongo.Client
	serverVersion string
}

func New(cfg driver.ConnectionConfig) (*mongoDriver, error) {
	if cfg.Host == "" {
		return nil, fmt.Errorf("mongodb: host is required")
	}
	if cfg.Port == 0 {
		cfg.Port = 27017
	}
	return &mongoDriver{cfg: cfg}, nil
}

func (d *mongoDriver) Connect(ctx context.Context) error {
	if d.client != nil {
		return driver.ErrAlreadyConnected
	}
	timeout := d.cfg.ConnectTimeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	mode := mongoConnectionMode(d.cfg)
	client, err := mongo.Connect(options.Client().
		ApplyURI(buildURI(d.cfg, mode)).
		SetConnectTimeout(timeout).
		SetServerSelectionTimeout(timeout))
	if err != nil {
		return fmt.Errorf("mongodb: connect: %w", err)
	}
	if err := client.Ping(ctx, readpref.Primary()); err != nil {
		_ = client.Disconnect(context.Background())
		return fmt.Errorf("mongodb: ping: %w", err)
	}
	var buildInfo bson.M
	if err := client.Database("admin").RunCommand(ctx, bson.D{{Key: "buildInfo", Value: 1}}).Decode(&buildInfo); err == nil {
		if version, ok := buildInfo["version"].(string); ok {
			d.serverVersion = version
		}
	}
	d.client = client
	return nil
}

func (d *mongoDriver) Close(ctx context.Context) error {
	if d.client == nil {
		return nil
	}
	err := d.client.Disconnect(ctx)
	d.client = nil
	return err
}

func (d *mongoDriver) Ping(ctx context.Context) error {
	if d.client == nil {
		return driver.ErrNotConnected
	}
	return d.client.Ping(ctx, readpref.Primary())
}

func (d *mongoDriver) FetchDatabases(ctx context.Context) ([]string, error) {
	if d.client == nil {
		return nil, driver.ErrNotConnected
	}
	return d.client.ListDatabaseNames(ctx, bson.D{})
}

func (d *mongoDriver) FetchTables(ctx context.Context, dbName string) ([]driver.TableInfo, error) {
	if d.client == nil {
		return nil, driver.ErrNotConnected
	}
	names, err := d.client.Database(dbName).ListCollectionNames(ctx, bson.D{})
	if err != nil {
		return nil, fmt.Errorf("mongodb: list collections: %w", err)
	}
	out := make([]driver.TableInfo, 0, len(names))
	for _, name := range names {
		out = append(out, driver.TableInfo{
			Name:     name,
			Schema:   dbName,
			Kind:     driver.ObjectCollection,
			RowCount: -1,
			SizeBytes: -1,
		})
	}
	return out, nil
}

func (d *mongoDriver) FetchTableDetail(ctx context.Context, dbName, tableName string) (*driver.TableDetail, error) {
	return nil, driver.ErrUnsupported
}

func (d *mongoDriver) ExecuteQuery(ctx context.Context, query string) (*driver.ResultSet, error) {
	return d.ExecuteQueryOnDB(ctx, d.cfg.Database, query)
}

func (d *mongoDriver) ExecuteQueryOnDB(ctx context.Context, dbName, query string) (*driver.ResultSet, error) {
	return nil, driver.ErrUnsupported
}

func (d *mongoDriver) Kind() driver.DriverKind { return driver.DriverMongoDB }

func (d *mongoDriver) ServerVersion() string { return d.serverVersion }

func mongoConnectionMode(cfg driver.ConnectionConfig) string {
	for _, p := range cfg.AdvancedParams {
		if p.Key == connectionModeParam && p.Enabled && p.Value == "srv" {
			return "srv"
		}
	}
	return "standard"
}

func buildURI(cfg driver.ConnectionConfig, mode string) string {
	auth := ""
	if cfg.Username != "" {
		auth = url.QueryEscape(cfg.Username)
		if cfg.Password != "" {
			auth += ":" + url.QueryEscape(cfg.Password)
		}
		auth += "@"
	}
	dbName := cfg.Database
	if dbName == "" {
		dbName = "admin"
	}
	if mode == "srv" {
		return "mongodb+srv://" + auth + cfg.Host + "/" + dbName
	}
	port := cfg.Port
	if port == 0 {
		port = 27017
	}
	return "mongodb://" + auth + cfg.Host + ":" + strconv.Itoa(port) + "/" + dbName
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
go test ./internal/driver/mongodb
```

Expected: PASS.

---

### Task 2: Mongo Shell Operation Planning

**Files:**
- Create: `internal/driver/mongodb/operation.go`
- Create: `internal/driver/mongodb/shell.go`
- Test: `internal/driver/mongodb/shell_test.go`

- [ ] **Step 1: Write failing shell parser tests**

Create `internal/driver/mongodb/shell_test.go`:

```go
package mongodb

import "testing"

func TestParseShellFindWithLimitAndSort(t *testing.T) {
	op, err := ParseMongoOperation("orders", `db.prm_order.find({ partner_id: { $in: [178, 276] } }).sort({ created_at: -1 }).limit(20)`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opFind || op.Database != "orders" || op.Collection != "prm_order" {
		t.Fatalf("op identity = %#v", op)
	}
	if op.Limit != 20 {
		t.Fatalf("Limit = %d, want 20", op.Limit)
	}
	if op.Filter == nil || op.Sort == nil {
		t.Fatalf("Filter/Sort not captured: %#v", op)
	}
}

func TestParseJSONCommand(t *testing.T) {
	op, err := ParseMongoOperation("orders", `{ "find": "prm_order", "filter": { "status": "paid" } }`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if op.Kind != opCommand || op.Database != "orders" {
		t.Fatalf("op = %#v", op)
	}
	if op.Command == nil {
		t.Fatalf("Command not captured")
	}
}

func TestWriteOperationsAreClassified(t *testing.T) {
	for _, input := range []string{
		`db.orders.insertOne({ status: "new" })`,
		`db.orders.updateOne({ _id: ObjectId("507f1f77bcf86cd799439011") }, { $set: { status: "paid" } })`,
		`db.orders.deleteMany({})`,
		`db.orders.drop()`,
	} {
		op, err := ParseMongoOperation("orders", input)
		if err != nil {
			t.Fatalf("ParseMongoOperation(%q) error: %v", input, err)
		}
		if !op.IsWrite() {
			t.Fatalf("%q classified as read: %#v", input, op)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
go test ./internal/driver/mongodb -run 'TestParse|TestWrite'
```

Expected: fails because parser and operation types do not exist.

- [ ] **Step 3: Implement operation plan types**

Create `internal/driver/mongodb/operation.go`:

```go
package mongodb

type operationKind string

const (
	opFind                   operationKind = "find"
	opAggregate              operationKind = "aggregate"
	opCountDocuments         operationKind = "countDocuments"
	opEstimatedDocumentCount operationKind = "estimatedDocumentCount"
	opDistinct               operationKind = "distinct"
	opInsertOne              operationKind = "insertOne"
	opInsertMany             operationKind = "insertMany"
	opUpdateOne              operationKind = "updateOne"
	opUpdateMany             operationKind = "updateMany"
	opReplaceOne             operationKind = "replaceOne"
	opDeleteOne              operationKind = "deleteOne"
	opDeleteMany             operationKind = "deleteMany"
	opCreateIndex            operationKind = "createIndex"
	opDropIndex              operationKind = "dropIndex"
	opDrop                   operationKind = "drop"
	opCommand                operationKind = "command"
)

type mongoOperation struct {
	Kind       operationKind
	Database   string
	Collection string
	Filter     map[string]any
	Projection map[string]any
	Sort       map[string]any
	Pipeline   []any
	Documents  []any
	Update     map[string]any
	Replacement map[string]any
	Command    map[string]any
	DistinctField string
	IndexKeys  map[string]any
	IndexName  string
	Skip       int64
	Limit      int64
}

func (op mongoOperation) IsWrite() bool {
	switch op.Kind {
	case opInsertOne, opInsertMany, opUpdateOne, opUpdateMany, opReplaceOne,
		opDeleteOne, opDeleteMany, opCreateIndex, opDropIndex, opDrop:
		return true
	default:
		return false
	}
}
```

- [ ] **Step 4: Implement controlled Goja parser**

Create `internal/driver/mongodb/shell.go`:

```go
package mongodb

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/dop251/goja"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func ParseMongoOperation(dbName, input string) (*mongoOperation, error) {
	text := strings.TrimSpace(input)
	if text == "" {
		return nil, fmt.Errorf("mongodb: empty console input")
	}
	if strings.HasPrefix(text, "{") {
		var cmd map[string]any
		if err := json.Unmarshal([]byte(text), &cmd); err == nil {
			return &mongoOperation{Kind: opCommand, Database: dbName, Command: cmd}, nil
		}
	}

	vm := goja.New()
	var captured *mongoOperation
	capture := func(op *mongoOperation) *mongoOperation {
		captured = op
		return op
	}
	vm.Set("ObjectId", func(s string) map[string]any { return map[string]any{"$oid": s} })
	vm.Set("ISODate", func(s string) map[string]any { return map[string]any{"$date": s} })
	vm.Set("NumberInt", func(v int32) int32 { return v })
	vm.Set("NumberLong", func(v int64) int64 { return v })
	vm.Set("Decimal128", func(s string) map[string]any { return map[string]any{"$numberDecimal": s} })

	db := vm.NewObject()
	_ = db.Set("getCollection", func(name string) *goja.Object {
		return collectionObject(vm, dbName, name, capture)
	})
	_ = db.Set("runCommand", func(call goja.FunctionCall) goja.Value {
		op := &mongoOperation{Kind: opCommand, Database: dbName, Command: exportMap(call.Argument(0))}
		capture(op)
		return vm.ToValue(op)
	})
	vm.Set("db", db)

	script := rewriteDotCollectionAccess(text)
	if _, err := vm.RunString(script); err != nil {
		return nil, fmt.Errorf("mongodb: parse shell input: %w", err)
	}
	if captured == nil {
		return nil, fmt.Errorf("mongodb: input did not produce a MongoDB operation")
	}
	return captured, nil
}

func rewriteDotCollectionAccess(input string) string {
	re := regexp.MustCompile(`\bdb\.([A-Za-z_][A-Za-z0-9_]*)\b`)
	return re.ReplaceAllStringFunc(input, func(match string) string {
		name := strings.TrimPrefix(match, "db.")
		if name == "getCollection" || name == "runCommand" {
			return match
		}
		return `db.getCollection("` + name + `")`
	})
}

func collectionObject(vm *goja.Runtime, dbName, coll string, capture func(*mongoOperation) *mongoOperation) *goja.Object {
	obj := vm.NewObject()
	withCursor := func(op *mongoOperation) *goja.Object {
		capture(op)
		cur := vm.NewObject()
		_ = cur.Set("sort", func(call goja.FunctionCall) *goja.Object {
			op.Sort = exportMap(call.Argument(0))
			return cur
		})
		_ = cur.Set("project", func(call goja.FunctionCall) *goja.Object {
			op.Projection = exportMap(call.Argument(0))
			return cur
		})
		_ = cur.Set("skip", func(v int64) *goja.Object {
			op.Skip = v
			return cur
		})
		_ = cur.Set("limit", func(v int64) *goja.Object {
			op.Limit = v
			return cur
		})
		_ = cur.Set("toArray", func() *mongoOperation { return op })
		return cur
	}
	_ = obj.Set("find", func(call goja.FunctionCall) *goja.Object {
		return withCursor(&mongoOperation{Kind: opFind, Database: dbName, Collection: coll, Filter: exportMap(call.Argument(0))})
	})
	_ = obj.Set("aggregate", func(call goja.FunctionCall) *goja.Object {
		return withCursor(&mongoOperation{Kind: opAggregate, Database: dbName, Collection: coll, Pipeline: exportArray(call.Argument(0))})
	})
	_ = obj.Set("countDocuments", func(call goja.FunctionCall) *mongoOperation {
		return capture(&mongoOperation{Kind: opCountDocuments, Database: dbName, Collection: coll, Filter: exportMap(call.Argument(0))})
	})
	_ = obj.Set("estimatedDocumentCount", func() *mongoOperation {
		return capture(&mongoOperation{Kind: opEstimatedDocumentCount, Database: dbName, Collection: coll})
	})
	_ = obj.Set("distinct", func(field string, filter map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opDistinct, Database: dbName, Collection: coll, DistinctField: field, Filter: filter})
	})
	_ = obj.Set("insertOne", func(doc map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opInsertOne, Database: dbName, Collection: coll, Documents: []any{doc}})
	})
	_ = obj.Set("insertMany", func(docs []any) *mongoOperation {
		return capture(&mongoOperation{Kind: opInsertMany, Database: dbName, Collection: coll, Documents: docs})
	})
	_ = obj.Set("updateOne", func(filter, update map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opUpdateOne, Database: dbName, Collection: coll, Filter: filter, Update: update})
	})
	_ = obj.Set("updateMany", func(filter, update map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opUpdateMany, Database: dbName, Collection: coll, Filter: filter, Update: update})
	})
	_ = obj.Set("replaceOne", func(filter, replacement map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opReplaceOne, Database: dbName, Collection: coll, Filter: filter, Replacement: replacement})
	})
	_ = obj.Set("deleteOne", func(filter map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opDeleteOne, Database: dbName, Collection: coll, Filter: filter})
	})
	_ = obj.Set("deleteMany", func(filter map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opDeleteMany, Database: dbName, Collection: coll, Filter: filter})
	})
	_ = obj.Set("createIndex", func(keys map[string]any) *mongoOperation {
		return capture(&mongoOperation{Kind: opCreateIndex, Database: dbName, Collection: coll, IndexKeys: keys})
	})
	_ = obj.Set("dropIndex", func(name string) *mongoOperation {
		return capture(&mongoOperation{Kind: opDropIndex, Database: dbName, Collection: coll, IndexName: name})
	})
	_ = obj.Set("drop", func() *mongoOperation {
		return capture(&mongoOperation{Kind: opDrop, Database: dbName, Collection: coll})
	})
	return obj
}

func exportMap(v goja.Value) map[string]any {
	if goja.IsUndefined(v) || goja.IsNull(v) {
		return map[string]any{}
	}
	if m, ok := v.Export().(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func exportArray(v goja.Value) []any {
	if goja.IsUndefined(v) || goja.IsNull(v) {
		return []any{}
	}
	if a, ok := v.Export().([]any); ok {
		return a
	}
	return []any{}
}

func toBSONDocument(m map[string]any) bson.D {
	out := make(bson.D, 0, len(m))
	for k, v := range m {
		out = append(out, bson.E{Key: k, Value: normalizeBSONValue(v)})
	}
	return out
}

func normalizeBSONValue(v any) any {
	if m, ok := v.(map[string]any); ok {
		if oid, ok := m["$oid"].(string); ok {
			if id, err := bson.ObjectIDFromHex(oid); err == nil {
				return id
			}
		}
		if ds, ok := m["$date"].(string); ok {
			if t, err := time.Parse(time.RFC3339, ds); err == nil {
				return t
			}
		}
		return toBSONDocument(m)
	}
	if arr, ok := v.([]any); ok {
		for i := range arr {
			arr[i] = normalizeBSONValue(arr[i])
		}
	}
	return v
}
```

- [ ] **Step 5: Run parser tests**

Run:

```bash
go test ./internal/driver/mongodb -run 'TestParse|TestWrite'
```

Expected: PASS.

---

### Task 3: Result Conversion

**Files:**
- Create: `internal/driver/mongodb/result.go`
- Test: `internal/driver/mongodb/result_test.go`

- [ ] **Step 1: Write failing BSON conversion tests**

Create `internal/driver/mongodb/result_test.go`:

```go
package mongodb

import (
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestDocumentsToResultSetInfersColumnsAndSerializesNestedValues(t *testing.T) {
	id := bson.NewObjectID()
	docs := []bson.M{
		{"_id": id, "name": "Alice", "meta": bson.M{"tier": "gold"}, "tags": bson.A{"a", "b"}},
		{"_id": bson.NewObjectID(), "active": true, "created_at": time.Date(2026, 5, 15, 0, 0, 0, 0, time.UTC)},
	}

	rs := documentsToResultSet(docs, 15)
	if len(rs.Columns) != 6 {
		t.Fatalf("column count = %d, want 6: %#v", len(rs.Columns), rs.Columns)
	}
	row := rs.Rows.Row()
	if len(row) != 0 {
		t.Fatalf("Row before Next = %#v, want empty zero row", row)
	}
	if !rs.Rows.Next() {
		t.Fatalf("expected first row")
	}
	first := rs.Rows.Row()
	if first[0] != id.Hex() {
		t.Fatalf("_id = %#v, want %q", first[0], id.Hex())
	}
	if first[2] != `{"tier":"gold"}` {
		t.Fatalf("meta = %#v", first[2])
	}
	if rs.ExecutionTime.Milliseconds() != 15 {
		t.Fatalf("ExecutionTime = %v", rs.ExecutionTime)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
go test ./internal/driver/mongodb -run TestDocumentsToResultSet
```

Expected: fails because result conversion does not exist.

- [ ] **Step 3: Implement result conversion**

Create `internal/driver/mongodb/result.go`:

```go
package mongodb

import (
	"encoding/json"
	"sort"
	"time"

	"GripLite/internal/driver"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type sliceIterator struct {
	rows []driver.Row
	idx  int
}

func (it *sliceIterator) Next() bool {
	if it.idx >= len(it.rows) {
		return false
	}
	it.idx++
	return true
}

func (it *sliceIterator) Row() driver.Row {
	if it.idx == 0 || it.idx > len(it.rows) {
		return driver.Row{}
	}
	return it.rows[it.idx-1]
}

func (it *sliceIterator) Err() error { return nil }
func (it *sliceIterator) Close() error { return nil }

func documentsToResultSet(docs []bson.M, execMs int64) *driver.ResultSet {
	columns := inferColumns(docs)
	rows := make([]driver.Row, 0, len(docs))
	for _, doc := range docs {
		row := make(driver.Row, len(columns))
		for i, col := range columns {
			row[i] = mongoCellValue(doc[col.Name])
		}
		rows = append(rows, row)
	}
	return &driver.ResultSet{
		Columns: columns,
		Rows: &sliceIterator{rows: rows},
		ExecutionTime: time.Duration(execMs) * time.Millisecond,
	}
}

func inferColumns(docs []bson.M) []driver.ColumnInfo {
	seen := map[string]bool{}
	names := []string{}
	add := func(name string) {
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	add("_id")
	for _, doc := range docs {
		keys := make([]string, 0, len(doc))
		for k := range doc {
			if k != "_id" {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			add(k)
		}
	}
	cols := make([]driver.ColumnInfo, len(names))
	for i, name := range names {
		cols[i] = driver.ColumnInfo{Name: name, DatabaseType: "BSON", Nullable: true, PrimaryKey: name == "_id", Ordinal: i}
	}
	return cols
}

func mongoCellValue(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case bson.ObjectID:
		return x.Hex()
	case time.Time:
		return x.UTC().Format(time.RFC3339Nano)
	case bson.M, bson.D, bson.A, []any, map[string]any:
		b, err := json.Marshal(x)
		if err != nil {
			return ""
		}
		return string(b)
	default:
		return x
	}
}

func writeSummaryResult(rowsAffected int64, execMs int64, summary map[string]any) *driver.ResultSet {
	doc := bson.M(summary)
	rs := documentsToResultSet([]bson.M{doc}, execMs)
	rs.RowsAffected = rowsAffected
	return rs
}
```

- [ ] **Step 4: Run conversion tests**

Run:

```bash
go test ./internal/driver/mongodb -run TestDocumentsToResultSet
```

Expected: PASS.

---

### Task 4: MongoDB Operation Execution

**Files:**
- Modify: `internal/driver/mongodb/driver.go`
- Modify: `internal/driver/mongodb/shell.go`
- Test: `internal/driver/mongodb/shell_test.go`

- [ ] **Step 1: Add read-only enforcement test**

Append to `internal/driver/mongodb/shell_test.go`:

```go
func TestReadOnlyRejectsWriteOperation(t *testing.T) {
	op, err := ParseMongoOperation("orders", `db.orders.deleteOne({ status: "bad" })`)
	if err != nil {
		t.Fatalf("ParseMongoOperation returned error: %v", err)
	}
	if err := validateOperationAllowed(*op, true); err == nil {
		t.Fatalf("validateOperationAllowed returned nil for write on read-only connection")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
go test ./internal/driver/mongodb -run TestReadOnlyRejectsWriteOperation
```

Expected: fails because `validateOperationAllowed` does not exist.

- [ ] **Step 3: Implement execution dispatch and read-only guard**

Modify `internal/driver/mongodb/driver.go`:

```go
func (d *mongoDriver) ExecuteQueryOnDB(ctx context.Context, dbName, query string) (*driver.ResultSet, error) {
	if d.client == nil {
		return nil, driver.ErrNotConnected
	}
	if dbName == "" {
		dbName = d.cfg.Database
	}
	if dbName == "" {
		dbName = "admin"
	}
	op, err := ParseMongoOperation(dbName, query)
	if err != nil {
		return nil, err
	}
	if err := validateOperationAllowed(*op, d.cfg.ReadOnly); err != nil {
		return nil, err
	}
	start := time.Now()
	rs, err := d.executeOperation(ctx, *op)
	if err != nil {
		return nil, err
	}
	rs.ExecutionTime = time.Since(start)
	return rs, nil
}

func validateOperationAllowed(op mongoOperation, readOnly bool) error {
	if readOnly && op.IsWrite() {
		return fmt.Errorf("mongodb: read-only connection blocks %s", op.Kind)
	}
	return nil
}

func (d *mongoDriver) executeOperation(ctx context.Context, op mongoOperation) (*driver.ResultSet, error) {
	db := d.client.Database(op.Database)
	coll := db.Collection(op.Collection)
	switch op.Kind {
	case opFind:
		opts := options.Find()
		if op.Limit > 0 { opts.SetLimit(op.Limit) }
		if op.Skip > 0 { opts.SetSkip(op.Skip) }
		if op.Sort != nil { opts.SetSort(toBSONDocument(op.Sort)) }
		if op.Projection != nil { opts.SetProjection(toBSONDocument(op.Projection)) }
		cur, err := coll.Find(ctx, toBSONDocument(op.Filter), opts)
		if err != nil { return nil, fmt.Errorf("mongodb: find: %w", err) }
		defer cur.Close(ctx)
		var docs []bson.M
		if err := cur.All(ctx, &docs); err != nil { return nil, fmt.Errorf("mongodb: read cursor: %w", err) }
		return documentsToResultSet(docs, 0), nil
	case opAggregate:
		cur, err := coll.Aggregate(ctx, op.Pipeline)
		if err != nil { return nil, fmt.Errorf("mongodb: aggregate: %w", err) }
		defer cur.Close(ctx)
		var docs []bson.M
		if err := cur.All(ctx, &docs); err != nil { return nil, fmt.Errorf("mongodb: read cursor: %w", err) }
		return documentsToResultSet(docs, 0), nil
	case opCountDocuments:
		n, err := coll.CountDocuments(ctx, toBSONDocument(op.Filter))
		if err != nil { return nil, fmt.Errorf("mongodb: countDocuments: %w", err) }
		return writeSummaryResult(0, 0, map[string]any{"count": n}), nil
	case opEstimatedDocumentCount:
		n, err := coll.EstimatedDocumentCount(ctx)
		if err != nil { return nil, fmt.Errorf("mongodb: estimatedDocumentCount: %w", err) }
		return writeSummaryResult(0, 0, map[string]any{"count": n}), nil
	case opCommand:
		var doc bson.M
		if err := db.RunCommand(ctx, toBSONDocument(op.Command)).Decode(&doc); err != nil {
			return nil, fmt.Errorf("mongodb: runCommand: %w", err)
		}
		return documentsToResultSet([]bson.M{doc}, 0), nil
	case opInsertOne:
		res, err := coll.InsertOne(ctx, normalizeBSONValue(op.Documents[0]))
		if err != nil { return nil, fmt.Errorf("mongodb: insertOne: %w", err) }
		return writeSummaryResult(1, 0, map[string]any{"insertedId": mongoCellValue(res.InsertedID)}), nil
	case opUpdateOne:
		res, err := coll.UpdateOne(ctx, toBSONDocument(op.Filter), toBSONDocument(op.Update))
		if err != nil { return nil, fmt.Errorf("mongodb: updateOne: %w", err) }
		return writeSummaryResult(res.ModifiedCount, 0, map[string]any{"matchedCount": res.MatchedCount, "modifiedCount": res.ModifiedCount}), nil
	case opDeleteOne:
		res, err := coll.DeleteOne(ctx, toBSONDocument(op.Filter))
		if err != nil { return nil, fmt.Errorf("mongodb: deleteOne: %w", err) }
		return writeSummaryResult(res.DeletedCount, 0, map[string]any{"deletedCount": res.DeletedCount}), nil
	default:
	case opInsertMany:
		docs := make([]any, len(op.Documents))
		for i, doc := range op.Documents { docs[i] = normalizeBSONValue(doc) }
		res, err := coll.InsertMany(ctx, docs)
		if err != nil { return nil, fmt.Errorf("mongodb: insertMany: %w", err) }
		return writeSummaryResult(int64(len(res.InsertedIDs)), 0, map[string]any{"insertedCount": len(res.InsertedIDs)}), nil
	case opUpdateMany:
		res, err := coll.UpdateMany(ctx, toBSONDocument(op.Filter), toBSONDocument(op.Update))
		if err != nil { return nil, fmt.Errorf("mongodb: updateMany: %w", err) }
		return writeSummaryResult(res.ModifiedCount, 0, map[string]any{"matchedCount": res.MatchedCount, "modifiedCount": res.ModifiedCount}), nil
	case opReplaceOne:
		res, err := coll.ReplaceOne(ctx, toBSONDocument(op.Filter), normalizeBSONValue(op.Replacement))
		if err != nil { return nil, fmt.Errorf("mongodb: replaceOne: %w", err) }
		return writeSummaryResult(res.ModifiedCount, 0, map[string]any{"matchedCount": res.MatchedCount, "modifiedCount": res.ModifiedCount}), nil
	case opDeleteMany:
		res, err := coll.DeleteMany(ctx, toBSONDocument(op.Filter))
		if err != nil { return nil, fmt.Errorf("mongodb: deleteMany: %w", err) }
		return writeSummaryResult(res.DeletedCount, 0, map[string]any{"deletedCount": res.DeletedCount}), nil
	case opDistinct:
		vals, err := coll.Distinct(ctx, op.DistinctField, toBSONDocument(op.Filter))
		if err != nil { return nil, fmt.Errorf("mongodb: distinct: %w", err) }
		docs := make([]bson.M, 0, len(vals))
		for _, val := range vals { docs = append(docs, bson.M{"value": val}) }
		return documentsToResultSet(docs, 0), nil
	case opCreateIndex:
		name, err := coll.Indexes().CreateOne(ctx, mongo.IndexModel{Keys: toBSONDocument(op.IndexKeys)})
		if err != nil { return nil, fmt.Errorf("mongodb: createIndex: %w", err) }
		return writeSummaryResult(0, 0, map[string]any{"createdIndex": name}), nil
	case opDropIndex:
		_, err := coll.Indexes().DropOne(ctx, op.IndexName)
		if err != nil { return nil, fmt.Errorf("mongodb: dropIndex: %w", err) }
		return writeSummaryResult(0, 0, map[string]any{"droppedIndex": op.IndexName}), nil
	case opDrop:
		if err := coll.Drop(ctx); err != nil { return nil, fmt.Errorf("mongodb: drop: %w", err) }
		return writeSummaryResult(0, 0, map[string]any{"dropped": op.Collection}), nil
	default:
		return nil, fmt.Errorf("mongodb: unsupported operation %s", op.Kind)
	}
}
```

- [ ] **Step 4: Run backend MongoDB package tests**

Run:

```bash
go test ./internal/driver/mongodb
```

Expected: PASS.

---

### Task 5: App Integration Without MySQL Regression

**Files:**
- Modify: `app.go`
- Modify: `frontend/wailsjs/go/main/App.d.ts` and `frontend/wailsjs/go/main/App.js` via Wails generation if required.
- Test: existing Go tests.

- [ ] **Step 1: Write failing app-level test for MongoDB dispatch safety**

Append to `app_test.go`:

```go
func TestIsPageableQueryRejectsMongoShell(t *testing.T) {
	if isPageableQuery(`db.orders.find({})`) {
		t.Fatalf("Mongo shell input must not be treated as pageable SQL")
	}
}
```

- [ ] **Step 2: Run test**

Run:

```bash
go test ./...
```

Expected before integration: existing tests pass or this new test passes immediately. If it passes immediately, keep it as a regression test and continue.

- [ ] **Step 3: Import MongoDB driver for registration**

Modify `app.go` imports:

```go
	mysqlpkg "GripLite/internal/driver/mysql"
	_ "GripLite/internal/driver/mongodb"
```

Keep the MySQL package variable reference if currently needed:

```go
var _ = mysqlpkg.New
```

- [ ] **Step 4: Skip SQL pool manager for MongoDB**

In `AddConnection`, only call `a.dbMgr.Connect` when `cfg.Kind == driver.DriverMySQL`. MongoDB connections should use only the `driver.DatabaseDriver` layer because `database.Manager` is `database/sql`/MySQL-specific.

- [ ] **Step 5: Preserve RunQuery dispatch**

Keep `RunQuery` calling `drv.ExecuteQueryOnDB(ctx, dbName, sql)` after `ensureLive`. Do not add MongoDB-specific frontend APIs unless needed.

- [ ] **Step 6: Disable RunQueryPage for MongoDB**

In `RunQueryPage`, after `ensureLive`, check `drv.Kind()`. If it is MongoDB, return an error such as:

```go
return nil, fmt.Errorf("paged SQL loading is only supported for MySQL")
```

The MongoDB collection viewer should call `RunQuery` with `.limit(...)`.

- [ ] **Step 7: Run all Go tests**

Run:

```bash
go test ./...
```

Expected: PASS. Existing MySQL tests must remain unchanged.

---

### Task 6: Connection Dialog MongoDB Mode

**Files:**
- Modify: `frontend/src/components/ConnectionDialog.jsx`
- Modify: `frontend/src/lib/bridge.js`
- Test: `npm run test`

- [ ] **Step 1: Add browser mock MongoDB saved connection**

Modify `MOCK_SAVED` in `frontend/src/lib/bridge.js` to include:

```js
{
  id: 'mock-mongo-1',
  name: 'MongoDB Atlas (mock)',
  comment: 'Mock MongoDB SRV connection',
  kind: 'mongodb',
  host: 'cluster.example.mongodb.net',
  port: 27017,
  username: 'demo',
  password: '',
  database: 'admin',
  tls: true,
  ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password', password: '', privateKeyPath: '' },
  advancedParams: [
    { key: '_gripliteMongoConnectionMode', value: 'srv', enabled: true },
  ],
  readOnly: false,
  color: '',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
}
```

- [ ] **Step 2: Extend form defaults**

In `ConnectionDialog.jsx`, update `emptyForm()` so `kind` remains `'mysql'` by default and MongoDB uses port `27017` only when the user selects MongoDB.

- [ ] **Step 3: Add type selector**

Add a selector near the top of the General tab:

```jsx
<select
  value={form.kind}
  onChange={(e) => {
    const kind = e.target.value
    setForm((f) => ({
      ...f,
      kind,
      port: kind === 'mongodb' ? 27017 : 3306,
      tls: kind === 'mongodb' ? true : f.tls,
    }))
  }}
>
  <option value="mysql">MySQL</option>
  <option value="mongodb">MongoDB</option>
</select>
```

- [ ] **Step 4: Add MongoDB standard/SRV toggle**

When `form.kind === 'mongodb'`, show a connection type segmented control with `standard` and `srv`. Store its value in hidden advanced param `_gripliteMongoConnectionMode`. Do not render that param in the visible advanced options list.

- [ ] **Step 5: Preserve MySQL UI**

Confirm that when `form.kind === 'mysql'`, existing labels, JDBC URL preview, port default, SSH tab, advanced params, and test/save behavior render as before.

- [ ] **Step 6: Run frontend tests/build**

Run:

```bash
cd frontend && npm run test && npm run build
```

Expected: PASS.

---

### Task 7: Explorer And Console Kind Branching

**Files:**
- Modify: `frontend/src/components/DatabaseExplorer.jsx`
- Modify: `frontend/src/components/SqlEditor.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/lib/bridge.js`
- Test: `cd frontend && npm run test`

- [ ] **Step 1: Add MongoDB mock metadata**

In `fetchDatabases`, return MongoDB database names for mock Mongo connections. In `fetchTables`, return collections with `kind: 'collection'`.

- [ ] **Step 2: Render collection labels/icons**

In `DatabaseExplorer.jsx`, when node kind is `collection`, use collection wording in titles/context hints. Keep MySQL `table` and `view` labels unchanged.

- [ ] **Step 3: Pass active connection kind to console**

In `App.jsx`, pass `connInfo?.kind` into `SqlEditor` as `connectionKind`.

- [ ] **Step 4: Add MongoDB editor placeholder**

In `SqlEditor.jsx`, when `connectionKind === 'mongodb'`, use JavaScript mode or plain text mode and placeholder:

```js
db.prm_order.find({ partner_id: { $in: [178, 276] } }).limit(100)
```

When MySQL, preserve the current SQL placeholder, formatting, split statement behavior, and keyboard shortcuts.

- [ ] **Step 5: Run frontend tests**

Run:

```bash
cd frontend && npm run test
```

Expected: PASS.

---

### Task 8: Collection Data View Modes

**Files:**
- Modify: `frontend/src/components/TableViewer.jsx`
- Modify: `frontend/src/components/DataViewer.jsx`
- Modify: `frontend/src/components/PagedResultViewer.jsx`
- Modify: `frontend/src/App.jsx`
- Test: `cd frontend && npm run test && npm run build`

- [ ] **Step 1: Pass table/collection kind**

When opening a node from `DatabaseExplorer`, include `tableKind` or `objectKind` in the `onTableOpen` payload. Store it in the tab object in `App.jsx`, and pass it to `TableViewer`.

- [ ] **Step 2: Default MongoDB data query**

In `TableViewer` `DataView`, if `objectKind === 'collection'`, use:

```js
db.getCollection("${tableName.replace(/"/g, '\\"')}").find({}).limit(100)
```

and call `runQuery(connId, dbName, mongoQuery)` instead of SQL pagination.

- [ ] **Step 3: Hide MySQL-only controls for collections**

For collection tabs, hide or disable:

- SQL `WHERE` filter bar.
- inline add/delete/apply edit controls.
- Properties schema designer controls for columns/indexes/constraints/partitions.

Show a simple read-only collection metadata panel until MongoDB editing is separately designed.

- [ ] **Step 4: Map display modes**

For MongoDB collection results, present the mode toggle labels as:

- `Data` for the existing record/document view.
- `Grid` for the existing grid view.
- `Text` for pretty JSON.

For MySQL, preserve current labels and behavior unless the existing label already matches.

- [ ] **Step 5: Run frontend tests/build**

Run:

```bash
cd frontend && npm run test && npm run build
```

Expected: PASS.

---

### Task 9: Full Verification And MySQL Regression

**Files:**
- No new files unless fixing verification failures.

- [ ] **Step 1: Run backend tests**

Run:

```bash
go test ./...
```

Expected: PASS.

- [ ] **Step 2: Run frontend tests and build**

Run:

```bash
cd frontend && npm run test && npm run build
```

Expected: PASS.

- [ ] **Step 3: Run MySQL manual regression**

Verify in the app:

- Existing MySQL saved connection still appears.
- MySQL connection test still works.
- SQL console still runs `SELECT 1`.
- Explorer still shows MySQL databases, tables, and views.
- Double-click MySQL table still opens the existing table viewer.
- MySQL table properties still load.
- MySQL data pagination and mode switching still work.

- [ ] **Step 4: Run MongoDB manual verification**

Verify in the app:

- Standard MongoDB connection saves and connects.
- Atlas SRV connection saves and connects.
- Console runs `db.collection.find({}).limit(10)`.
- Console runs JSON command mode.
- Explorer shows MongoDB databases and collections.
- Double-click collection opens data.
- `Grid`, `Record`, and `Text` display modes render the same result.

