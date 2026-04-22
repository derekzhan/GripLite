#!/usr/bin/env bash
# GripLite release builder.
#
# Builds darwin/arm64 + darwin/amd64 + windows/amd64 + linux/amd64 and drops
# matching installers / archives under ./dist. Does NOT push or create the
# GitHub release — call `gh release create` afterwards with dist/*.
#
# Usage:
#   scripts/release.sh v0.1.2
#
# Exits non-zero if any platform fails to build.

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version>   (e.g. v0.1.2)" >&2
  exit 2
fi
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "error: version must look like vX.Y.Z (got '$VERSION')" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUILD_DATE=$(date -u +%Y-%m-%d)
LDFLAGS="-X main.buildVersion=${VERSION} -X main.buildDate=${BUILD_DATE}"
WAILS="${WAILS:-$HOME/go/bin/wails}"
if [[ ! -x "$WAILS" ]]; then
  WAILS=$(command -v wails)
fi

mkdir -p dist
rm -f dist/GripLite-"${VERSION}"-*.dmg dist/GripLite-"${VERSION}"-*.zip dist/GripLite-"${VERSION}"-*.tar.gz

echo "==> GripLite release ${VERSION}   date=${BUILD_DATE}"
echo "==> wails = ${WAILS}"

build_one() {
  local platform="$1" clean="$2"
  echo ""
  echo "---- building ${platform} ----"
  # Clean first build so frontend is rebuilt once; subsequent builds reuse dist.
  if [[ "$clean" == "clean" ]]; then
    "$WAILS" build -clean -platform "$platform" -ldflags "$LDFLAGS"
  else
    "$WAILS" build -platform "$platform" -ldflags "$LDFLAGS"
  fi
}

# --- darwin/arm64 -----------------------------------------------------------
build_one darwin/arm64 clean
STAGING=$(mktemp -d)
cp -R build/bin/GripLite.app "$STAGING/"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname "GripLite ${VERSION}" -srcfolder "$STAGING" \
  -ov -format UDZO "dist/GripLite-${VERSION}-darwin-arm64.dmg" >/dev/null
rm -rf "$STAGING"

# --- darwin/amd64 -----------------------------------------------------------
build_one darwin/amd64 keep
STAGING=$(mktemp -d)
cp -R build/bin/GripLite.app "$STAGING/"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname "GripLite ${VERSION}" -srcfolder "$STAGING" \
  -ov -format UDZO "dist/GripLite-${VERSION}-darwin-amd64.dmg" >/dev/null
rm -rf "$STAGING"

# --- windows/amd64 ----------------------------------------------------------
build_one windows/amd64 keep
( cd build/bin && zip -q "${ROOT}/dist/GripLite-${VERSION}-windows-amd64.zip" GripLite.exe )

# --- linux/amd64 ------------------------------------------------------------
build_one linux/amd64 keep
( cd build/bin && tar -czf "${ROOT}/dist/GripLite-${VERSION}-linux-amd64.tar.gz" GripLite )

echo ""
echo "==> artifacts:"
ls -lh dist/GripLite-"${VERSION}"-*

cat <<EOF

==> next step:
    gh release create ${VERSION} \\
      --title "GripLite ${VERSION}" \\
      --notes-file RELEASE_NOTES.md \\
      dist/GripLite-${VERSION}-darwin-arm64.dmg \\
      dist/GripLite-${VERSION}-darwin-amd64.dmg \\
      dist/GripLite-${VERSION}-windows-amd64.zip \\
      dist/GripLite-${VERSION}-linux-amd64.tar.gz
EOF
