#!/usr/bin/env bash
# Nothing BOT Server: safe move off the old "Spot Solutions" server, run on the Mac that hosts your WhatsApp login.
#
#   bash deploy/migrate/migrate-mac.sh                 (from a checkout)
#   curl -fsSL https://nothingbotcurating.web.app/migrate-mac.sh | bash
#
# It changes nothing permanent. It stops the server cleanly (which uploads the login to the cloud vault), checks the
# upload, saves a local backup, and then tells you what to run next. Nothing is uninstalled or deleted here.
#
#   1  confirm this Mac holds the account's WhatsApp lease
#   2  stop the server cleanly (a clean stop always uploads a fresh login copy to the vault)
#   3  wait for, and verify, a vault upload newer than the start of this run (account and agent number)
#   4  back the data up to ~/NothingBotServer-backup-<date>.tar.gz
#   5  print the uninstall steps and the new install commands
#
# Options:  --restart-after   start the server again at the end (use it if you aren't moving yet)
#           --include-key     also put this server's Firebase key in the backup (off by default: the new server makes its own)
#           --timeout SECONDS how long to wait for the vault upload (default 240)
#           --yes             don't ask "continue?" questions (the manual confirmation in step 1 is still asked if needed)
# Restoring the backup on the new Mac install: restore-backup.sh (same folder).
set -uo pipefail

RESTART_AFTER=0; INCLUDE_KEY=0; TIMEOUT=240; ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart-after) RESTART_AFTER=1 ;;
    --include-key) INCLUDE_KEY=1 ;;
    --timeout) shift; TIMEOUT="${1:-240}" ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
  shift
done

# Test hook: NBS_MIGRATE_DRY_RUN=1 never touches launch agents or processes.
if [[ -n "${NBS_MIGRATE_DRY_RUN:-}" ]]; then launchctl() { echo "(skip) launchctl $*"; return 1; }; pgrep() { return 1; }; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n== Step %s ==\n' "$*"; }
ok()   { printf '  OK    %s\n' "$*"; }
warn() { printf '  NOTE  %s\n' "$*"; }
bad()  { printf '  STOP  %s\n' "$*"; }
ask()  { # ask "question" : y/N, from the terminal
  [[ "$ASSUME_YES" == 1 ]] && return 0
  local a; printf '  %s [y/N] ' "$1"; read -r a </dev/tty 2>/dev/null || return 1; [[ "$a" =~ ^[Yy] ]]
}

[[ "$(uname -s)" == Darwin ]] || { say "This script is for the Mac. On Windows or Ubuntu, see docs/migrate-to-nothing-bot-server.md."; exit 2; }
UID_N="$(id -u)"
SUPPORT="$HOME/Library/Application Support"

# ---------------------------------------------------------------- where is the server?
ROOT=""; PREFIX=""; KIND=""
if [[ -f "$SUPPORT/NothingBotServer/app/apps/worker/package.json" ]]; then ROOT="$SUPPORT/NothingBotServer"; PREFIX="app.nothingbot.server"; KIND="Nothing BOT Server"
elif [[ -f "$SUPPORT/SpotSolutions/app/apps/worker/package.json" ]]; then ROOT="$SUPPORT/SpotSolutions"; PREFIX="com.spotsolutions"; KIND="the old Spot Solutions server"
fi
if [[ -z "$ROOT" ]]; then say "Couldn't find a server on this Mac (looked in $SUPPORT/NothingBotServer and $SUPPORT/SpotSolutions)."; say "Nothing to migrate here. If it runs on another computer, run this there, or see docs/migrate-to-nothing-bot-server.md."; exit 1; fi
APP="$ROOT/app"
DATA="$(head -n1 "$ROOT/data-dir" 2>/dev/null || true)"; [[ -n "$DATA" ]] || DATA="$ROOT/data"
WW="$DATA/wwebjs"
NODE="$ROOT/runtime/node/bin/node"; [[ -x "$NODE" ]] || NODE="$(command -v node || true)"
ENVF="$APP/apps/worker/.env"
KEYF="$DATA/service-account.json"
LABELS=("$PREFIX.worker" "$PREFIX.console" "$PREFIX.ollama")
TS="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

say "Nothing BOT Server migration (Mac)"
say "  Found $KIND"
say "  Program folder: $APP"
say "  Data folder:    $DATA"
[[ -d "$WW" ]] || { say "  There is no WhatsApp data in $WW. Nothing to migrate."; exit 1; }
ls -d "$WW"/session-* >/dev/null 2>&1 || { say "  No WhatsApp login (session-*) in $WW. Nothing to migrate."; exit 1; }
say "  WhatsApp logins here: $(ls -d "$WW"/session-* | wc -l | tr -d ' ')"

worker_running() { launchctl print "gui/$UID_N/$PREFIX.worker" 2>/dev/null | grep -q "state = running"; }
worker_pid() { pgrep -f "apps/worker/node_modules/tsx/dist/cli.mjs" 2>/dev/null | head -n1; }

# ---------------------------------------------------------------- the helper that talks to Firestore (same key the worker uses)
cat > "$WORK/check.mjs" <<'NODE'
// Reads the account leases and vault meta with this server's own key, the same way the worker does. Read only.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [, , cmd, ...args] = process.argv;
const { MIG_APP, MIG_DATA, MIG_KEY, MIG_PROJECT, MIG_STATE, MIG_PORT } = process.env;
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const out = (s) => console.log(s);
const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`);
const state = () => { try { return JSON.parse(fs.readFileSync(MIG_STATE, "utf8")); } catch { return {}; } };
const save = (s) => fs.writeFileSync(MIG_STATE, JSON.stringify(s));

const ids = fs.readdirSync(path.join(MIG_DATA, "wwebjs")).filter((f) => f.startsWith("session-")).map((f) => f.slice(8));
const uids = [...new Set(ids.map((i) => i.replace(/_agent$/, "")))];
const hasAgentDir = (uid) => ids.includes(`${uid}_agent`);

let db;
try {
  const req = createRequire(path.join(MIG_APP, "apps", "worker", "package.json"));
  const { cert, initializeApp } = req("firebase-admin/app");
  const { getFirestore } = req("firebase-admin/firestore");
  const key = JSON.parse(fs.readFileSync(MIG_KEY, "utf8"));
  initializeApp({ credential: cert(key), projectId: MIG_PROJECT || key.project_id });
  db = getFirestore();
} catch (e) {
  out(`CANNOT_CHECK ${e.message}`);
  process.exit(2);
}

async function serverId() {
  try {
    const r = await fetch(`http://127.0.0.1:${MIG_PORT || 7420}/api/live`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    if (j?.live?.server?.id) return j.live.server.id;
  } catch { /* console not running */ }
  try { const j = JSON.parse(fs.readFileSync(path.join(MIG_DATA, "wwebjs", "server.json"), "utf8")); if (j.id) return j.id; } catch { /* no id yet */ }
  return os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
const fleetDoc = (uid, name) => db.collection("users").doc(uid).collection("fleet").doc(name).get();
const meta = (d) => (d.exists ? { gen: d.data().gen ?? 0, savedAt: d.data().savedAt ?? 0, wiped: !!d.data().wiped, server: d.data().server ?? null } : null);

try {
  if (cmd === "leases") {
    const me = process.env.MIG_SERVER || (await serverId());
    out(`This server's id: ${me}`);
    const held = [], others = [];
    for (const uid of uids) {
      const d = await fleetDoc(uid, "lease");
      const l = d.exists ? d.data() : null;
      if (!l) { out(`  ${uid}: no lease record (never hosted through the fleet)`); others.push(uid); continue; }
      const age = Date.now() - (l.renewedAt ?? 0);
      if (l.server === me && l.state === "running") { out(`  ${uid}: held by THIS server, running, renewed ${ago(age)}`); held.push(uid); }
      else if (l.server === me) { out(`  ${uid}: held by this server but state is "${l.state}"`); held.push(uid); }
      else { out(`  ${uid}: ${l.server ? `held by ANOTHER server "${l.server}"` : "released (nobody holds it)"}, state ${l.state}, renewed ${ago(age)}`); others.push(uid); }
    }
    save({ me, held, others, since: Date.now() });
    process.exit(held.length && !others.length ? 0 : 1);
  }
  if (cmd === "snapshot") {
    const st = state(); const snap = {};
    for (const uid of st.held ?? []) {
      snap[uid] = { vault: meta(await fleetDoc(uid, "vault")), agent: meta(await fleetDoc(uid, "vault_agent")), agentDir: hasAgentDir(uid) };
      out(`  ${uid}: vault gen ${snap[uid].vault?.gen ?? "none"}${snap[uid].vault ? `, saved ${ago(Date.now() - snap[uid].vault.savedAt)}` : ""}${snap[uid].agent ? `; agent vault gen ${snap[uid].agent.gen}` : snap[uid].agentDir ? "; agent login present but no agent vault yet" : ""}`);
    }
    save({ ...st, snap });
    process.exit(0);
  }
  if (cmd === "verify") {
    const st = state(); const since = Number(flag("--since", "0")); const deadline = Date.now() + Number(flag("--timeout", "240")) * 1000;
    const pending = new Set();
    for (const uid of st.held ?? []) { pending.add(`${uid}:vault`); if (st.snap?.[uid]?.agent || st.snap?.[uid]?.agentDir) pending.add(`${uid}:agent`); }
    let failed = [];
    while (true) {
      failed = [];
      for (const k of [...pending]) {
        const [uid, which] = k.split(":");
        const m = meta(await fleetDoc(uid, which === "agent" ? "vault_agent" : "vault"));
        const before = st.snap?.[uid]?.[which === "agent" ? "agent" : "vault"];
        if (m && (m.wiped || (m.savedAt >= since && m.gen > (before?.gen ?? 0)))) {
          out(`  ${uid} ${which === "agent" ? "agent number" : "login"}: OK, vault gen ${m.gen}${before ? ` (was ${before.gen})` : ""}, saved ${ago(Date.now() - m.savedAt)}${m.wiped ? " (logged out)" : ""}`);
          pending.delete(k);
        } else failed.push(`${uid} ${which}: still gen ${m?.gen ?? "none"}, saved ${m ? ago(Date.now() - m.savedAt) : "never"}`);
      }
      if (!pending.size) process.exit(0);
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    for (const f of failed) out(`  NOT NEWER: ${f}`);
    process.exit(1);
  }
  out("usage: check.mjs leases|snapshot|verify");
  process.exit(2);
} catch (e) {
  out(`CANNOT_CHECK ${e.message}`);
  process.exit(2);
}
NODE

export MIG_APP="$APP" MIG_DATA="$DATA" MIG_KEY="$KEYF" MIG_STATE="$WORK/state.json" MIG_PORT="${NBS_CONSOLE_PORT:-${SPOT_CONSOLE_PORT:-7420}}"
MIG_PROJECT="$(grep -E '^FIREBASE_PROJECT_ID=' "$ENVF" 2>/dev/null | tail -1 | cut -d= -f2-)"; export MIG_PROJECT
MIG_SERVER="$(grep -E '^(NBS|SPOT)_SERVER_ID=' "$ENVF" 2>/dev/null | tail -1 | cut -d= -f2-)"; [[ -n "$MIG_SERVER" ]] && export MIG_SERVER
CAN_CHECK=1
[[ -n "$NODE" && -f "$KEYF" && -d "$APP/apps/worker/node_modules/firebase-admin" ]] || CAN_CHECK=0

# ---------------------------------------------------------------- 1. the lease
step "1 of 5: does this Mac hold your account?"
HELD_OK=0
if [[ $CAN_CHECK == 1 ]]; then
  "$NODE" "$WORK/check.mjs" leases; rc=$?
  if [[ $rc == 0 ]]; then ok "This Mac holds every account it has a login for."; HELD_OK=1
  elif [[ $rc == 1 ]]; then
    bad "At least one account is not held by this Mac (see above)."
    say "  Another server may hold the newest login. Migrate from that server instead, or stop it first."
    ask "Continue anyway (only if you are sure this Mac has the newest login)?" || { say "Stopped. Nothing was changed."; exit 1; }
  else warn "Couldn't read the cloud records (see the message above)."; CAN_CHECK=0; fi
else
  warn "Can't check the cloud records from here (no key or program files found)."
fi
if [[ $CAN_CHECK == 0 ]]; then
  say "  Please check in the app yourself: open the Nothing BOT Curate app, Account, Server."
  say "  This Mac should be listed as the server hosting your WhatsApp (Fleet shows who holds each account)."
  ask "Does the app show THIS Mac as the one hosting your account?" || { say "Stopped. Nothing was changed."; exit 1; }
  HELD_OK=1
fi
if ! worker_running; then warn "The worker isn't running right now. If it was stopped long ago, the cloud copy may be old; step 3 will tell."; fi

# ---------------------------------------------------------------- 2. clean stop = fresh upload
step "2 of 5: stop the server cleanly (this uploads a fresh login copy)"
if [[ $CAN_CHECK == 1 ]]; then say "  Vault state before:"; "$NODE" "$WORK/check.mjs" snapshot || true; fi
START_MS="$(( $(date +%s) * 1000 ))"
say "  Stopping the worker. It closes WhatsApp, uploads each login to the vault and hands the account back. This can take a minute or two."
for l in "${LABELS[@]}"; do launchctl bootout "gui/$UID_N/$l" 2>/dev/null || true; done
n=0; while [[ -n "$(worker_pid)" && $n -lt 120 ]]; do printf '.'; sleep 2; n=$((n + 1)); done; echo
if [[ -n "$(worker_pid)" ]]; then bad "The worker is still running after 4 minutes. Not safe to copy its files."; say "  Quit it with: pkill -TERM -f 'apps/worker/node_modules/tsx'  (wait a minute), then run this script again."; exit 1; fi
ok "Server stopped."
say "  (Nothing will restart it: its launch agents are unloaded until you start it or log in again.)"

# ---------------------------------------------------------------- 3. verify the vault
step "3 of 5: check the cloud copy is newer than the start of this run"
VAULT_OK=0
if [[ $CAN_CHECK == 1 && $HELD_OK == 1 ]]; then
  "$NODE" "$WORK/check.mjs" verify --since "$START_MS" --timeout "$TIMEOUT"; rc=$?
  if [[ $rc == 0 ]]; then VAULT_OK=1; ok "The vault has a fresh copy of every login."
  else bad "The vault does NOT have a fresh copy for everything listed above."; fi
else
  say "  Can't check automatically. Open the Nothing BOT Curate app, Settings, WhatsApp: it should say \"Login backed up\" with a time a minute ago."
  ask "Does it say the login was backed up just now?" && VAULT_OK=1
fi
[[ $VAULT_OK == 1 ]] || { say ""; say "  Do NOT uninstall yet. The backup in the next step is your safety net. Start the server again"; say "  (open the app and press Start server) and run this script once more."; }

# ---------------------------------------------------------------- 4. local backup
step "4 of 5: local backup"
BK="$HOME/NothingBotServer-backup-$(date +%Y-%m-%d).tar.gz"
[[ -e "$BK" ]] && BK="$HOME/NothingBotServer-backup-$(date +%Y-%m-%d-%H%M).tar.gz"
STAGE="$WORK/stage/nbs-backup"; mkdir -p "$STAGE/wwebjs" "$STAGE/console"
shopt -s nullglob
n=0
for d in "$WW"/session-*; do
  mkdir -p "$STAGE/wwebjs/$(basename "$d")"
  # Chromium's caches are rebuilt on start; the login lives in IndexedDB and Local Storage, which are kept.
  tar -C "$d" --exclude='Cache' --exclude='Code Cache' --exclude='GPUCache' --exclude='DawnCache' --exclude='ShaderCache' --exclude='GrShaderCache' --exclude='Crashpad' -cf - . | tar -C "$STAGE/wwebjs/$(basename "$d")" -xf -
  n=$((n + 1))
done
for f in "$WW"/vault-*.json "$WW"/server.json; do [[ -f "$f" ]] && cp "$f" "$STAGE/wwebjs/"; done
[[ -f "$DATA/console.json" ]] && cp "$DATA/console.json" "$STAGE/console/console.json"
[[ -f "$ENVF" ]] && grep -vE '^(FIREBASE_SERVICE_ACCOUNT|WWEBJS_DATA)=' "$ENVF" > "$STAGE/console/worker.env"
if [[ $INCLUDE_KEY == 1 && -f "$KEYF" ]]; then cp "$KEYF" "$STAGE/console/service-account.json"; warn "The Firebase key is in the backup (--include-key). Keep the file private."; fi
{
  echo "Nothing BOT Server backup"
  echo "made:        $(date)"
  echo "from:        $KIND ($ROOT)"
  echo "data folder: $DATA"
  echo "logins:      $n session folder(s)"
  echo "vault ok:    $([[ $VAULT_OK == 1 ]] && echo yes || echo NO)"
  echo "contains:    wwebjs/session-*, wwebjs/vault-*.json, wwebjs/server.json, console/console.json, console/worker.env (settings; Firebase and path lines removed)"
} > "$STAGE/MANIFEST.txt"
shopt -u nullglob
( umask 077; tar -C "$WORK/stage" -czf "$BK" nbs-backup ) || { bad "Couldn't write the backup to $BK"; exit 1; }
chmod 600 "$BK"
if tar -tzf "$BK" >/dev/null 2>&1; then
  SHA="$( (shasum -a 256 "$BK") | cut -d' ' -f1)"; echo "$SHA  $(basename "$BK")" > "$BK.sha256"
  ok "Backup written and checked: $BK ($(du -h "$BK" | cut -f1), $(tar -tzf "$BK" | wc -l | tr -d ' ') files)"
  say "  sha256: $SHA"
  say "  It holds your WhatsApp login. Keep it private; delete it once the new server has been running fine for a few days."
else
  bad "The backup file didn't read back correctly. Don't uninstall. Try again."; exit 1
fi

if [[ $RESTART_AFTER == 1 ]]; then
  say ""; say "  --restart-after: starting the server again."
  for l in "${LABELS[@]}"; do [[ -f "$HOME/Library/LaunchAgents/$l.plist" ]] && { launchctl bootstrap "gui/$UID_N" "$HOME/Library/LaunchAgents/$l.plist" 2>/dev/null || true; launchctl kickstart "gui/$UID_N/$l" 2>/dev/null || true; }; done
fi

# ---------------------------------------------------------------- 5. what to do next
step "5 of 5: next steps"
cat <<EOF
$( [[ $VAULT_OK == 1 ]] && echo "  Everything checked out. You can move to Nothing BOT Server now." || echo "  The vault check did not pass, so do not uninstall yet (see step 3).")

 A. Uninstall the old server (your data is kept unless you choose otherwise)
    This Mac:     install the new one (below). It stops and removes the old Spot Server by itself.
                  To remove it without installing: open "Spot Server", More, Uninstall,
                  or:  "/Applications/Spot Server.app/Contents/Resources/spotctl" uninstall
    Windows PC:   irm https://nothingbotcurating.web.app/uninstall.ps1 | iex           (run in PowerShell as Administrator)
    Ubuntu:       curl -fsSL https://nothingbotcurating.web.app/uninstall.sh | sudo bash
                  Each keeps its data folder and says where it is. Add -DeleteData (Windows) or --delete-data (Ubuntu)
                  only after the new server works.

 B. Install Nothing BOT Server
    Mac:          curl -fsSL https://nothingbotcurating.web.app/install.sh | bash
    Ubuntu:       curl -fsSL https://nothingbotcurating.web.app/install.sh | sudo bash
    Windows:      Set-ExecutionPolicy -Scope Process Bypass -Force; irm https://nothingbotcurating.web.app/install.ps1 | iex

 C. Connect it to the same account
    In its console click "Connect with Nothing BOT Curate", sign in as an admin and approve. The new server finds the
    account's login in the vault and restores it: no QR code. (Check in the app, Settings, WhatsApp.)

 D. Only if it asks for a QR code or says the restore failed
    Restore the local backup on the new Mac install:
      bash restore-backup.sh "$BK"
    (restore-backup.sh is in the same folder as this script, or at https://nothingbotcurating.web.app/restore-backup.sh)

 Old Firebase key: after the new server runs well, remove the old server in the app (Account, Server) so its key is revoked.
EOF
