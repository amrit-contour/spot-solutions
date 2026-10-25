#!/usr/bin/env bash
# Installs Spot Server.app into /Applications and opens it.
#   curl -fsSL https://spot-solutions.web.app/install-mac.sh | bash
# Downloading with curl (instead of a browser) avoids the "unidentified developer" prompt.
set -euo pipefail
DMG="$(mktemp -d)/SpotServer.dmg"
echo "▸ Downloading Spot Server"
curl -fSL --progress-bar https://spot-solutions.web.app/dl/SpotServer.dmg -o "$DMG"
MNT="$(hdiutil attach -nobrowse -readonly "$DMG" | awk -F'\t' '/\/Volumes\//{print $NF}')"
echo "▸ Installing to /Applications"
rm -rf "/Applications/Spot Server.app"
cp -R "$MNT/Spot Server.app" /Applications/
hdiutil detach -quiet "$MNT"
xattr -dr com.apple.quarantine "/Applications/Spot Server.app" 2>/dev/null || true
echo "✓ Installed. Opening Spot Server…"
open "/Applications/Spot Server.app"
