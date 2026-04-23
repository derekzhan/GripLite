package main

import (
	"runtime"
	"time"
)

// BuildInfo is the IPC-serialisable payload returned by App.GetBuildInfo().
//
// Phase 18 — used by the frontend About modal.  All fields are strings so
// the frontend can render them verbatim without formatting logic.
type BuildInfo struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	BuildDate string `json:"buildDate"`
	Platform  string `json:"platform"`
	GoVersion string `json:"goVersion"`
	License   string `json:"license"`
	Author    string `json:"author"`
	Email     string `json:"email"`
	Homepage  string `json:"homepage"`
}

// Build metadata — override at release time with:
//
//	go build -ldflags \
//	  "-X main.buildVersion=v0.1.2 -X main.buildDate=2026-04-16" ./...
//
// The default values below are always safe to ship so development builds
// still surface meaningful data in the About dialog.
var (
	buildVersion = "v0.1.3"
	buildDate    = time.Now().UTC().Format("2006-01-02") // overwritten at link time
)

// GetBuildInfo is exposed over Wails IPC and feeds the About modal.
func (a *App) GetBuildInfo() BuildInfo {
	return BuildInfo{
		Name:      "GripLite",
		Version:   buildVersion,
		BuildDate: buildDate,
		Platform:  "Wails + React / " + runtime.GOOS + "/" + runtime.GOARCH,
		GoVersion: runtime.Version(),
		License:   "MIT",
		Author:    "derek",
		Email:     "zhanweichun@gmail.com",
		Homepage:  "https://github.com/derek-zhanweichun/GripLite",
	}
}
