package mysql

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GripLite/internal/driver"
)

// PreviewPartitionAlter implements [driver.PartitionAlterDriver] for simple
// ADD PARTITION / DROP PARTITION operations.
func (d *mysqlDriver) PreviewPartitionAlter(req driver.PartitionChangeRequest) (*driver.SchemaChangePreview, error) {
	if strings.TrimSpace(req.Schema) == "" || strings.TrimSpace(req.Table) == "" {
		return nil, fmt.Errorf("mysql: PreviewPartitionAlter: empty schema / table")
	}
	if err := validatePartitionDrafts(req.NewPartitions); err != nil {
		return nil, err
	}

	qualified := fmt.Sprintf("%s.%s", quoteIdent(req.Schema), quoteIdent(req.Table))
	out := &driver.SchemaChangePreview{
		Statements: []driver.SchemaChangeStatement{},
		Warnings:   []string{},
	}

	newByOrig := map[string]driver.PartitionDraft{}
	for _, p := range req.NewPartitions {
		if strings.TrimSpace(p.OriginalName) != "" {
			newByOrig[p.OriginalName] = normalizePartitionDraft(p)
		}
	}

	for _, oldP := range req.OldPartitions {
		orig := partitionOriginalName(oldP)
		if _, kept := newByOrig[orig]; !kept {
			out.Statements = append(out.Statements, dropPartitionStatement(qualified, orig))
			out.Warnings = append(out.Warnings, fmt.Sprintf("Dropping partition `%s` deletes the data stored in that partition.", orig))
		}
	}

	for _, newP := range req.NewPartitions {
		norm := normalizePartitionDraft(newP)
		if norm.OriginalName == "" {
			out.Statements = append(out.Statements, addPartitionStatement(qualified, norm))
		}
	}

	return out, nil
}

func (d *mysqlDriver) ExecutePartitionAlter(ctx context.Context, req driver.PartitionChangeRequest) (*driver.SchemaChangeResult, error) {
	if d.db == nil {
		return nil, driver.ErrNotConnected
	}
	preview, err := d.PreviewPartitionAlter(req)
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

func validatePartitionDrafts(parts []driver.PartitionDraft) error {
	seen := map[string]struct{}{}
	for i, p := range parts {
		norm := normalizePartitionDraft(p)
		if norm.Name == "" {
			return fmt.Errorf("mysql: partition at row %d is missing a name", i+1)
		}
		key := strings.ToLower(norm.Name)
		if _, ok := seen[key]; ok {
			return fmt.Errorf("mysql: duplicate partition name `%s`", norm.Name)
		}
		seen[key] = struct{}{}
		if norm.OriginalName == "" && norm.Definition == "" {
			return fmt.Errorf("mysql: new partition `%s` must include a definition", norm.Name)
		}
		if norm.OriginalName != "" && norm.Name != norm.OriginalName {
			return fmt.Errorf("mysql: renaming partition `%s` is not supported", norm.OriginalName)
		}
	}
	return nil
}

func normalizePartitionDraft(p driver.PartitionDraft) driver.PartitionDraft {
	p.OriginalName = strings.TrimSpace(p.OriginalName)
	p.Name = strings.TrimSpace(p.Name)
	p.Definition = strings.TrimSpace(p.Definition)
	return p
}

func partitionOriginalName(p driver.PartitionDraft) string {
	if strings.TrimSpace(p.OriginalName) != "" {
		return strings.TrimSpace(p.OriginalName)
	}
	return strings.TrimSpace(p.Name)
}

func dropPartitionStatement(qualified, name string) driver.SchemaChangeStatement {
	return driver.SchemaChangeStatement{
		Kind:    "drop",
		Summary: fmt.Sprintf("Drop partition `%s`", name),
		SQL:     fmt.Sprintf("ALTER TABLE %s DROP PARTITION %s;", qualified, quoteIdent(name)),
	}
}

func addPartitionStatement(qualified string, p driver.PartitionDraft) driver.SchemaChangeStatement {
	def := p.Definition
	if !strings.HasPrefix(strings.ToUpper(def), "PARTITION ") {
		def = fmt.Sprintf("PARTITION %s %s", quoteIdent(p.Name), def)
	}
	return driver.SchemaChangeStatement{
		Kind:    "add",
		Summary: fmt.Sprintf("Add partition `%s`", p.Name),
		SQL:     fmt.Sprintf("ALTER TABLE %s ADD PARTITION (%s);", qualified, def),
	}
}
