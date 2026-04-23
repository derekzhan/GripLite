#!/usr/bin/env bash
# Build GripLite for linux/amd64 inside Docker (required on macOS — Wails does
# not cross-compile to Linux). Uses golang:1.25-bookworm + webkit2gtk-4.0-dev
# (Wails expects webkit2gtk-4.0.pc). Reinstalls frontend deps inside the
# container so esbuild matches linux/amd64.
#
# Usage:
#   scripts/build-linux-amd64-docker.sh v0.1.3 '-X main.buildVersion=v0.1.3 -X main.buildDate=2026-04-23'
#
# Outputs: build/bin/GripLite (ELF amd64)

set -euo pipefail

VERSION="${1:?version e.g. v0.1.3}"
LDFLAGS="${2:?ldflags}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

docker run --rm --platform linux/amd64 \
  -e LDFLAGS="$LDFLAGS" \
  -v "$ROOT":/app \
  -w /app \
  golang:1.25-bookworm bash -c '
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/go/bin:$PATH"
apt-get update -qq
apt-get install -y -qq build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.0-dev nodejs npm >/dev/null
go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0
export PATH="$PATH:$(go env GOPATH)/bin"
rm -rf frontend/node_modules
(cd frontend && npm ci)
wails build -platform linux/amd64 -ldflags "$LDFLAGS"
'

echo "==> $(file build/bin/GripLite)"
