package main

import (
	"runtime"

	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Native menu event names. The frontend (App.jsx) subscribes to these and opens
// the matching modal, so the menu logic stays in one place on the JS side.
const (
	menuEventSettings    = "menu:settings"
	menuEventShortcuts   = "menu:shortcuts"
	menuEventAbout       = "menu:about"
	menuEventConsoleSave = "menu:console-save"
	menuEventConsoleOpen = "menu:console-open"
)

// buildAppMenu returns the native application menu.
//
// On macOS this drives the global top-of-screen menu bar: we keep the standard
// App / Edit / Window menus and append Tools and Help after Window, so the
// items that used to live in the in-app HTML bar feel native and unobtrusive.
//
// On Windows/Linux there is no global menu bar, so we return nil and let the
// in-app MenuBar component continue to host Tools / Help inside the window.
func (a *App) buildAppMenu() *menu.Menu {
	if runtime.GOOS != "darwin" {
		return nil
	}

	emit := func(event string) menu.Callback {
		return func(_ *menu.CallbackData) {
			if a.ctx != nil {
				wailsruntime.EventsEmit(a.ctx, event)
			}
		}
	}

	appMenu := menu.NewMenu()
	appMenu.Append(menu.AppMenu())  // GripLite (About / Quit) — provided by macOS
	appMenu.Append(menu.EditMenu()) // Cut / Copy / Paste / Select-All
	appMenu.Append(menu.WindowMenu())

	// Consoles — DBeaver-style saved SQL scripts. Lives next to Tools in the
	// native menu bar. The saved list is dynamic, so RefreshAppMenu rebuilds and
	// re-applies the whole menu whenever it changes.
	consoles := appMenu.AddSubmenu("Consoles")
	consoles.AddText("Save current console…", keys.CmdOrCtrl("s"), emit(menuEventConsoleSave))
	consoles.AddSeparator()
	if saved, err := a.ListSavedConsoles(); err == nil && len(saved) > 0 {
		for _, c := range saved {
			id := c.ID // capture per-iteration for the closure
			consoles.AddText(c.Name, nil, func(_ *menu.CallbackData) {
				if a.ctx != nil {
					wailsruntime.EventsEmit(a.ctx, menuEventConsoleOpen, id)
				}
			})
		}
	} else {
		empty := consoles.AddText("No saved consoles", nil, nil)
		empty.Disabled = true
	}

	tools := appMenu.AddSubmenu("Tools")
	tools.AddText("Settings…", keys.CmdOrCtrl(","), emit(menuEventSettings))

	help := appMenu.AddSubmenu("Help")
	help.AddText("Keyboard Shortcuts", nil, emit(menuEventShortcuts))
	help.AddText("About GripLite", nil, emit(menuEventAbout))

	return appMenu
}

// RefreshAppMenu rebuilds the native application menu and re-applies it so the
// Consoles submenu reflects the current saved-console list. macOS-only; a no-op
// elsewhere or before startup (when there's no live context to update).
func (a *App) RefreshAppMenu() {
	if runtime.GOOS != "darwin" || a.ctx == nil {
		return
	}
	m := a.buildAppMenu()
	if m == nil {
		return
	}
	wailsruntime.MenuSetApplicationMenu(a.ctx, m)
	wailsruntime.MenuUpdateApplicationMenu(a.ctx)
}
