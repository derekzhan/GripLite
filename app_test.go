package main

import "testing"

func TestBuildPagedQuery(t *testing.T) {
	sql, err := buildPagedQuery(" select * from users; \n", 200, 400)
	if err != nil {
		t.Fatalf("buildPagedQuery returned error: %v", err)
	}
	want := "SELECT * FROM (select * from users) _griplite_page LIMIT 200 OFFSET 400"
	if sql != want {
		t.Fatalf("buildPagedQuery() = %q, want %q", sql, want)
	}
}

func TestBuildPagedQueryPreservesInnerLimit(t *testing.T) {
	sql, err := buildPagedQuery("SELECT * FROM users LIMIT 100000", 200, 0)
	if err != nil {
		t.Fatalf("buildPagedQuery returned error: %v", err)
	}
	want := "SELECT * FROM (SELECT * FROM users LIMIT 100000) _griplite_page LIMIT 200 OFFSET 0"
	if sql != want {
		t.Fatalf("buildPagedQuery() = %q, want %q", sql, want)
	}
}

func TestBuildPagedQueryRejectsNonSelect(t *testing.T) {
	if _, err := buildPagedQuery("SHOW TABLES", 200, 0); err == nil {
		t.Fatal("expected non-select query to be rejected")
	}
}
