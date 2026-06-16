package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// SavedConsole is a DBeaver-style named SQL script: the SQL plus the
// connection/database it was authored against. Persisted in griplite.db so it
// survives app restarts and reinstalls.
type SavedConsole struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	SQL            string `json:"sql"`
	ConnID         string `json:"connId"`
	DBName         string `json:"dbName"`
	ConnectionKind string `json:"connectionKind"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}

// newConsoleID returns a short random hex id for a freshly-saved console.
func newConsoleID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand should never fail; fall back to a fixed-width zero id
		// rather than panicking the whole save.
		return "console-0000000000000000"
	}
	return "console-" + hex.EncodeToString(b[:])
}

// ListSavedConsoles returns every saved console, most-recently-updated first.
func (a *App) ListSavedConsoles() ([]SavedConsole, error) {
	if a.sharedDB == nil {
		return nil, fmt.Errorf("local database not initialised")
	}
	rows, err := a.sharedDB.Query(
		`SELECT id, name, sql, conn_id, db_name, connection_kind, created_at, updated_at
		 FROM saved_consoles
		 ORDER BY updated_at DESC, name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SavedConsole{}
	for rows.Next() {
		var c SavedConsole
		if err := rows.Scan(&c.ID, &c.Name, &c.SQL, &c.ConnID, &c.DBName,
			&c.ConnectionKind, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SaveConsole inserts a new saved console (when ID is empty) or updates an
// existing one in place. It returns the persisted row including its id and
// timestamps so the frontend can bind the open tab to it.
func (a *App) SaveConsole(c SavedConsole) (SavedConsole, error) {
	if a.sharedDB == nil {
		return SavedConsole{}, fmt.Errorf("local database not initialised")
	}
	if c.Name == "" {
		return SavedConsole{}, fmt.Errorf("console name is required")
	}

	if c.ID == "" {
		c.ID = newConsoleID()
		_, err := a.sharedDB.Exec(
			`INSERT INTO saved_consoles (id, name, sql, conn_id, db_name, connection_kind)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			c.ID, c.Name, c.SQL, c.ConnID, c.DBName, c.ConnectionKind,
		)
		if err != nil {
			return SavedConsole{}, err
		}
	} else {
		res, err := a.sharedDB.Exec(
			`UPDATE saved_consoles
			 SET name = ?, sql = ?, conn_id = ?, db_name = ?, connection_kind = ?,
			     updated_at = datetime('now')
			 WHERE id = ?`,
			c.Name, c.SQL, c.ConnID, c.DBName, c.ConnectionKind, c.ID,
		)
		if err != nil {
			return SavedConsole{}, err
		}
		// If the id no longer exists (deleted elsewhere), fall back to insert so
		// the user never silently loses a save.
		if n, _ := res.RowsAffected(); n == 0 {
			_, err := a.sharedDB.Exec(
				`INSERT INTO saved_consoles (id, name, sql, conn_id, db_name, connection_kind)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				c.ID, c.Name, c.SQL, c.ConnID, c.DBName, c.ConnectionKind,
			)
			if err != nil {
				return SavedConsole{}, err
			}
		}
	}

	var out SavedConsole
	err := a.sharedDB.QueryRow(
		`SELECT id, name, sql, conn_id, db_name, connection_kind, created_at, updated_at
		 FROM saved_consoles WHERE id = ?`, c.ID,
	).Scan(&out.ID, &out.Name, &out.SQL, &out.ConnID, &out.DBName,
		&out.ConnectionKind, &out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return SavedConsole{}, err
	}
	a.RefreshAppMenu() // keep the native Consoles submenu in sync
	return out, nil
}

// DeleteSavedConsole removes a saved console by id. Deleting a non-existent id
// is a no-op (no error).
func (a *App) DeleteSavedConsole(id string) error {
	if a.sharedDB == nil {
		return fmt.Errorf("local database not initialised")
	}
	if id == "" {
		return nil
	}
	_, err := a.sharedDB.Exec(`DELETE FROM saved_consoles WHERE id = ?`, id)
	if err == nil {
		a.RefreshAppMenu() // keep the native Consoles submenu in sync
	}
	return err
}
