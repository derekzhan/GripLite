package mysql

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GripLite/internal/driver"
)

// PreviewConstraintAlter implements [driver.ConstraintAlterDriver] for MySQL.
// PRIMARY KEY and FOREIGN KEY constraints are intentionally out of scope here;
// the UI treats PRIMARY KEY as read-only and foreign keys have a dedicated tab.
func (d *mysqlDriver) PreviewConstraintAlter(req driver.ConstraintChangeRequest) (*driver.SchemaChangePreview, error) {
	if strings.TrimSpace(req.Schema) == "" || strings.TrimSpace(req.Table) == "" {
		return nil, fmt.Errorf("mysql: PreviewConstraintAlter: empty schema / table")
	}
	if err := validateConstraintDrafts(req.NewConstraints); err != nil {
		return nil, err
	}

	qualified := fmt.Sprintf("%s.%s", quoteIdent(req.Schema), quoteIdent(req.Table))
	out := &driver.SchemaChangePreview{
		Statements: []driver.SchemaChangeStatement{},
		Warnings:   []string{},
	}

	newByOrig := map[string]driver.ConstraintDraft{}
	for _, c := range req.NewConstraints {
		if !isEditableConstraint(c.Type) {
			continue
		}
		if strings.TrimSpace(c.OriginalName) != "" {
			newByOrig[c.OriginalName] = normalizeConstraintDraft(c)
		}
	}

	for _, oldC := range req.OldConstraints {
		if !isEditableConstraint(oldC.Type) {
			continue
		}
		orig := constraintOriginalName(oldC)
		newC, kept := newByOrig[orig]
		if !kept {
			out.Statements = append(out.Statements, dropConstraintStatement(qualified, normalizeConstraintDraft(oldC)))
			out.Warnings = append(out.Warnings, fmt.Sprintf("Dropping constraint `%s` changes data validation rules.", orig))
			continue
		}
		if !constraintDraftEqual(normalizeConstraintDraft(oldC), newC) {
			out.Statements = append(out.Statements, dropConstraintStatement(qualified, normalizeConstraintDraft(oldC)))
			out.Statements = append(out.Statements, addConstraintStatement(qualified, newC))
			out.Warnings = append(out.Warnings, fmt.Sprintf("Modifying constraint `%s` requires dropping and recreating it.", orig))
		}
	}

	for _, newC := range req.NewConstraints {
		if !isEditableConstraint(newC.Type) {
			continue
		}
		norm := normalizeConstraintDraft(newC)
		if norm.OriginalName == "" {
			out.Statements = append(out.Statements, addConstraintStatement(qualified, norm))
		}
	}

	return out, nil
}

func (d *mysqlDriver) ExecuteConstraintAlter(ctx context.Context, req driver.ConstraintChangeRequest) (*driver.SchemaChangeResult, error) {
	if d.db == nil {
		return nil, driver.ErrNotConnected
	}
	preview, err := d.PreviewConstraintAlter(req)
	if err != nil {
		return nil, err
	}
	if len(preview.Statements) == 0 {
		return &driver.SchemaChangeResult{Success: true, Statements: preview.Statements, FailedIndex: -1}, nil
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

func validateConstraintDrafts(constraints []driver.ConstraintDraft) error {
	seen := map[string]struct{}{}
	for i, c := range constraints {
		norm := normalizeConstraintDraft(c)
		if !isEditableConstraint(norm.Type) {
			continue
		}
		if norm.Name == "" {
			return fmt.Errorf("mysql: constraint at row %d is missing a name", i+1)
		}
		key := strings.ToLower(norm.Name)
		if _, ok := seen[key]; ok {
			return fmt.Errorf("mysql: duplicate constraint name `%s`", norm.Name)
		}
		seen[key] = struct{}{}

		switch norm.Type {
		case "UNIQUE":
			if len(norm.Columns) == 0 {
				return fmt.Errorf("mysql: unique constraint `%s` must include at least one column", norm.Name)
			}
		case "CHECK":
			if strings.TrimSpace(norm.Expression) == "" {
				return fmt.Errorf("mysql: check constraint `%s` must include an expression", norm.Name)
			}
		}
	}
	return nil
}

func normalizeConstraintDraft(c driver.ConstraintDraft) driver.ConstraintDraft {
	c.OriginalName = strings.TrimSpace(c.OriginalName)
	c.Name = strings.TrimSpace(c.Name)
	c.Type = strings.ToUpper(strings.TrimSpace(c.Type))
	c.Expression = strings.TrimSpace(c.Expression)
	cols := make([]string, 0, len(c.Columns))
	for _, col := range c.Columns {
		if trimmed := strings.TrimSpace(col); trimmed != "" {
			cols = append(cols, trimmed)
		}
	}
	c.Columns = cols
	return c
}

func isEditableConstraint(t string) bool {
	switch strings.ToUpper(strings.TrimSpace(t)) {
	case "UNIQUE", "CHECK":
		return true
	default:
		return false
	}
}

func constraintOriginalName(c driver.ConstraintDraft) string {
	if strings.TrimSpace(c.OriginalName) != "" {
		return strings.TrimSpace(c.OriginalName)
	}
	return strings.TrimSpace(c.Name)
}

func constraintDraftEqual(a, b driver.ConstraintDraft) bool {
	a = normalizeConstraintDraft(a)
	b = normalizeConstraintDraft(b)
	if a.Name != b.Name || a.Type != b.Type || a.Expression != b.Expression {
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

func dropConstraintStatement(qualified string, c driver.ConstraintDraft) driver.SchemaChangeStatement {
	kind := "DROP CHECK"
	if c.Type == "UNIQUE" {
		kind = "DROP INDEX"
	}
	return driver.SchemaChangeStatement{
		Kind:    "drop",
		Summary: fmt.Sprintf("Drop %s constraint `%s`", strings.ToLower(c.Type), constraintOriginalName(c)),
		SQL:     fmt.Sprintf("ALTER TABLE %s %s %s;", qualified, kind, quoteIdent(constraintOriginalName(c))),
	}
}

func addConstraintStatement(qualified string, c driver.ConstraintDraft) driver.SchemaChangeStatement {
	switch c.Type {
	case "UNIQUE":
		cols := make([]string, len(c.Columns))
		for i, col := range c.Columns {
			cols[i] = quoteIdent(col)
		}
		return driver.SchemaChangeStatement{
			Kind:    "add",
			Summary: fmt.Sprintf("Add unique constraint `%s`", c.Name),
			SQL:     fmt.Sprintf("ALTER TABLE %s ADD CONSTRAINT %s UNIQUE (%s);", qualified, quoteIdent(c.Name), strings.Join(cols, ", ")),
		}
	case "CHECK":
		return driver.SchemaChangeStatement{
			Kind:    "add",
			Summary: fmt.Sprintf("Add check constraint `%s`", c.Name),
			SQL:     fmt.Sprintf("ALTER TABLE %s ADD CONSTRAINT %s CHECK (%s);", qualified, quoteIdent(c.Name), c.Expression),
		}
	default:
		return driver.SchemaChangeStatement{}
	}
}
