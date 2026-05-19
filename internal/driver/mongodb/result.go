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
