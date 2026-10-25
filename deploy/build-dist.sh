#!/usr/bin/env bash
# Adds the installers and a source tarball to the web build, so servers install from
# spot-solutions.web.app with no GitHub dependency. Run after `vite build`, before deploying.
set -euo pipefail
cd "$(dirname "$0")/.."
DIST=apps/web/dist
mkdir -p "$DIST/dl"
SHA=$(git rev-parse --short HEAD)
TMP=$(mktemp -d)
git archive HEAD | tar -x -C "$TMP"
echo "$SHA" > "$TMP/VERSION"
tar -czf "$DIST/dl/spot-solutions.tar.gz" -C "$TMP" .
cp deploy/install.sh "$DIST/install.sh"
cp deploy/windows/install.ps1 "$DIST/install.ps1"
(cd deploy && rm -f "$TMP/w.zip" && cp -R windows "$TMP/SpotSolutions-Windows" && cd "$TMP" && zip -qr w.zip SpotSolutions-Windows)
mv "$TMP/w.zip" "$DIST/dl/SpotSolutions-Windows.zip, dl/SpotServer.dmg, install-mac.sh"
# macOS app: build it if this machine can (needs Xcode command-line tools), then publish.
if command -v swiftc >/dev/null; then deploy/mac/build.sh "$TMP/mac" >/dev/null && cp "$TMP/mac/SpotServer.dmg" "$DIST/dl/SpotServer.dmg"; fi
cp deploy/mac/install-mac.sh "$DIST/install-mac.sh"
rm -rf "$TMP"
echo "dist: install.sh, install.ps1, dl/spot-solutions.tar.gz ($SHA), dl/SpotSolutions-Windows.zip, dl/SpotServer.dmg, install-mac.sh"
