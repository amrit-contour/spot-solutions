#!/usr/bin/env bash
# Nothing BOT Server: restore the local backup made by migrate-mac.sh into a new Mac install.
# A safety net: a new server that joins the same account normally restores the WhatsApp login from the cloud vault by
# itself, with no QR code. Use this only if it asks for a QR code, or says the restore failed.
#
#   bash restore-backup.sh [backup.tar.gz] [--data-dir DIR] [--force]
#
# With no file it uses the newest ~/NothingBotServer-backup-*.tar.gz. It stops the server first, moves anything already
# in the new data folder aside (never deletes it), puts the saved logins back, and tells you how to start the server.
# --data-dir DIR  restore into DIR instead of the new install's data folder (a Mac with the data on another drive, or Linux)
# --force         restore even if the backup was made when the vault check had not passed
set -uo pipefail

BK=""; DATA_OVERRIDE=""; FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir) shift; DATA_OVERRIDE="${1:-}" ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $1"; exit 2 ;;
    *) BK="$1" ;;
  esac
  shift
done
# Test hook: NBS_MIGRATE_DRY_RUN=1 never touches launch agents or processes.
if [[ -n "${NBS_MIGRATE_DRY_RUN:-}" ]]; then launchctl() { echo "(skip) launchctl $*"; return 1; }; pgrep() { return 1; }; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '  OK    %s\n' "$*"; }
bad()  { printf '  STOP  %s\n' "$*"; }

if [[ -z "$BK" ]]; then BK="$(ls -t "$HOME"/NothingBotServer-backup-*.tar.gz 2>/dev/null | head -n1 || true)"; fi
[[ -n "$BK" && -f "$BK" ]] || { say "No backup file found. Pass the path: bash restore-backup.sh ~/NothingBotServer-backup-YYYY-MM-DD.tar.gz"; exit 1; }
say "Backup: $BK"

# 1. the file is intact
if [[ -f "$BK.sha256" ]]; then
  want="$(cut -d' ' -f1 "$BK.sha256")"; got="$(shasum -a 256 "$BK" | cut -d' ' -f1)"
  [[ "$want" == "$got" ]] || { bad "The backup doesn't match its checksum file. It may be damaged."; exit 1; }
  ok "Checksum matches."
fi
tar -tzf "$BK" >/dev/null 2>&1 || { bad "The backup can't be read."; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
( umask 077; tar -xzf "$BK" -C "$WORK" ) || { bad "Couldn't unpack the backup."; exit 1; }
SRC="$WORK/nbs-backup"
[[ -d "$SRC/wwebjs" ]] || { bad "This isn't a Nothing BOT Server backup (no wwebjs folder)."; exit 1; }
grep -E "^(made|from|logins|vault ok):" "$SRC/MANIFEST.txt" 2>/dev/null | sed "s/^/  /"
if grep -q '^vault ok:    NO' "$SRC/MANIFEST.txt" 2>/dev/null && [[ $FORCE == 0 ]]; then
  say "  This backup was taken while the vault check had not passed. Run again with --force if you still want it."; exit 1
fi

# 2. where the new install keeps its data
ROOT="$HOME/Library/Application Support/NothingBotServer"
if [[ -n "$DATA_OVERRIDE" ]]; then DATA="$DATA_OVERRIDE"
else
  [[ -d "$ROOT/app" ]] || { bad "Nothing BOT Server isn't installed on this Mac yet (no $ROOT/app). Install it first, then run this."; exit 1; }
  DATA="$(head -n1 "$ROOT/data-dir" 2>/dev/null || true)"; [[ -n "$DATA" ]] || DATA="$ROOT/data"
fi
say "Restoring into: $DATA"

# 3. stop the server so nothing writes while the files are swapped
if [[ -z "$DATA_OVERRIDE" ]]; then
  UID_N="$(id -u)"
  for l in app.nothingbot.server.worker app.nothingbot.server.console; do launchctl bootout "gui/$UID_N/$l" 2>/dev/null || true; done
  n=0; while pgrep -f "apps/worker/node_modules/tsx/dist/cli.mjs" >/dev/null 2>&1 && [[ $n -lt 60 ]]; do sleep 2; n=$((n + 1)); done
  pgrep -f "apps/worker/node_modules/tsx/dist/cli.mjs" >/dev/null 2>&1 && { bad "The worker is still running. Stop it, then run this again."; exit 1; }
  ok "Server stopped."
fi

# 4. put the files back (what was there is moved aside, not deleted)
ASIDE="$DATA/.before-restore-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DATA/wwebjs" "$ASIDE"
shopt -s nullglob
for d in "$DATA"/wwebjs/session-* "$DATA"/wwebjs/vault-*.json "$DATA"/wwebjs/server.json "$DATA/console.json"; do
  [[ -e "$d" ]] && mkdir -p "$ASIDE/$(dirname "${d#$DATA/}")" && mv "$d" "$ASIDE/${d#$DATA/}"
done
for d in "$SRC"/wwebjs/*; do cp -R "$d" "$DATA/wwebjs/"; done
[[ -f "$SRC/console/console.json" ]] && cp "$SRC/console/console.json" "$DATA/console.json"
shopt -u nullglob
chmod -R go-rwx "$DATA/wwebjs" 2>/dev/null; chmod 700 "$DATA" 2>/dev/null
rmdir "$ASIDE" 2>/dev/null && say "  Nothing was in the way." || say "  What was there before is in $ASIDE (delete it once all is well)."
ok "Restored $(ls -d "$DATA"/wwebjs/session-* 2>/dev/null | wc -l | tr -d ' ') login folder(s)."

# 5. settings: add what the new .env doesn't have yet (never overwrites; Firebase and path lines were left out of the backup)
ENVF="$ROOT/app/apps/worker/.env"
if [[ -z "$DATA_OVERRIDE" && -f "$SRC/console/worker.env" && -f "$ENVF" ]]; then
  added=0
  while IFS= read -r line; do
    [[ "$line" == *=* && "$line" != \#* ]] || continue
    k="${line%%=*}"; v="${line#*=}"
    case "$k" in SPOT_*) k="NBS_${k#SPOT_}" ;; esac
    case "$k" in GEMINI_API_KEY|NBS_ADMIN_EMAILS|NBS_AI_MODE|NBS_LOCAL_MODEL|NBS_GEMINI_MODEL|NBS_MAX_CURATORS|NBS_MAX_ACCOUNTS) ;; *) continue ;; esac
    [[ -n "$v" ]] || continue
    if ! grep -qE "^$k=.+" "$ENVF"; then
      { grep -v "^$k=" "$ENVF" || true; echo "$k=$v"; } > "$ENVF.tmp" && mv "$ENVF.tmp" "$ENVF" && chmod 600 "$ENVF"; added=$((added + 1)); say "  added setting $k"
    fi
  done < "$SRC/console/worker.env"
  [[ $added == 0 ]] && say "  Settings: nothing to add."
fi

cat <<EOF

Done. Start the server again:
  open the Nothing BOT Server app and press Start server,
  or:  "/Applications/Nothing BOT Server.app/Contents/Resources/nbsctl" start
The worker uses this local copy if it is at least as new as the vault, and uploads it to the vault within a minute of
WhatsApp being ready. If the app still shows a QR code, the saved login has expired on WhatsApp's side: scan once.
EOF
