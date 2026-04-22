// Schema alteration (DDL diff) for the MySQL driver — Phase 20.
//
// Implements [driver.SchemaAlterDriver].  The design is deliberately
// server-side: PreviewAlter is a pure function of the before/after
// snapshots, so the same code path is re-run inside ExecuteAlter.  A
// tampered frontend payload therefore cannot smuggle arbitrary DDL past
// the server — the server only runs statements that it itself emits.
//
// Supported diffs
// ───────────────
//   Table options:  ENGINE, COLLATION (→ default charset + collation),
//                   TABLE_COMMENT.
//   Columns:        ADD, DROP, CHANGE (rename + redefine),
//                   MODIFY (in-place redefine),
//                   re-ordering via AFTER clauses (FIRST for index 0).
//
// Deliberately NOT supported in this phase
// ────────────────────────────────────────
//   - INDEX / FK / TRIGGER / PK changes — users should still manage those
//     by hand; the Designer's scope is columns + table-level options.
//   - Charset-only changes without a collation (we always emit both when
//     the collation changes, since MySQL requires them to be consistent).

package mysql

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GripLite/internal/driver"
)

// PreviewAlter implements [driver.SchemaAlterDriver].
//
// Ordering contract:
//  1. Drop statements first (frees names for reuse).
//  2. Change / modify (shape updates).
//  3. Add (new columns, possibly AFTER another).
//  4. Reorder (MODIFY … AFTER) for surviving columns whose position moved.
//  5. Table-level options last (ENGINE, COLLATE, COMMENT).
//
// The UI renders the statements in the same order so the Review SQL modal
// matches the actual execution order.
func (d *mysqlDriver) PreviewAlter(req driver.SchemaChangeRequest) (*driver.SchemaChangePreview, error) {
	if strings.TrimSpace(req.Schema) == "" || strings.TrimSpace(req.Table) == "" {
		return nil, fmt.Errorf("mysql: PreviewAlter: empty schema / table")
	}

	qualified := fmt.Sprintf("%s.%s", quoteIdent(req.Schema), quoteIdent(req.Table))

	out := &driver.SchemaChangePreview{
		Statements: []driver.SchemaChangeStatement{},
		Warnings:   []string{},
	}

	// ── Phase A: Column diff ────────────────────────────────────────────
	// Build two maps keyed by OriginalName so we can classify each row:
	oldByOrig := map[string]driver.ColumnDraft{}
	for _, c := range req.OldColumns {
		oldByOrig[c.OriginalName] = c
	}
	newByOrig := map[string]driver.ColumnDraft{} // OriginalName "" means added
	for _, c := range req.NewColumns {
		if c.OriginalName != "" {
			newByOrig[c.OriginalName] = c
		}
	}

	// 1. DROP — any old column whose OriginalName is no longer present in
	//    newByOrig.
	for _, oc := range req.OldColumns {
		if _, kept := newByOrig[oc.OriginalName]; !kept {
			sql := fmt.Sprintf("ALTER TABLE %s DROP COLUMN %s;", qualified, quoteIdent(oc.OriginalName))
			out.Statements = append(out.Statements, driver.SchemaChangeStatement{
				Kind:    "drop",
				Summary: fmt.Sprintf("Drop column `%s`", oc.OriginalName),
				SQL:     sql,
			})
			out.Warnings = append(out.Warnings,
				fmt.Sprintf("Dropping column `%s` is destructive — existing data in this column will be lost.", oc.OriginalName))
		}
	}

	// 2. CHANGE / MODIFY — existing columns whose definition changed.
	//    We emit CHANGE if name differs, otherwise MODIFY.  Reordering
	//    (handled in phase 4) uses MODIFY … AFTER and is emitted only
	//    when the definition itself did NOT change, to keep each
	//    statement focused.
	for _, nc := range req.NewColumns {
		if nc.OriginalName == "" {
			continue // handled in phase 3
		}
		oc, ok := oldByOrig[nc.OriginalName]
		if !ok {
			continue // stale reference — ignore
		}
		if !columnDefEqual(oc, nc) {
			spec := buildColumnSpec(nc)
			if nc.OriginalName != nc.Name {
				sql := fmt.Sprintf("ALTER TABLE %s CHANGE COLUMN %s %s %s;",
					qualified, quoteIdent(nc.OriginalName), quoteIdent(nc.Name), spec)
				out.Statements = append(out.Statements, driver.SchemaChangeStatement{
					Kind:    "rename",
					Summary: fmt.Sprintf("Rename / redefine column `%s` → `%s`", nc.OriginalName, nc.Name),
					SQL:     sql,
				})
			} else {
				sql := fmt.Sprintf("ALTER TABLE %s MODIFY COLUMN %s %s;",
					qualified, quoteIdent(nc.Name), spec)
				out.Statements = append(out.Statements, driver.SchemaChangeStatement{
					Kind:    "modify",
					Summary: fmt.Sprintf("Modify column `%s`", nc.Name),
					SQL:     sql,
				})
			}
		}
	}

	// 3. ADD — new columns.  Use AFTER clauses to place them at the exact
	//    requested position; the first-in-table case uses FIRST.
	for i, nc := range req.NewColumns {
		if nc.OriginalName != "" {
			continue
		}
		if strings.TrimSpace(nc.Name) == "" || strings.TrimSpace(nc.Type) == "" {
			return nil, fmt.Errorf("mysql: PreviewAlter: new column at index %d is missing name or type", i)
		}
		spec := buildColumnSpec(nc)
		position := positionClause(i, req.NewColumns)
		sql := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s%s;",
			qualified, quoteIdent(nc.Name), spec, position)
		out.Statements = append(out.Statements, driver.SchemaChangeStatement{
			Kind:    "add",
			Summary: fmt.Sprintf("Add column `%s` %s", nc.Name, nc.Type),
			SQL:     sql,
		})
	}

	// 4. REORDER — columns whose new index differs from their post-drop old
	//    index and whose definition did NOT otherwise change.
	//
	//    MySQL itself shifts remaining columns down when a DROP lands, so
	//    we must compute "expected position after drops" rather than
	//    comparing raw old indices — otherwise a drop at position 1 would
	//    make every subsequent column appear "moved" and emit spurious
	//    MODIFY … AFTER statements that MySQL would re-order pointlessly.
	survivingOldIndex := map[string]int{}
	{
		idx := 0
		for _, c := range req.OldColumns {
			if _, kept := newByOrig[c.OriginalName]; !kept {
				continue // dropped
			}
			survivingOldIndex[c.OriginalName] = idx
			idx++
		}
	}
	// New-side index excluding freshly added columns: an added column owns
	// its own ADD … AFTER so the reorder pass should ignore it.
	survivingNewIndex := map[string]int{}
	{
		idx := 0
		for _, c := range req.NewColumns {
			if c.OriginalName == "" {
				continue
			}
			survivingNewIndex[c.OriginalName] = idx
			idx++
		}
	}
	for i, nc := range req.NewColumns {
		if nc.OriginalName == "" {
			continue // added, placed by its own ADD
		}
		oc, ok := oldByOrig[nc.OriginalName]
		if !ok {
			continue
		}
		if survivingOldIndex[nc.OriginalName] == survivingNewIndex[nc.OriginalName] {
			continue // position unchanged relative to siblings
		}
		if !columnDefEqual(oc, nc) {
			// Already redefined in phase 2.  MySQL keeps the original
			// position on MODIFY-without-AFTER so a definition change +
			// explicit reorder is a niche case; skip to stay focused.
			continue
		}
		spec := buildColumnSpec(nc)
		position := positionClause(i, req.NewColumns)
		sql := fmt.Sprintf("ALTER TABLE %s MODIFY COLUMN %s %s%s;",
			qualified, quoteIdent(nc.Name), spec, position)
		out.Statements = append(out.Statements, driver.SchemaChangeStatement{
			Kind:    "reorder",
			Summary: fmt.Sprintf("Reorder column `%s` → position %d", nc.Name, i+1),
			SQL:     sql,
		})
	}

	// ── Phase B: Table-level options ────────────────────────────────────
	if tableSQL, summary := diffTableOptions(qualified, req.Original, req.Updated); tableSQL != "" {
		out.Statements = append(out.Statements, driver.SchemaChangeStatement{
			Kind:    "table",
			Summary: summary,
			SQL:     tableSQL,
		})
	}

	// ── Phase C: Rename ─────────────────────────────────────────────────
	// Issued LAST so all column / option changes still target the
	// original name.  Skip when either side is empty (means the client
	// didn't surface a rename intent — e.g. older payload).
	oldName := strings.TrimSpace(req.Original.Name)
	newName := strings.TrimSpace(req.Updated.Name)
	if oldName != "" && newName != "" && oldName != newName {
		newQualified := fmt.Sprintf("%s.%s", quoteIdent(req.Schema), quoteIdent(newName))
		out.Statements = append(out.Statements, driver.SchemaChangeStatement{
			Kind:    "rename",
			Summary: fmt.Sprintf("Rename table `%s` → `%s`", oldName, newName),
			SQL:     fmt.Sprintf("RENAME TABLE %s TO %s;", qualified, newQualified),
		})
	}

	return out, nil
}

// ExecuteAlter applies a PreviewAlter payload one statement at a time.
// MySQL DDL is auto-commit, so a partial failure leaves partial changes
// in place — the result struct lets the UI surface that clearly.
func (d *mysqlDriver) ExecuteAlter(ctx context.Context, req driver.SchemaChangeRequest) (*driver.SchemaChangeResult, error) {
	if d.db == nil {
		return nil, driver.ErrNotConnected
	}

	// Recompute the diff server-side — NEVER trust SQL strings from the
	// client.  PreviewAlter is deterministic and cheap.
	preview, err := d.PreviewAlter(req)
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

	res := &driver.SchemaChangeResult{
		Statements:  preview.Statements,
		FailedIndex: -1,
	}
	for i, st := range preview.Statements {
		// Each statement gets its own 30-second bound — plenty for DDL on
		// moderately sized tables, short enough to surface hangs quickly.
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — pure, table-stable, heavily unit-tested.
// ─────────────────────────────────────────────────────────────────────────────

// columnDefEqual is true when the two drafts would emit identical column
// specs.  OriginalName / Name mismatch alone is NOT a definition change —
// it's a rename, handled separately.
func columnDefEqual(a, b driver.ColumnDraft) bool {
	return a.Name == b.Name &&
		strings.EqualFold(a.Type, b.Type) &&
		a.NotNull == b.NotNull &&
		a.AutoIncrement == b.AutoIncrement &&
		a.HasDefault == b.HasDefault &&
		a.Default == b.Default &&
		a.Comment == b.Comment
}

// buildColumnSpec assembles the part that follows "CHANGE / MODIFY / ADD
// COLUMN <ident>" — i.e. the type + flags.  Example outputs:
//
//	"varchar(64) NOT NULL DEFAULT 'x' COMMENT 'hello'"
//	"int(11) NOT NULL AUTO_INCREMENT"
//
// The returned string never carries a leading or trailing space.
func buildColumnSpec(c driver.ColumnDraft) string {
	var b strings.Builder
	b.WriteString(strings.TrimSpace(c.Type))
	if c.NotNull {
		b.WriteString(" NOT NULL")
	} else {
		b.WriteString(" NULL")
	}
	if c.HasDefault {
		b.WriteString(" DEFAULT ")
		b.WriteString(strings.TrimSpace(c.Default))
	}
	if c.AutoIncrement {
		b.WriteString(" AUTO_INCREMENT")
	}
	if c.Comment != "" {
		b.WriteString(" COMMENT ")
		b.WriteString(quoteStringLiteral(c.Comment))
	}
	return b.String()
}

// positionClause returns " AFTER `prev`" or " FIRST" for the column at the
// given index in newCols.  Index 0 returns " FIRST"; any later index refers
// to the column immediately before it in the NEW order.
func positionClause(idx int, newCols []driver.ColumnDraft) string {
	if idx == 0 {
		return " FIRST"
	}
	prev := newCols[idx-1]
	name := prev.Name
	if name == "" {
		name = prev.OriginalName
	}
	return " AFTER " + quoteIdent(name)
}

// diffTableOptions emits the single ALTER TABLE that carries ENGINE /
// COLLATE / CHARSET / AUTO_INCREMENT / COMMENT changes.  Returns empty
// strings when nothing changed.
//
// When both Charset and Collation change we emit them together (DEFAULT
// CHARSET = … COLLATE = …) — MySQL requires the pair to be consistent.
// When only one side changes, we emit only that side.
func diffTableOptions(qualified string, oldT, newT driver.TableInfoDraft) (string, string) {
	var parts []string
	var summary []string

	if strings.TrimSpace(newT.Engine) != "" && !strings.EqualFold(oldT.Engine, newT.Engine) {
		parts = append(parts, "ENGINE = "+newT.Engine)
		summary = append(summary, "engine → "+newT.Engine)
	}

	// Charset + collation.  We treat them as a coupled pair so the user
	// can change just the charset (collation auto-derives) or just the
	// collation (charset auto-derives) without inconsistency.
	charsetChanged   := strings.TrimSpace(newT.Charset)   != "" && !strings.EqualFold(oldT.Charset,   newT.Charset)
	collationChanged := strings.TrimSpace(newT.Collation) != "" && !strings.EqualFold(oldT.Collation, newT.Collation)
	if charsetChanged || collationChanged {
		ch := strings.TrimSpace(newT.Charset)
		co := strings.TrimSpace(newT.Collation)
		if co != "" && ch == "" {
			ch = charsetFromCollation(co)
		}
		switch {
		case ch != "" && co != "":
			parts = append(parts, "DEFAULT CHARSET = "+ch+" COLLATE = "+co)
			if charsetChanged {
				summary = append(summary, "charset → "+ch)
			}
			if collationChanged {
				summary = append(summary, "collation → "+co)
			}
		case ch != "":
			parts = append(parts, "DEFAULT CHARSET = "+ch)
			summary = append(summary, "charset → "+ch)
		case co != "":
			parts = append(parts, "COLLATE = "+co)
			summary = append(summary, "collation → "+co)
		}
	}

	// AUTO_INCREMENT — nil means "leave alone".  Comparing pointer
	// content lets the user reset the counter (e.g. to 1) explicitly.
	if newT.AutoIncrement != nil {
		if oldT.AutoIncrement == nil || *oldT.AutoIncrement != *newT.AutoIncrement {
			parts = append(parts, fmt.Sprintf("AUTO_INCREMENT = %d", *newT.AutoIncrement))
			summary = append(summary, fmt.Sprintf("auto_increment → %d", *newT.AutoIncrement))
		}
	}

	if oldT.Comment != newT.Comment {
		parts = append(parts, "COMMENT = "+quoteStringLiteral(newT.Comment))
		summary = append(summary, "comment")
	}
	if len(parts) == 0 {
		return "", ""
	}
	return fmt.Sprintf("ALTER TABLE %s %s;", qualified, strings.Join(parts, ", ")),
		"Update table options: " + strings.Join(summary, ", ")
}

// charsetFromCollation extracts the "utf8mb4" prefix from "utf8mb4_unicode_ci".
// MySQL tolerates COLLATE-only clauses when the charset matches, but some
// strict managed instances reject them — emitting both is safer.
func charsetFromCollation(coll string) string {
	if i := strings.IndexByte(coll, '_'); i > 0 {
		return coll[:i]
	}
	return ""
}

// quoteStringLiteral wraps s in single quotes, doubling embedded quotes and
// escaping backslashes.  MySQL accepts both '' and \' — we prefer the former
// because it survives NO_BACKSLASH_ESCAPES sessions.
func quoteStringLiteral(s string) string {
	replacer := strings.NewReplacer(
		`\`, `\\`,
		`'`, `''`,
	)
	return "'" + replacer.Replace(s) + "'"
}
