# GripLite

**GripLite** is a lightweight, cross-platform database IDE for MySQL — fast to launch, easy to use, and designed to stay out of your way.

![GripLite Screenshot](build/appicon.png)

> **Latest release:** [v0.1.4](https://github.com/derekzhan/GripLite/releases/latest)

---

## Features

- **SQL Console** — Monaco-based editor with syntax highlighting, multi-statement execution, and `Shift+Alt+F` format SQL
- **Autocomplete** — Table and column suggestions scoped to the active database; dot-completion resolves aliases (`t.` → columns of the aliased table)
- **Database explorer** — Browse connections, databases, and tables in a tree view; right-click for context actions
- **Table viewer** — Paginated data grid with inline editing (add / edit / delete rows), WHERE filter bar with history, and server-side `ORDER BY` sort by clicking column headers
- **Result set** — Client-side column-header sort, CSV export, Grid / Text / Record view modes, and a draggable value detail panel
- **Database selector** — Per-console dropdown to switch databases; every query automatically carries the correct database context
- **Keyboard shortcuts** — Full keyboard navigation in all context menus; see **Help → Keyboard Shortcuts** for the complete reference
- **Theme** — Light and dark mode with live switching
- **Cross-platform** — macOS (Apple Silicon & Intel), Windows, Linux

---

## Installation

Download the latest build for your platform from the [Releases](https://github.com/derekzhan/GripLite/releases) page:

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `GripLite-vX.Y.Z-darwin-arm64.dmg` |
| macOS (Intel) | `GripLite-vX.Y.Z-darwin-amd64.dmg` |
| Windows x64 | `GripLite-vX.Y.Z-windows-amd64.zip` |
| Linux x64 | `GripLite-vX.Y.Z-linux-amd64.tar.gz` |

### macOS — Gatekeeper

The app is self-signed but not notarized. To open it for the first time:

```bash
xattr -dr com.apple.quarantine /Applications/GripLite.app
```

### Windows

Extract the ZIP and run `GripLite.exe` directly — no installer required.

### Linux

```bash
tar -xzf GripLite-vX.Y.Z-linux-amd64.tar.gz
./GripLite
```

---

## Building from Source

### Prerequisites

| Tool | Version |
|---|---|
| Go | 1.22+ |
| Node.js | 18+ |
| Wails CLI | v2.12+ |

Install Wails:

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
```

### Development

```bash
git clone https://github.com/derekzhan/GripLite.git
cd GripLite
wails dev
```

This starts a Vite dev server with hot-reload for the frontend and live-reload for the Go backend.

### Production build

```bash
# macOS (Apple Silicon)
wails build -platform darwin/arm64

# macOS (Intel)
wails build -platform darwin/amd64

# Windows
wails build -platform windows/amd64
```

For a full multi-platform release (including Linux via Docker):

```bash
./scripts/release.sh vX.Y.Z
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Application framework | [Wails v2](https://wails.io) (Go + WebView) |
| Frontend | React 18, Vite |
| Editor | Monaco Editor (`@monaco-editor/react`) |
| Data grid | Glide Data Grid (`@glideapps/glide-data-grid`) |
| Styling | Tailwind CSS |
| Icons | Lucide React |
| SQL formatting | sql-formatter |
| Backend | Go — `database/sql` + `go-sql-driver/mysql` |

---

## Contributing

Pull requests are welcome. For larger changes, please open an issue first to discuss what you would like to change.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'feat: add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## License

[MIT](LICENSE)
