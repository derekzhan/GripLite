package mysql

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GripLite/internal/driver"
)

// PreviewIndexAlter implements [driver.IndexAlterDriver] for MySQL.
// MySQL cannot alter an index definition in-place, so any edit to columns,
// uniqueness, algorithm, or comment is emitted as DROP INDEX + CREATE INDEX.
func (d *mysqlDriver) PreviewIndexAlter(req driver.IndexChangeRequest) (*driver.SchemaChangePreview, error) {
	if strings.TrimSpace(req.Schema) == "" || strings.TrimSpace(req.Table) == "" {
		return nil, fmt.Errorf("mysql: PreviewIndexAlter: empty schema / table")
	}
	if err := validateIndexDrafts(req.NewIndexes); err != nil {
		return nil, err
	}

	qualified := fmt.Sprintf("%s.%s", quoteIdent(req.Schema), quoteIdent(req.Table))
	out := &driver.SchemaChangePreview{
		Statements: []driver.SchemaChangeStatement{},
		Warnings:   []string{},
	}

	oldByOrig := map[string]driver.IndexDraft{}
	for _, idx := range req.OldIndexes {
		orig := indexOriginalName(idx)
		if strings.EqualFold(orig, "PRIMARY") {
			continue
		}
		oldByOrig[orig] = normalizeIndexDraft(idx)
	}

	newByOrig := map[string]driver.IndexDraft{}
	for _, idx := range req.NewIndexes {
		if strings.EqualFold(idx.OriginalName, "PRIMARY") || strings.EqualFold(idx.Name, "PRIMARY") {
			continue
		}
		if strings.TrimSpace(idx.OriginalName) != "" {
			newByOrig[idx.OriginalName] = normalizeIndexDraft(idx)
		}
	}

	// Drop removed indexes and indexes whose definition changed.
	for _, oldIdx := range req.OldIndexes {
		orig := indexOriginalName(oldIdx)
		if strings.EqualFold(orig, "PRIMARY") {
			continue
		}
		newIdx, kept := newByOrig[orig]
		if !kept {
			out.Statements = append(out.Statements, dropIndexStatement(qualified, orig))
			out.Warnings = append(out.Warnings, fmt.Sprintf("Dropping index `%s` can affect query performance.", orig))
			continue
		}
		if !indexDraftEqual(normalizeIndexDraft(oldIdx), newIdx) {
			out.Statements = append(out.Statements, dropIndexStatement(qualified, orig))
			out.Warnings = append(out.Warnings, fmt.Sprintf("Modifying index `%s` requires dropping and recreating it.", orig))
		}
	}

	// Create added indexes and recreate modified indexes.
	for _, newIdx := range req.NewIndexes {
		if strings.EqualFold(newIdx.OriginalName, "PRIMARY") || strings.EqualFold(newIdx.Name, "PRIMARY") {
			continue
		}
		norm := normalizeIndexDraft(newIdx)
		if norm.OriginalName == "" {
			out.Statements = append(out.Statements, createIndexStatement(qualified, norm))
			continue
		}
		oldIdx, ok := oldByOrig[norm.OriginalName]
		if ok && !indexDraftEqual(oldIdx, norm) {
			out.Statements = append(out.Statements, createIndexStatement(qualified, norm))
		}
	}

	return out, nil
}

// ExecuteIndexAlter re-runs PreviewIndexAlter server-side and applies each
// generated statement in order.  MySQL DDL auto-commits, so partial failures
// are reported via SchemaChangeResult.
func (d *mysqlDriver) ExecuteIndexAlter(ctx context.Context, req driver.IndexChangeRequest) (*driver.SchemaChangeResult, error) {
	if d.db == nil {
		return nil, driver.ErrNotConnected
	}
	preview, err := d.PreviewIndexAlter(req)
	if err != nil {
		return nil, err
	}
	if len(preview.Statements) == 0 {
		return &driver.SchemaChangeResult{
			Success:     true,
			Statements:  preview.Statements,
			FailedIndex: -1,
		}, nil
	}

	res := &driver.SchemaChangeResult{Statements: preview.Statements, FailedIndex: -1}
	for i, st := range preview.Statements {
		stmtCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		_, execErr := d.db.ExecContext(stmtCtx, st.SQL)
		cancel()
		if execErr != nil {
			res.FailedIndex = i
			res.FailedStatement = st.SQL
			res.Error = execErr.Error()
			res.ExecutedCount = i
			return res, nil
		}
	}
	res.Success = true
	res.ExecutedCount = len(preview.Statements)
	return res, nil
}

func validateIndexDrafts(indexes []driver.IndexDraft) error {
	seen := map[string]struct{}{}
	for i, idx := range indexes {
		if strings.EqualFold(idx.OriginalName, "PRIMARY") || strings.EqualFold(idx.Name, "PRIMARY") {
			continue
		}
		name := strings.TrimSpace(idx.Name)
		if name == "" {
			return fmt.Errorf("mysql: index at row %d is missing a name", i+1)
		}
		if len(idx.Columns) == 0 {
			return fmt.Errorf("mysql: index `%s` must include at least one column", name)
		}
		lower := strings.ToLower(name)
		if _, ok := seen[lower]; ok {
			return fmt.Errorf("mysql: duplicate index name `%s`", name)
		}
		seen[lower] = struct{}{}
	}
	return nil
}

func normalizeIndexDraft(idx driver.IndexDraft) driver.IndexDraft {
	idx.OriginalName = strings.TrimSpace(idx.OriginalName)
	idx.Name = strings.TrimSpace(idx.Name)
	idx.Type = normalizeIndexType(idx.Type)
	idx.Comment = strings.TrimSpace(idx.Comment)
	cols := make([]string, 0, len(idx.Columns))
	for _, col := range idx.Columns {
		if c := strings.TrimSpace(col); c != "" {
			cols = append(cols, c)
		}
	}
	idx.Columns = cols
	return idx
}

func normalizeIndexType(t string) string {
	switch strings.ToUpper(strings.TrimSpace(t)) {
	case "HASH":
		return "HASH"
	case "FULLTEXT":
		return "FULLTEXT"
	case "SPATIAL":
		return "SPATIAL"
	default:
		return "BTREE"
	}
}

func indexOriginalName(idx driver.IndexDraft) string {
	if strings.TrimSpace(idx.OriginalName) != "" {
		return strings.TrimSpace(idx.OriginalName)
	}
	return strings.TrimSpace(idx.Name)
}

func indexDraftEqual(a, b driver.IndexDraft) bool {
	a = normalizeIndexDraft(a)
	b = normalizeIndexDraft(b)
	if a.Name != b.Name || a.Type != b.Type || a.Unique != b.Unique || a.Comment != b.Comment {
		return false
	}
	if len(a.Columns) != len(b.Columns) {
		return false
	}
	for i := range a.Columns {
		if a.Columns[i] != b.Columns[i] {
			return false
		}
	}
	return true
}

func dropIndexStatement(qualified, name string) driver.SchemaChangeStatement {
	return driver.SchemaChangeStatement{
		Kind:    "drop",
		Summary: fmt.Sprintf("Drop index `%s`", name),
		SQL:     fmt.Sprintf("DROP INDEX %s ON %s;", quoteIdent(name), qualified),
	}
}

func createIndexStatement(qualified string, idx driver.IndexDraft) driver.SchemaChangeStatement {
	prefix := "INDEX"
	switch idx.Type {
	case "FULLTEXT":
		prefix = "FULLTEXT INDEX"
	case "SPATIAL":
		prefix = "SPATIAL INDEX"
	case "BTREE", "HASH":
		if idx.Unique {
			prefix = "UNIQUE INDEX"
		}
	}

	cols := make([]string, len(idx.Columns))
	for i, col := range idx.Columns {
		cols[i] = quoteIdent(col)
	}

	using := ""
	if idx.Type == "BTREE" || idx.Type == "HASH" {
		using = " USING " + idx.Type
	}
	comment := ""
	if idx.Comment != "" {
		comment = " COMMENT " + quoteStringLiteral(idx.Comment)
	}

	return driver.SchemaChangeStatement{
		Kind:    "add",
		Summary: fmt.Sprintf("Create index `%s` on %s", idx.Name, strings.Join(idx.Columns, ", ")),
		SQL: fmt.Sprintf("CREATE %s %s ON %s (%s)%s%s;",
			prefix, quoteIdent(idx.Name), qualified, strings.Join(cols, ", "), using, comment),
	}
}
