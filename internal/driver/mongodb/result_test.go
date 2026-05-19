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
