package main

import (
	"runtime"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/menu"
)

// findSubmenu returns the submenu with the given label, or nil.
func findSubmenu(m *menu.Menu, label string) *menu.Menu {
	for _, it := range m.Items {
		if it.Label == label && it.SubMenu != nil {
			return it.SubMenu
		}
	}
	return nil
}

func hasItem(m *menu.Menu, label string) *menu.MenuItem {
	if m == nil {
		return nil
	}
	for _, it := range m.Items {
		if it.Label == label {
			return it
		}
	}
	return nil
}

// TestBuildAppMenu_DarwinHasToolsAndHelp verifies the native menu exposes the
// Tools and Help submenus (with click handlers) on macOS, and that invoking a
// handler with no live context is a safe no-op.
func TestBuildAppMenu_DarwinHasToolsAndHelp(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("native application menu is only built on macOS")
	}

	m := (&App{}).buildAppMenu()
	if m == nil {
		t.Fatal("buildAppMenu returned nil on darwin")
	}

	tools := findSubmenu(m, "Tools")
	if tools == nil {
		t.Fatal("Tools submenu missing")
	}
	settings := hasItem(tools, "Settings…")
	if settings == nil || settings.Click == nil {
		t.Fatal("Tools → Settings… missing or has no click handler")
	}

	consoles := findSubmenu(m, "Consoles")
	if consoles == nil {
		t.Fatal("Consoles submenu missing")
	}
	save := hasItem(consoles, "Save current console…")
	if save == nil || save.Click == nil {
		t.Fatal("Consoles → Save current console… missing or has no click handler")
	}
	// With no DB (a.ctx == nil), clicking must not panic.
	save.Click(nil)

	help := findSubmenu(m, "Help")
	if help == nil {
		t.Fatal("Help submenu missing")
	}
	for _, label := range []string{"Keyboard Shortcuts", "About GripLite"} {
		if item := hasItem(help, label); item == nil || item.Click == nil {
			t.Fatalf("Help → %q missing or has no click handler", label)
		}
	}

	// Clicking before startup (a.ctx == nil) must not panic.
	settings.Click(nil)
}

// TestBuildAppMenu_NonDarwinIsNil documents that non-macOS platforms fall back
// to the in-app MenuBar (no native menu). Skipped on macOS.
func TestBuildAppMenu_NonDarwinIsNil(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("only meaningful off macOS")
	}
	if m := (&App{}).buildAppMenu(); m != nil {
		t.Fatal("expected nil native menu on non-macOS platform")
	}
}
