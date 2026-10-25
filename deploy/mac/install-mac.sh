#!/usr/bin/env bash
# Installs Spot Server.app into /Applications and opens it.
#   curl -fsSL https://spot-solutions.web.app/install-mac.sh | bash
# Downloading with curl (instead of a browser) avoids the "unidentified developer" prompt.
set -euo pipefail
TMP="$(mktemp -d)"
echo "▸ Downloading Spot Server"
curl -fSL --progress-bar https://spot-solutions.web.app/dl/SpotServer-mac.zip -o "$TMP/SpotServer.zip"
echo "▸ Installing to /Applications"
ditto -x -k "$TMP/SpotServer.zip" "$TMP"
rm -rf "/Applications/Spot Server.app"
mv "$TMP/Spot Server.app" /Applications/
rm -rf "$TMP"
xattr -dr com.apple.quarantine "/Applications/Spot Server.app" 2>/dev/null || true
echo "✓ Installed. Opening Spot Server…"
open "/Applications/Spot Server.app"
