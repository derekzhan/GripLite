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
		Columns:       columns,
		Rows:          &sliceIterator{rows: rows},
		ExecutionTime: time.Duration(execMs) * time.Millisecond,
	}
}

func inferColumns(docs []bson.M) []driver.ColumnInfo {
	seen := map[string]bool{"_id": true}
	keys := make([]string, 0)
	for _, doc := range docs {
		for k := range doc {
			if k != "_id" && !seen[k] {
				seen[k] = true
				keys = append(keys, k)
			}
		}
	}
	sort.Strings(keys)
	names := append([]string{"_id"}, keys...)
	cols := make([]driver.ColumnInfo, len(names))
	for i, name := range names {
		cols[i] = driver.ColumnInfo{
			Name:         name,
			DatabaseType: "BSON",
			Nullable:     true,
			PrimaryKey:   name == "_id",
			Ordinal:      i,
		}
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
	rs := documentsToResultSet([]bson.M{bson.M(summary)}, execMs)
	rs.RowsAffected = rowsAffected
	return rs
}

// commandResultSet renders a command's response document, honouring any trailing
// field access captured in the shell (e.g. db.coll.stats().sharded). With no
// path the full document is returned; with a path only the nested value is
// surfaced — as a one-row document grid for sub-documents, or a single labelled
// cell for scalars/arrays/missing fields.
func commandResultSet(doc bson.M, path []string, execMs int64) *driver.ResultSet {
	if len(path) == 0 {
		return documentsToResultSet([]bson.M{doc}, execMs)
	}
	value, ok := extractResultPath(doc, path)
	label := path[len(path)-1]
	if !ok {
		return scalarResultSet(label, nil, execMs)
	}
	if m, isMap := asStringMap(value); isMap {
		return singleDocumentResultSet(m, execMs)
	}
	return scalarResultSet(label, value, execMs)
}

// extractResultPath walks a nested document along path, returning the leaf value
// and whether every segment resolved.
func extractResultPath(doc bson.M, path []string) (any, bool) {
	var cur any = bson.M(doc)
	for _, key := range path {
		m, ok := asStringMap(cur)
		if !ok {
			return nil, false
		}
		v, ok := m[key]
		if !ok {
			return nil, false
		}
		cur = v
	}
	return cur, true
}

func asStringMap(v any) (map[string]any, bool) {
	switch m := v.(type) {
	case bson.M:
		return map[string]any(m), true
	case map[string]any:
		return m, true
	case bson.D:
		out := make(map[string]any, len(m))
		for _, e := range m {
			out[e.Key] = e.Value
		}
		return out, true
	default:
		return nil, false
	}
}

// scalarResultSet renders a single value as a one-column, one-row grid. Unlike
// documentsToResultSet it does not force an _id column, so a projected scalar
// such as stats().sharded shows up as just `sharded: true`.
func scalarResultSet(name string, value any, execMs int64) *driver.ResultSet {
	return &driver.ResultSet{
		Columns: []driver.ColumnInfo{{
			Name:         name,
			DatabaseType: "BSON",
			Nullable:     true,
			Ordinal:      0,
		}},
		Rows:          &sliceIterator{rows: []driver.Row{{mongoCellValue(value)}}},
		ExecutionTime: time.Duration(execMs) * time.Millisecond,
	}
}

// singleDocumentResultSet renders a sub-document as a one-row grid using its own
// keys as columns (no forced _id), so projecting a nested object shows its
// fields directly.
func singleDocumentResultSet(m map[string]any, execMs int64) *driver.ResultSet {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	cols := make([]driver.ColumnInfo, len(keys))
	row := make(driver.Row, len(keys))
	for i, k := range keys {
		cols[i] = driver.ColumnInfo{
			Name:         k,
			DatabaseType: "BSON",
			Nullable:     true,
			PrimaryKey:   k == "_id",
			Ordinal:      i,
		}
		row[i] = mongoCellValue(m[k])
	}
	return &driver.ResultSet{
		Columns:       cols,
		Rows:          &sliceIterator{rows: []driver.Row{row}},
		ExecutionTime: time.Duration(execMs) * time.Millisecond,
	}
}
