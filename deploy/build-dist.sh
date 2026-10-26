#!/usr/bin/env bash
# Adds the installers and a source tarball to the web build, so servers install from
# spot-solutions.web.app with no GitHub dependency. Run after `vite build`, before deploying.
set -euo pipefail
cd "$(dirname "$0")/.."
DIST="${SPOT_DIST_DIR:-apps/web/dist}"
mkdir -p "$DIST/dl"
SHA=$(git rev-parse --short HEAD)
TMP=$(mktemp -d)
if [[ "${SPOT_BUILD_WORKTREE:-0}" == 1 ]]; then
  # Testing only: pack the working tree (uncommitted changes included) and mark the version, so a server never
  # mistakes it for a release. Real releases come from the commit below.
  SHA="$SHA-dev"
  git ls-files -co --exclude-standard | grep -v '^\.claude/' | while IFS= read -r f; do [ -e "$f" ] && printf '%s\n' "$f"; done | tar -cf - -T - | tar -x -C "$TMP"
else
  git archive HEAD | tar -x -C "$TMP"
fi
echo "$SHA" > "$TMP/VERSION"
tar -czf "$DIST/dl/spot-solutions.tar.gz" -C "$TMP" .
# What servers check for updates (docs/multi-server.md, "Updates"): the version, when it was built, the tarball's
# sha256 (servers refuse a download that doesn't match) and the default local model.
TGZ_SHA=$( (sha256sum "$DIST/dl/spot-solutions.tar.gz" 2>/dev/null || shasum -a 256 "$DIST/dl/spot-solutions.tar.gz") | cut -d' ' -f1)
TGZ_SIZE=$(wc -c < "$DIST/dl/spot-solutions.tar.gz" | tr -d ' ')
printf '{"version":"%s","builtAt":%s,"sha256":"%s","size":%s,"model":"%s"}\n' "$SHA" "$(node -e 'console.log(Date.now())')" "$TGZ_SHA" "$TGZ_SIZE" "${GEMMA_MODEL:-gemma3:4b}" > "$DIST/dl/version.json"
cp deploy/install.sh "$DIST/install.sh"
# Admin helpers for per-device Firebase keys (need gcloud; contain no secrets).
cp deploy/new-server-key.sh "$DIST/new-server-key.sh"
cp deploy/revoke-server-key.sh "$DIST/revoke-server-key.sh"
cp deploy/windows/install.ps1 "$DIST/install.ps1"
(cd deploy && rm -f "$TMP/w.zip" && cp -R windows "$TMP/SpotSolutions-Windows" && cd "$TMP" && zip -qr w.zip SpotSolutions-Windows)
mv "$TMP/w.zip" "$DIST/dl/SpotSolutions-Windows.zip"
# macOS app: build it if this machine can (needs Xcode command-line tools), then publish.
# (Firebase's free plan won't host .dmg files, so the app ships as a zip.)
if command -v swiftc >/dev/null; then
  deploy/mac/build.sh "$TMP/mac" >/dev/null 2>&1
  ditto -c -k --keepParent "$TMP/mac/Spot Server.app" "$DIST/dl/SpotServer-mac.zip"
fi
cp deploy/mac/install-mac.sh "$DIST/install-mac.sh"
rm -rf "$TMP"
echo "dist: dl/version.json, install.sh, install.ps1, dl/spot-solutions.tar.gz ($SHA), dl/SpotSolutions-Windows.zip, dl/SpotServer-mac.zip, install-mac.sh, new-server-key.sh, revoke-server-key.sh"
