package mysql

import (
	"strings"
	"testing"

	"GripLite/internal/driver"
)

func TestPreviewConstraintAlterAddDropAndModify(t *testing.T) {
	d := &mysqlDriver{}
	preview, err := d.PreviewConstraintAlter(driver.ConstraintChangeRequest{
		Schema: "app",
		Table:  "users",
		OldConstraints: []driver.ConstraintDraft{
			{OriginalName: "uq_email", Name: "uq_email", Type: "UNIQUE", Columns: []string{"email"}},
			{OriginalName: "chk_age", Name: "chk_age", Type: "CHECK", Expression: "age >= 0"},
		},
		NewConstraints: []driver.ConstraintDraft{
			{OriginalName: "chk_age", Name: "chk_age_adult", Type: "CHECK", Expression: "age >= 18"},
			{Name: "uq_tenant_email", Type: "UNIQUE", Columns: []string{"tenant_id", "email"}},
		},
	})
	if err != nil {
		t.Fatalf("PreviewConstraintAlter returned error: %v", err)
	}
	assertSQL(t, preview, []string{
		"ALTER TABLE `app`.`users` DROP INDEX `uq_email`;",
		"ALTER TABLE `app`.`users` DROP CHECK `chk_age`;",
		"ALTER TABLE `app`.`users` ADD CONSTRAINT `chk_age_adult` CHECK (age >= 18);",
		"ALTER TABLE `app`.`users` ADD CONSTRAINT `uq_tenant_email` UNIQUE (`tenant_id`, `email`);",
	})
	if len(preview.Warnings) != 2 {
		t.Fatalf("expected 2 warnings, got %d", len(preview.Warnings))
	}
}

func TestPreviewConstraintAlterIgnoresPrimaryKey(t *testing.T) {
	d := &mysqlDriver{}
	preview, err := d.PreviewConstraintAlter(driver.ConstraintChangeRequest{
		Schema: "app",
		Table:  "users",
		OldConstraints: []driver.ConstraintDraft{
			{OriginalName: "PRIMARY", Name: "PRIMARY", Type: "PRIMARY KEY", Columns: []string{"id"}},
		},
		NewConstraints: []driver.ConstraintDraft{},
	})
	if err != nil {
		t.Fatalf("PreviewConstraintAlter returned error: %v", err)
	}
	if len(preview.Statements) != 0 {
		t.Fatalf("expected no SQL for primary key, got %#v", preview.Statements)
	}
}

func TestPreviewConstraintAlterRejectsInvalidDrafts(t *testing.T) {
	d := &mysqlDriver{}
	_, err := d.PreviewConstraintAlter(driver.ConstraintChangeRequest{
		Schema: "app",
		Table:  "users",
		NewConstraints: []driver.ConstraintDraft{
			{Name: "uq_email", Type: "UNIQUE"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "must include at least one column") {
		t.Fatalf("expected unique column validation error, got %v", err)
	}
}

func TestPreviewPartitionAlterAddAndDrop(t *testing.T) {
	d := &mysqlDriver{}
	preview, err := d.PreviewPartitionAlter(driver.PartitionChangeRequest{
		Schema: "app",
		Table:  "events",
		OldPartitions: []driver.PartitionDraft{
			{OriginalName: "p_old", Name: "p_old"},
			{OriginalName: "p_keep", Name: "p_keep"},
		},
		NewPartitions: []driver.PartitionDraft{
			{OriginalName: "p_keep", Name: "p_keep"},
			{Name: "p_2026", Definition: "VALUES LESS THAN (TO_DAYS('2026-01-01'))"},
		},
	})
	if err != nil {
		t.Fatalf("PreviewPartitionAlter returned error: %v", err)
	}
	assertSQL(t, preview, []string{
		"ALTER TABLE `app`.`events` DROP PARTITION `p_old`;",
		"ALTER TABLE `app`.`events` ADD PARTITION (PARTITION `p_2026` VALUES LESS THAN (TO_DAYS('2026-01-01')));",
	})
	if len(preview.Warnings) != 1 {
		t.Fatalf("expected 1 warning, got %d", len(preview.Warnings))
	}
}

func TestPreviewPartitionAlterAcceptsFullDefinition(t *testing.T) {
	d := &mysqlDriver{}
	preview, err := d.PreviewPartitionAlter(driver.PartitionChangeRequest{
		Schema: "app",
		Table:  "events",
		NewPartitions: []driver.PartitionDraft{
			{Name: "p_max", Definition: "PARTITION p_max VALUES LESS THAN MAXVALUE"},
		},
	})
	if err != nil {
		t.Fatalf("PreviewPartitionAlter returned error: %v", err)
	}
	assertSQL(t, preview, []string{
		"ALTER TABLE `app`.`events` ADD PARTITION (PARTITION p_max VALUES LESS THAN MAXVALUE);",
	})
}
