// Advanced schema introspection for the MySQL driver — Phase 19.
//
// This file adds a single method to *mysqlDriver:
//
//	FetchAdvancedTableProperties(ctx, dbName, tableName) (*AdvancedTableProperties, error)
//
// which batches the five metadata queries the TableViewer Properties tab
// needs into one round-trip-per-query pass.  It deliberately issues one
// QueryContext per logical section rather than one monster UNION so that a
// failure on (say) TRIGGERS doesn't take down the whole payload — each
// section is wrapped individually and populated with an empty slice on
// error instead of bubbling up, mirroring DBeaver/DataGrip behaviour.
//
// Queries
// ───────
//   1. SHOW CREATE TABLE       → DDL
//   2. SHOW INDEX FROM         → Indexes (multi-col indexes collapsed)
//   3. KEY_COLUMN_USAGE + REFERENTIAL_CONSTRAINTS → ForeignKeys / References
//   4. TABLE_CONSTRAINTS + KEY_COLUMN_USAGE       → Constraints (PK / UQ / CHK)
//   5. information_schema.TRIGGERS               → Triggers

package mysql

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"GripLite/internal/driver"
)

// FetchAdvancedTableProperties implements [driver.AdvancedSchemaDriver] for
// MySQL.  Best-effort: every section runs in its own query and errors are
// absorbed into an empty slice so partial failures don't mask the rest of
// the data.  The returned pointer is never nil on success.
func (d *mysqlDriver) FetchAdvancedTableProperties(ctx context.Context, dbName, tableName string) (*driver.AdvancedTableProperties, error) {
	if d.db == nil {
		return nil, driver.ErrNotConnected
	}
	if dbName == "" || tableName == "" {
		return nil, fmt.Errorf("mysql: FetchAdvancedTableProperties: empty dbName / tableName")
	}

	out := &driver.AdvancedTableProperties{
		Schema:      dbName,
		Table:       tableName,
		Indexes:     []driver.IndexDetail{},
		Constraints: []driver.ConstraintDetail{},
		ForeignKeys: []driver.ForeignKeyDetail{},
		References:  []driver.ReferenceDetail{},
		Triggers:    []driver.TriggerDetail{},
	}

	// Section 1 — DDL.  If the underlying SHOW CREATE TABLE errors (missing
	// table, insufficient privileges) we propagate immediately because
	// every other section will likely fail the same way.
	ddl, err := fetchCreateTable(ctx, d.db, dbName, tableName)
	if err != nil {
		return nil, err
	}
	out.DDL = ddl

	// Remaining sections are best-effort.  Errors are logged but do not
	// abort the whole RPC — this keeps the Properties tab useful even when
	// the user lacks SELECT on information_schema (rare but possible on
	// hardened managed instances).
	if idx, e := fetchIndexes(ctx, d.db, dbName, tableName); e == nil {
		out.Indexes = idx
	}
	if cons, e := fetchConstraints(ctx, d.db, dbName, tableName); e == nil {
		out.Constraints = cons
	}
	if fks, e := fetchForeignKeys(ctx, d.db, dbName, tableName); e == nil {
		out.ForeignKeys = fks
	}
	if refs, e := fetchReferences(ctx, d.db, dbName, tableName); e == nil {
		out.References = refs
	}
	if trs, e := fetchTriggers(ctx, d.db, dbName, tableName); e == nil {
		out.Triggers = trs
	}

	return out, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — SHOW CREATE TABLE
// ─────────────────────────────────────────────────────────────────────────────
//
// MySQL returns two columns: (Table, Create Table).  Views return
// (View, Create View, character_set_client, collation_connection) — four
// columns.  We use sql.RawBytes so the scanner accepts either shape.

func fetchCreateTable(ctx context.Context, db *sql.DB, dbName, tableName string) (string, error) {
	q := fmt.Sprintf("SHOW CREATE TABLE %s.%s", quoteIdent(dbName), quoteIdent(tableName))

	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return "", fmt.Errorf("mysql: SHOW CREATE TABLE %q.%q: %w", dbName, tableName, err)
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return "", fmt.Errorf("mysql: SHOW CREATE TABLE columns: %w", err)
	}

	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return "", err
		}
		return "", fmt.Errorf("%w: %s.%s", driver.ErrTableNotFound, dbName, tableName)
	}

	// Scan into []sql.RawBytes then pluck the "Create Table" or "Create View"
	// column — its position is always 1 regardless of the column count.
	vals := make([]sql.RawBytes, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return "", fmt.Errorf("mysql: SHOW CREATE TABLE scan: %w", err)
	}
	if len(vals) < 2 {
		return "", fmt.Errorf("mysql: SHOW CREATE TABLE returned unexpected shape (cols=%d)", len(cols))
	}
	return string(vals[1]), nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — SHOW INDEX FROM
// ─────────────────────────────────────────────────────────────────────────────
//
// Each row describes one (index, column) pair.  Multi-column indexes show up
// as N consecutive rows with the same Key_name but different Seq_in_index.
// We group them into a single [driver.IndexDetail] using the SHOW INDEX
// natural order.

func fetchIndexes(ctx context.Context, db *sql.DB, dbName, tableName string) ([]driver.IndexDetail, error) {
	q := fmt.Sprintf("SHOW INDEX FROM %s.%s", quoteIdent(dbName), quoteIdent(tableName))

	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	// Resolve column positions by name — SHOW INDEX output has varied
	// slightly across MySQL/MariaDB versions (e.g. extra "Expression" or
	// "Visible" columns in 8.x) so we can't rely on fixed offsets.
	colIdx := indexByName(cols)

	type key struct{ name string }
	ordered := []key{}
	byKey := map[key]*driver.IndexDetail{}

	for rows.Next() {
		vals := make([]sql.RawBytes, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		get := func(name string) string {
			if i, ok := colIdx[strings.ToLower(name)]; ok && i < len(vals) {
				return string(vals[i])
			}
			return ""
		}
		k := key{name: get("key_name")}
		colName := get("column_name")
		idxType := get("index_type")
		comment := strings.TrimSpace(get("index_comment"))
		if comment == "" {
			comment = strings.TrimSpace(get("comment"))
		}
		// Non_unique==0 ⇒ unique
		unique := get("non_unique") == "0"

		entry, ok := byKey[k]
		if !ok {
			entry = &driver.IndexDetail{
				Name:    k.name,
				Type:    idxType,
				Unique:  unique,
				Columns: []string{},
				Comment: comment,
			}
			byKey[k] = entry
			ordered = append(ordered, k)
		}
		entry.Columns = append(entry.Columns, colName)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]driver.IndexDetail, 0, len(ordered))
	for _, k := range ordered {
		out = append(out, *byKey[k])
	}
	return out, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Constraints (PK / UQ / CHECK)
// ─────────────────────────────────────────────────────────────────────────────
//
// TABLE_CONSTRAINTS lists every named constraint; KEY_COLUMN_USAGE provides
// the columns bound to each one.  We LEFT JOIN so CHECK constraints (no
// columns) still appear.

func fetchConstraints(ctx context.Context, db *sql.DB, dbName, tableName string) ([]driver.ConstraintDetail, error) {
	const q = `
		SELECT tc.CONSTRAINT_NAME,
		       tc.CONSTRAINT_TYPE,
		       COALESCE(GROUP_CONCAT(kcu.COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION SEPARATOR ','), '') AS cols
		FROM   information_schema.TABLE_CONSTRAINTS tc
		LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu
		       ON  kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
		       AND kcu.CONSTRAINT_NAME   = tc.CONSTRAINT_NAME
		       AND kcu.TABLE_NAME        = tc.TABLE_NAME
		WHERE tc.TABLE_SCHEMA = ?
		  AND tc.TABLE_NAME   = ?
		  AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'CHECK')
		GROUP BY tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE
		ORDER BY FIELD(tc.CONSTRAINT_TYPE, 'PRIMARY KEY', 'UNIQUE', 'CHECK'),
		         tc.CONSTRAINT_NAME`

	rows, err := db.QueryContext(ctx, q, dbName, tableName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []driver.ConstraintDetail{}
	for rows.Next() {
		var name, typ, cols string
		if err := rows.Scan(&name, &typ, &cols); err != nil {
			return nil, err
		}
		detail := driver.ConstraintDetail{Name: name, Type: typ}
		if cols != "" {
			detail.Columns = strings.Split(cols, ",")
		} else {
			detail.Columns = []string{}
		}
		out = append(out, detail)
	}
	return out, rows.Err()
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Foreign keys (outgoing)
// ─────────────────────────────────────────────────────────────────────────────

func fetchForeignKeys(ctx context.Context, db *sql.DB, dbName, tableName string) ([]driver.ForeignKeyDetail, error) {
	const q = `
		SELECT rc.CONSTRAINT_NAME,
		       rc.REFERENCED_TABLE_NAME,
		       rc.UNIQUE_CONSTRAINT_SCHEMA,
		       GROUP_CONCAT(kcu.COLUMN_NAME            ORDER BY kcu.ORDINAL_POSITION SEPARATOR ',') AS cols,
		       GROUP_CONCAT(kcu.REFERENCED_COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION SEPARATOR ',') AS refcols,
		       rc.DELETE_RULE,
		       rc.UPDATE_RULE
		FROM   information_schema.REFERENTIAL_CONSTRAINTS rc
		JOIN   information_schema.KEY_COLUMN_USAGE       kcu
		       ON  kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
		       AND kcu.CONSTRAINT_NAME   = rc.CONSTRAINT_NAME
		       AND kcu.TABLE_NAME        = rc.TABLE_NAME
		WHERE rc.CONSTRAINT_SCHEMA = ?
		  AND rc.TABLE_NAME        = ?
		GROUP BY rc.CONSTRAINT_NAME, rc.REFERENCED_TABLE_NAME,
		         rc.UNIQUE_CONSTRAINT_SCHEMA, rc.DELETE_RULE, rc.UPDATE_RULE
		ORDER BY rc.CONSTRAINT_NAME`

	rows, err := db.QueryContext(ctx, q, dbName, tableName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []driver.ForeignKeyDetail{}
	for rows.Next() {
		var name, refTable, refSchema, cols, refCols, onDel, onUpd string
		if err := rows.Scan(&name, &refTable, &refSchema, &cols, &refCols, &onDel, &onUpd); err != nil {
			return nil, err
		}
		out = append(out, driver.ForeignKeyDetail{
			Name:       name,
			Columns:    splitCSV(cols),
			RefSchema:  refSchema,
			RefTable:   refTable,
			RefColumns: splitCSV(refCols),
			OnDelete:   onDel,
			OnUpdate:   onUpd,
		})
	}
	return out, rows.Err()
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — References (incoming foreign keys)
// ─────────────────────────────────────────────────────────────────────────────

func fetchReferences(ctx context.Context, db *sql.DB, dbName, tableName string) ([]driver.ReferenceDetail, error) {
	const q = `
		SELECT rc.CONSTRAINT_NAME,
		       kcu.TABLE_SCHEMA,
		       kcu.TABLE_NAME,
		       GROUP_CONCAT(kcu.COLUMN_NAME            ORDER BY kcu.ORDINAL_POSITION SEPARATOR ',') AS cols,
		       GROUP_CONCAT(kcu.REFERENCED_COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION SEPARATOR ',') AS refcols,
		       rc.DELETE_RULE,
		       rc.UPDATE_RULE
		FROM   information_schema.REFERENTIAL_CONSTRAINTS rc
		JOIN   information_schema.KEY_COLUMN_USAGE       kcu
		       ON  kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
		       AND kcu.CONSTRAINT_NAME   = rc.CONSTRAINT_NAME
		       AND kcu.TABLE_NAME        = rc.TABLE_NAME
		WHERE rc.UNIQUE_CONSTRAINT_SCHEMA = ?
		  AND rc.REFERENCED_TABLE_NAME    = ?
		GROUP BY rc.CONSTRAINT_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME,
		         rc.DELETE_RULE, rc.UPDATE_RULE
		ORDER BY kcu.TABLE_SCHEMA, kcu.TABLE_NAME, rc.CONSTRAINT_NAME`

	rows, err := db.QueryContext(ctx, q, dbName, tableName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []driver.ReferenceDetail{}
	for rows.Next() {
		var name, fromSchema, fromTable, cols, refCols, onDel, onUpd string
		if err := rows.Scan(&name, &fromSchema, &fromTable, &cols, &refCols, &onDel, &onUpd); err != nil {
			return nil, err
		}
		out = append(out, driver.ReferenceDetail{
			Name:       name,
			FromSchema: fromSchema,
			FromTable:  fromTable,
			FromCols:   splitCSV(cols),
			ToCols:     splitCSV(refCols),
			OnDelete:   onDel,
			OnUpdate:   onUpd,
		})
	}
	return out, rows.Err()
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — Triggers
// ─────────────────────────────────────────────────────────────────────────────

func fetchTriggers(ctx context.Context, db *sql.DB, dbName, tableName string) ([]driver.TriggerDetail, error) {
	const q = `
		SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING,
		       COALESCE(ACTION_STATEMENT, '') AS stmt
		FROM   information_schema.TRIGGERS
		WHERE  EVENT_OBJECT_SCHEMA = ?
		  AND  EVENT_OBJECT_TABLE  = ?
		ORDER BY TRIGGER_NAME`

	rows, err := db.QueryContext(ctx, q, dbName, tableName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []driver.TriggerDetail{}
	for rows.Next() {
		var name, event, timing, stmt string
		if err := rows.Scan(&name, &event, &timing, &stmt); err != nil {
			return nil, err
		}
		out = append(out, driver.TriggerDetail{
			Name:      name,
			Event:     event,
			Timing:    timing,
			Statement: stmt,
		})
	}
	return out, rows.Err()
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// quoteIdent wraps a MySQL identifier in backticks, doubling any embedded
// backticks so exotic table names (`my``table`) survive unharmed.  The
// helper is duplicated here to avoid coupling advanced.go to the driver
// file's unexported state.
func quoteIdent(s string) string {
	return "`" + strings.ReplaceAll(s, "`", "``") + "`"
}

// splitCSV is a strict-split tolerant of empty input.  GROUP_CONCAT returns
// an empty string when no rows match the join — Split("", ",") would yield
// [""], which we'd then misrender as a single blank column.
func splitCSV(s string) []string {
	if s == "" {
		return []string{}
	}
	return strings.Split(s, ",")
}

// indexByName maps lower-cased column names to their ordinal position in a
// rows.Columns() slice.  Used by SHOW INDEX parsing to tolerate the varying
// column ordering across MySQL / MariaDB versions.
func indexByName(cols []string) map[string]int {
	m := make(map[string]int, len(cols))
	for i, c := range cols {
		m[strings.ToLower(c)] = i
	}
	return m
}
