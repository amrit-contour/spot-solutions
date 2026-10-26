#!/usr/bin/env bash
# Installs Spot Server.app into /Applications and opens it.
#   curl -fsSL https://spot-solutions.web.app/install-mac.sh | bash
# Downloading with curl (instead of a browser) avoids the "unidentified developer" prompt.
# Also reached through `curl -fsSL https://spot-solutions.web.app/install.sh | bash`, which hands Macs over to this script.
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
echo "✓ App installed."
# One command does it all: set the Mac up now (a few minutes the first time: Node.js and, on a Mac with about 8 GB or
# more, a local Gemma model). Skip with SPOT_SKIP_SETUP=1 and click "Set up this Mac" in the app instead.
if [[ "${SPOT_SKIP_SETUP:-0}" != 1 ]]; then
  echo "▸ Setting up this Mac"
  "/Applications/Spot Server.app/Contents/Resources/spotctl" setup || echo "Setup didn't finish. Open Spot Server and click Set up this Mac to retry."
fi
echo "✓ Opening Spot Server. In its console, click Connect with Spot Solutions and sign in."
open "/Applications/Spot Server.app"
