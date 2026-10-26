#!/usr/bin/env bash
# Installs Nothing BOT Server.app into /Applications and opens it.
#   curl -fsSL https://nothingbotcurating.web.app/install-mac.sh | bash
# Downloading with curl (instead of a browser) avoids the "unidentified developer" prompt.
# Also reached through `curl -fsSL https://nothingbotcurating.web.app/install.sh | bash`, which hands Macs over to this script.
set -euo pipefail
# Settings from before the rename to Nothing BOT Server were called SPOT_*; keep honouring them.
for _v in $(compgen -v SPOT_ || true); do _n="NBS_${_v#SPOT_}"; [[ -n "${!_n+x}" ]] || export "$_n=${!_v}"; done
BASE="${NBS_DIST_URL:-https://nothingbotcurating.web.app}"
TMP="$(mktemp -d)"
echo "▸ Downloading Nothing BOT Server"
curl -fSL --progress-bar "$BASE/dl/NothingBotServer-mac.zip" -o "$TMP/NothingBotServer.zip"
echo "▸ Installing to /Applications"
ditto -x -k "$TMP/NothingBotServer.zip" "$TMP"
rm -rf "/Applications/Nothing BOT Server.app"
mv "$TMP/Nothing BOT Server.app" /Applications/
rm -rf "$TMP"
xattr -dr com.apple.quarantine "/Applications/Nothing BOT Server.app" 2>/dev/null || true
# The old app (called "Spot Server") is only a window onto the old server; setup below stops that server.
if [[ -d "/Applications/Spot Server.app" ]]; then
  osascript -e 'quit app "Spot Server"' >/dev/null 2>&1 || true
  rm -rf "/Applications/Spot Server.app"
  echo "  Removed the old Spot Server app (its data is kept)."
fi
echo "✓ App installed."
# One command does it all: set the Mac up now (a few minutes the first time: Node.js and, on a Mac with about 8 GB or
# more, a local Gemma model). Skip with NBS_SKIP_SETUP=1 and click "Set up this Mac" in the app instead.
if [[ "${NBS_SKIP_SETUP:-0}" != 1 ]]; then
  echo "▸ Setting up this Mac"
  "/Applications/Nothing BOT Server.app/Contents/Resources/nbsctl" setup || echo "Setup didn't finish. Open Nothing BOT Server and click Set up this Mac to retry."
fi
echo "✓ Opening Nothing BOT Server. In its console, click Connect with Nothing BOT Curating and sign in."
open "/Applications/Nothing BOT Server.app"
