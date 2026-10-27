#!/usr/bin/env bash
# Adds the installers and a source tarball to the web build, so servers install from
# nothingbotcurating.web.app with no GitHub dependency. Run after `vite build`, before deploying.
#
# Files in dl/: nothing-bot-server.json, nothing-bot-server.tar.gz, NothingBotServer-Windows.zip, NothingBotServer-mac.zip,
# plus install.sh, install.ps1, install-mac.sh, uninstall.sh at the root (never the admin key scripts). Every hosting site but
# spot-solutions.web.app serves apps/web/dist. The frozen pre-rename release (dl/version.json, spot-solutions.tar.gz, …) was
# shut down on 27 Oct 2026, once the last old server was reinstalled.
set -euo pipefail
# Settings from before the rename to Nothing BOT Server were called SPOT_*; keep honouring them.
for _v in $(compgen -v SPOT_ || true); do _n="NBS_${_v#SPOT_}"; [[ -n "${!_n+x}" ]] || export "$_n=${!_v}"; done
cd "$(dirname "$0")/.."
DIST="${NBS_DIST_DIR:-apps/web/dist}"

mkdir -p "$DIST/dl"
SHA=$(git rev-parse --short HEAD)
TMP=$(mktemp -d)
if [[ "${NBS_BUILD_WORKTREE:-0}" == 1 ]]; then
  # Testing only: pack the working tree (uncommitted changes included) and mark the version, so a server never
  # mistakes it for a release. Real releases come from the commit below.
  SHA="$SHA-dev"
  git ls-files -co --exclude-standard | grep -v '^\.claude/' | while IFS= read -r f; do [ -e "$f" ] && printf '%s\n' "$f"; done | tar -cf - -T - | tar -x -C "$TMP"
else
  git archive HEAD | tar -x -C "$TMP"
fi
echo "$SHA" > "$TMP/VERSION"
tar -czf "$DIST/dl/nothing-bot-server.tar.gz" -C "$TMP" .
# What servers check for updates (docs/multi-server.md, "Updates"): the version, when it was built, the tarball's
# sha256 (servers refuse a download that doesn't match) and the default local model.
TGZ_SHA=$( (sha256sum "$DIST/dl/nothing-bot-server.tar.gz" 2>/dev/null || shasum -a 256 "$DIST/dl/nothing-bot-server.tar.gz") | cut -d' ' -f1)
TGZ_SIZE=$(wc -c < "$DIST/dl/nothing-bot-server.tar.gz" | tr -d ' ')
printf '{"version":"%s","builtAt":%s,"sha256":"%s","size":%s,"model":"%s"}\n' "$SHA" "$(node -e 'console.log(Date.now())')" "$TGZ_SHA" "$TGZ_SIZE" "${GEMMA_MODEL:-gemma3:4b}" > "$DIST/dl/nothing-bot-server.json"
# One entry point for every install address, old (spot-solutions.web.app/install.sh) or new: they all serve the new
# installers, so a fresh install always gets the new layout. Servers already installed never re-run an installer.
cp deploy/install.sh "$DIST/install.sh"
cp deploy/ubuntu/uninstall.sh "$DIST/uninstall.sh"
# Migration helpers (docs/migrate-to-nothing-bot-server.md): run on the owner's Mac, no secrets inside.
cp deploy/migrate/migrate-mac.sh "$DIST/migrate-mac.sh"
cp deploy/migrate/restore-backup.sh "$DIST/restore-backup.sh"
# new-server-key.sh / revoke-server-key.sh are admin tools (they spell out the project, bucket and IAM layout): they are
# NOT hosted. Run them from a checkout of the repo (docs/multi-server.md). Remove any copy an earlier build left behind.
rm -f "$DIST/new-server-key.sh" "$DIST/revoke-server-key.sh"
cp deploy/windows/install.ps1 "$DIST/install.ps1"
cp deploy/windows/uninstall.ps1 "$DIST/uninstall.ps1"
(cd deploy && rm -f "$TMP/w.zip" && cp -R windows "$TMP/NothingBotServer-Windows" && cd "$TMP" && zip -qr w.zip NothingBotServer-Windows)
mv "$TMP/w.zip" "$DIST/dl/NothingBotServer-Windows.zip"
# macOS app: build it if this machine can (needs Xcode command-line tools), then publish.
# (Firebase's free plan won't host .dmg files, so the app ships as a zip.)
if command -v swiftc >/dev/null; then
  deploy/mac/build.sh "$TMP/mac" >/dev/null 2>&1
  ditto -c -k --keepParent "$TMP/mac/Nothing BOT Server.app" "$DIST/dl/NothingBotServer-mac.zip"
fi
cp deploy/mac/install-mac.sh "$DIST/install-mac.sh"
rm -rf "$TMP"

# spot-solutions.web.app is retired (hosting target `curating`): its own public dir, apps/web/dist-retired, with only a page
# that clears the old PWA and forwards to nothingbotcurating.web.app (and a self-unregistering sw.js). No downloads.
RETIRED="${NBS_RETIRED_DIR:-apps/web/dist-retired}"
rm -rf "$RETIRED"
mkdir -p "$RETIRED"
cp deploy/retired/index.html deploy/retired/sw.js "$RETIRED/"

echo "dist (new):    dl/nothing-bot-server.json ($SHA), dl/nothing-bot-server.tar.gz, dl/NothingBotServer-Windows.zip, dl/NothingBotServer-mac.zip, install.sh, install.ps1, install-mac.sh, uninstall.sh, uninstall.ps1, migrate-mac.sh, restore-backup.sh"
echo "retired:       spot-solutions.web.app serves only the forwarding page"
