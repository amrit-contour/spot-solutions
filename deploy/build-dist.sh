#!/usr/bin/env bash
# Adds the installers and a source tarball to the web build, so servers install from
# nothingbotcurating.web.app with no GitHub dependency. Run after `vite build`, before deploying.
#
# Two sets of files land in dl/, and they never share a name:
#   NEW  (Nothing BOT Server):  dl/nothing-bot-server.json, dl/nothing-bot-server.tar.gz, dl/NothingBotServer-Windows.zip,
#                               dl/NothingBotServer-mac.zip, plus install.sh, install.ps1, install-mac.sh, uninstall.sh at the root.
#   LEGACY (frozen at 3c43570): dl/version.json, dl/spot-solutions.tar.gz, dl/SpotSolutions-Windows.zip, dl/SpotServer-mac.zip,
#                               copied unchanged from deploy/legacy-dl/ (gitignored). Servers installed before the rename
#                               poll /dl/version.json and download /dl/spot-solutions.tar.gz; they must never be offered the
#                               renamed release (it would run against their old folders and services). See docs/migrate-to-nothing-bot-server.md.
# Every hosting site serves apps/web/dist, so both sets are served from all of them.
set -euo pipefail
# Settings from before the rename to Nothing BOT Server were called SPOT_*; keep honouring them.
for _v in $(compgen -v SPOT_ || true); do _n="NBS_${_v#SPOT_}"; [[ -n "${!_n+x}" ]] || export "$_n=${!_v}"; done
cd "$(dirname "$0")/.."
DIST="${NBS_DIST_DIR:-apps/web/dist}"
LEGACY_DIR="deploy/legacy-dl"
LEGACY_FILES=(version.json spot-solutions.tar.gz SpotSolutions-Windows.zip SpotServer-mac.zip)

# Fail loudly (before building anything) if the frozen files are missing: without them old servers would 404 or,
# worse, be handed the new release.
missing=()
for f in "${LEGACY_FILES[@]}"; do [[ -s "$LEGACY_DIR/$f" ]] || missing+=("$f"); done
if (( ${#missing[@]} )); then
  echo "ERROR: $LEGACY_DIR is missing: ${missing[*]}" >&2
  echo "These are the frozen files for servers installed before the rename (release 3c43570). Download them again with:" >&2
  echo "  mkdir -p $LEGACY_DIR && cd $LEGACY_DIR && for f in version.json spot-solutions.tar.gz SpotSolutions-Windows.zip SpotServer-mac.zip; do curl -fsSLO https://spot-solutions.web.app/dl/\$f; done" >&2
  echo "(only while the live site still serves the frozen versions; otherwise restore them from a backup)." >&2
  exit 1
fi
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!/^[0-9a-f]{7,40}$/.test(j.version)||!/^[0-9a-f]{64}$/.test(j.sha256)) process.exit(1)' "$LEGACY_DIR/version.json" \
  || { echo "ERROR: $LEGACY_DIR/version.json is not a valid release file." >&2; exit 1; }
LEGACY_SHA=$( (sha256sum "$LEGACY_DIR/spot-solutions.tar.gz" 2>/dev/null || shasum -a 256 "$LEGACY_DIR/spot-solutions.tar.gz") | cut -d' ' -f1)
WANT_SHA=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sha256)' "$LEGACY_DIR/version.json")
[[ "$LEGACY_SHA" == "$WANT_SHA" ]] || { echo "ERROR: $LEGACY_DIR/spot-solutions.tar.gz doesn't match the sha256 in $LEGACY_DIR/version.json (old servers would refuse it)." >&2; exit 1; }

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
# Admin helpers for per-device Firebase keys (need gcloud; contain no secrets).
cp deploy/new-server-key.sh "$DIST/new-server-key.sh"
cp deploy/revoke-server-key.sh "$DIST/revoke-server-key.sh"
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

# The frozen legacy files, byte for byte, every build.
for f in "${LEGACY_FILES[@]}"; do cp "$LEGACY_DIR/$f" "$DIST/dl/$f"; done

echo "dist (new):    dl/nothing-bot-server.json ($SHA), dl/nothing-bot-server.tar.gz, dl/NothingBotServer-Windows.zip, dl/NothingBotServer-mac.zip, install.sh, install.ps1, install-mac.sh, uninstall.sh, uninstall.ps1, migrate-mac.sh, restore-backup.sh, new-server-key.sh, revoke-server-key.sh"
echo "dist (legacy): dl/version.json, dl/spot-solutions.tar.gz, dl/SpotSolutions-Windows.zip, dl/SpotServer-mac.zip (frozen at $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$LEGACY_DIR/version.json"))"
