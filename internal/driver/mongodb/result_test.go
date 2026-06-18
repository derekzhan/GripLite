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
	if row := rs.Rows.Row(); len(row) != 0 {
		t.Fatalf("Row before Next = %#v, want empty zero row", row)
	}
	if !rs.Rows.Next() {
		t.Fatalf("expected first row")
	}
	first := rs.Rows.Row()
	if first[0] != id.Hex() {
		t.Fatalf("_id = %#v, want %q", first[0], id.Hex())
	}
	if first[3] != `{"tier":"gold"}` {
		t.Fatalf("meta = %#v", first[3])
	}
	if rs.ExecutionTime.Milliseconds() != 15 {
		t.Fatalf("ExecutionTime = %v", rs.ExecutionTime)
	}
}

func TestCommandResultSetProjectsScalarField(t *testing.T) {
	doc := bson.M{"ns": "prm.prm_order", "sharded": false, "count": int64(42)}

	rs := commandResultSet(doc, []string{"sharded"}, 0)
	if len(rs.Columns) != 1 || rs.Columns[0].Name != "sharded" {
		t.Fatalf("columns = %#v, want single 'sharded' column", rs.Columns)
	}
	if !rs.Rows.Next() {
		t.Fatalf("expected a row")
	}
	if got := rs.Rows.Row()[0]; got != false {
		t.Fatalf("sharded value = %#v, want false", got)
	}
}

func TestCommandResultSetProjectsNestedDocument(t *testing.T) {
	doc := bson.M{"sharded": true, "shards": bson.M{"shard0001": bson.M{"count": int64(7)}}}

	rs := commandResultSet(doc, []string{"shards", "shard0001"}, 0)
	if len(rs.Columns) != 1 || rs.Columns[0].Name != "count" {
		t.Fatalf("columns = %#v, want single 'count' column", rs.Columns)
	}
	if !rs.Rows.Next() {
		t.Fatalf("expected a row")
	}
	if got := rs.Rows.Row()[0]; got != int64(7) {
		t.Fatalf("count value = %#v, want 7", got)
	}
}

func TestCommandResultSetMissingFieldYieldsNullCell(t *testing.T) {
	rs := commandResultSet(bson.M{"sharded": true}, []string{"nope"}, 0)
	if len(rs.Columns) != 1 || rs.Columns[0].Name != "nope" {
		t.Fatalf("columns = %#v, want single 'nope' column", rs.Columns)
	}
	if !rs.Rows.Next() {
		t.Fatalf("expected a row")
	}
	if got := rs.Rows.Row()[0]; got != nil {
		t.Fatalf("missing field cell = %#v, want nil", got)
	}
}

func TestCommandResultSetWithoutPathReturnsFullDocument(t *testing.T) {
	doc := bson.M{"_id": "x", "sharded": true, "ns": "prm.prm_order"}
	rs := commandResultSet(doc, nil, 0)
	if len(rs.Columns) != 3 {
		t.Fatalf("columns = %#v, want full document (3 columns)", rs.Columns)
	}
}
