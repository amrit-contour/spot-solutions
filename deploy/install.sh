#!/usr/bin/env bash
# Spot Solutions server: one-shot install for Ubuntu 24.04+ / Debian / Kali (x86_64 or arm64).
#
#   curl -fsSL https://spot-solutions.web.app/install.sh | sudo bash
#   # optional: | sudo ADMIN_EMAILS=you@gmail.com bash
#
# One command for every computer: on a Mac it hands over to the Mac installer (no sudo), on Ubuntu/Debian it
#   installs Node 22, Chrome's libraries, Ollama + Gemma, then three systemd services:
#   ollama        local AI
#   spot-worker   WhatsApp + curation (starts once the server is connected)
#   spot-console  local web console on port 7420: sign in, update, AI models, logs
# Plus spot-task, a small root-owned helper the console uses to update the server, turn the local model on or off, and move
# the data to another disk (with move.mjs and storage.mjs, also root-owned, in /usr/local/lib/spot-solutions).
# Connect the server from its console afterwards. Re-running updates and restarts.
#
# Local model or Gemini only? You choose in the console (AI models) and can switch any time. The installer picks for
# you: a local model on computers with about 8 GB of memory or more, Gemini only on smaller ones. To force it:
#   SPOT_NO_LOCAL_MODEL=1 (or --no-local-model), or SPOT_NO_LOCAL_MODEL=0. Re-running keeps the last choice.
set -euo pipefail

# One entry point: the Mac installer lives in install-mac.sh (it installs the Spot Server app and sets the Mac up).
if [[ "$(uname -s)" == Darwin ]]; then
  exec bash -c "$(curl -fsSL "${SPOT_BASE_URL:-https://spot-solutions.web.app}/install-mac.sh")" install-mac.sh "$@"
fi

SRC_URL="${SPOT_SRC_URL:-https://spot-solutions.web.app/dl/spot-solutions.tar.gz}"
APP_DIR="/opt/spot-solutions"
STATE_DIR="/etc/spot-solutions"
# The data may live on another disk (console: Storage, Move data). That choice is recorded here, so re-running this
# installer keeps it instead of going back to the default folder.
DATA_DIR="$(head -n1 "${STATE_DIR}/data-dir" 2>/dev/null || true)"
[[ -n "${DATA_DIR}" ]] || DATA_DIR="/var/lib/spot-solutions"
[[ "${DATA_DIR}" == "/var/lib/spot-solutions" ]] || [[ -d "$(dirname "${DATA_DIR}")" ]] || { echo "Your data lives in ${DATA_DIR}, but that disk isn't mounted. Mount it and run this again."; exit 1; }
SVC_USER="spot"
MODEL="${GEMMA_MODEL:-gemma3:4b}"
PNPM="pnpm@9.15.4"
PORT=7420

for arg in "$@"; do if [[ "$arg" == "--no-local-model" ]]; then SPOT_NO_LOCAL_MODEL=1; fi; done
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
. /etc/os-release
case "${ID} ${ID_LIKE:-}" in *ubuntu*|*debian*|*kali*) ;; *) echo "Warning: built for Ubuntu/Debian/Kali, you're on ${PRETTY_NAME}. Trying anyway." ;; esac

# Local model or Gemini-only? An explicit env/flag wins; else keep what a previous install chose; else decide by memory
# (a local model needs about 8 GB). It can be switched any time in the console, under AI models.
ENV_FILE="${APP_DIR}/apps/worker/.env"
if [[ -z "${SPOT_NO_LOCAL_MODEL:-}" ]]; then
  if [[ -f "${ENV_FILE}" ]]; then
    if grep -q '^SPOT_NO_LOCAL_MODEL=1' "${ENV_FILE}"; then SPOT_NO_LOCAL_MODEL=1; else SPOT_NO_LOCAL_MODEL=0; fi
  else
    MEM_KB="$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
    if [[ "${MEM_KB:-0}" -lt 7300000 ]]; then SPOT_NO_LOCAL_MODEL=1; echo "This computer has under 8 GB of memory, so it will use Gemini. You can turn on a local model later in the console."; fi
  fi
fi
case "${SPOT_NO_LOCAL_MODEL:-}" in 1|true|yes) NO_LOCAL=1 ;; *) NO_LOCAL=0 ;; esac

step() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m%s\033[0m\n' "$*"; }

step "System packages"
apt-get update -y
# Chrome itself comes from Puppeteer during `pnpm install` (Ubuntu's chromium is a snap, which
# breaks under a service account). These are the libraries it needs.
LIBS="ca-certificates curl tar gnupg sudo fonts-noto-color-emoji libnss3 libdrm2 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2"
# 24.04+ renamed some libraries with a t64 suffix; take whichever exists.
for pair in "libatk1.0-0t64 libatk1.0-0" "libatk-bridge2.0-0t64 libatk-bridge2.0-0" "libcups2t64 libcups2" "libasound2t64 libasound2"; do
  set -- $pair
  if apt-cache show "$1" >/dev/null 2>&1; then LIBS="$LIBS $1"; else LIBS="$LIBS $2"; fi
done
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $LIBS

step "Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE="$(command -v node)"
ok "Node $(node -v)"

if [[ "${NO_LOCAL}" == 1 ]]; then
  step "Gemini-only server: skipping Ollama and Gemma"
  ok "AI will use Gemini (add a Gemini key in the console or the app)"
else
step "Ollama + ${MODEL}"
command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/spot.conf <<EOF
[Service]
Environment=OLLAMA_KEEP_ALIVE=24h
Environment=OLLAMA_NUM_PARALLEL=1
EOF
systemctl daemon-reload
systemctl enable --now ollama
for _ in $(seq 1 30); do curl -fs http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done
ollama pull "${MODEL}"
ok "Gemma ready"
fi

step "Service account and code"
id -u "${SVC_USER}" >/dev/null 2>&1 || useradd --system --create-home --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin "${SVC_USER}"
usermod -aG systemd-journal "${SVC_USER}"   # lets the console show worker logs
mkdir -p "${DATA_DIR}" "${APP_DIR}"
# Code comes as a tarball (no git needed). .env and node_modules aren't in it, so updates keep them.
curl -fsSL "${SRC_URL}" | tar -xz -C "${APP_DIR}"
chown -R "${SVC_USER}:${SVC_USER}" "${APP_DIR}" "${DATA_DIR}"
sudo -u "${SVC_USER}" -H bash -c "cd ${APP_DIR} && npx -y ${PNPM} install --frozen-lockfile --filter @spot/worker..."
ok "Code at ${APP_DIR}"

step "Configuration"
if [[ ! -f "${ENV_FILE}" ]]; then
  cat > "${ENV_FILE}" <<EOF
FIREBASE_SERVICE_ACCOUNT=${DATA_DIR}/service-account.json
FIREBASE_PROJECT_ID=
OLLAMA_URL=http://127.0.0.1:11434
GEMINI_API_KEY=
WWEBJS_DATA=${DATA_DIR}/wwebjs
CHROME_PATH=
SPOT_ADMIN_EMAILS=${ADMIN_EMAILS:-}
SPOT_NO_LOCAL_MODEL=${NO_LOCAL}
EOF
elif [[ -n "${ADMIN_EMAILS:-}" ]]; then
  sed -i "s|^SPOT_ADMIN_EMAILS=.*|SPOT_ADMIN_EMAILS=${ADMIN_EMAILS}|" "${ENV_FILE}"
fi
# Record the choice (also when re-running to switch between local model and Gemini-only).
if grep -q '^SPOT_NO_LOCAL_MODEL=' "${ENV_FILE}"; then sed -i "s|^SPOT_NO_LOCAL_MODEL=.*|SPOT_NO_LOCAL_MODEL=${NO_LOCAL}|" "${ENV_FILE}"; else echo "SPOT_NO_LOCAL_MODEL=${NO_LOCAL}" >> "${ENV_FILE}"; fi
chown "${SVC_USER}:${SVC_USER}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

# spot-task: root-owned, installed from the release we just unpacked. The console never has root run anything from the
# folder it can write to; it can only ask systemd to start these three named tasks.
install -m 0755 -o root -g root "${APP_DIR}/deploy/ubuntu/spot-task" /usr/local/sbin/spot-task
install -d -m 0755 -o root -g root /usr/local/lib/spot-solutions "${STATE_DIR}"
for f in move.mjs storage.mjs; do install -m 0644 -o root -g root "${APP_DIR}/apps/worker/console/${f}" "/usr/local/lib/spot-solutions/${f}"; done
cat > /etc/systemd/system/spot-task@.service <<EOF
[Unit]
Description=Spot Solutions server task (%i)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/spot-task %i
TimeoutStartSec=7200
EOF

# The console may restart the worker and Ollama, and start the five tasks above: nothing else.
cat > /etc/sudoers.d/spot-console <<EOF
${SVC_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl restart spot-worker, /usr/bin/systemctl restart ollama, /usr/bin/systemctl start --no-block spot-task@update.service, /usr/bin/systemctl start --no-block spot-task@local-on.service, /usr/bin/systemctl start --no-block spot-task@local-off.service, /usr/bin/systemctl start --no-block spot-task@move-data.service, /usr/bin/systemctl start --no-block spot-task@move-cleanup.service
EOF
chmod 440 /etc/sudoers.d/spot-console
visudo -cf /etc/sudoers.d/spot-console >/dev/null

step "systemd services"
# Always ordered after Ollama when it exists, so turning the local model on later needs no unit change.
cat > /etc/systemd/system/spot-worker.service <<EOF
[Unit]
Description=Spot Solutions worker (WhatsApp + Gemma)
After=network-online.target ollama.service
Wants=network-online.target
# Stays idle until a Firebase key is uploaded in the console.
ConditionPathExists=${DATA_DIR}/service-account.json

[Service]
User=${SVC_USER}
WorkingDirectory=${APP_DIR}/apps/worker
ExecStart=${NODE} ${APP_DIR}/apps/worker/node_modules/tsx/dist/cli.mjs --env-file-if-exists=.env src/index.ts
Restart=always
RestartSec=10
# Time to close WhatsApp cleanly and save a backup of each login before stopping.
TimeoutStopSec=90
KillSignal=SIGTERM
MemoryHigh=5G
Nice=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/spot-console.service <<EOF
[Unit]
Description=Spot Solutions server console (port ${PORT})
After=network-online.target

[Service]
User=${SVC_USER}
Environment=SPOT_DATA_DIR=${DATA_DIR}
Environment=SPOT_ENV_FILE=${ENV_FILE}
Environment=SPOT_CONSOLE_PORT=${PORT}
ExecStart=${NODE} ${APP_DIR}/apps/worker/console/server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/bin/spot-console-url <<EOF
#!/usr/bin/env bash
# Prints the console link (with its access token) for every network address of this machine.
TOKEN=\$(cat ${DATA_DIR}/console-token 2>/dev/null) || { echo "Run with sudo"; exit 1; }
for ip in \$(hostname -I) localhost; do echo "http://\${ip}:${PORT}/?token=\${TOKEN}"; done
IP=\$(hostname -I | awk '{print \$1}')
QR="${APP_DIR}/apps/worker/console/qr.mjs"
if [[ -n "\$IP" && -f "\$QR" ]] && command -v node >/dev/null; then echo; echo "Scan to open it on your phone (same Wi-Fi):"; node "\$QR" "http://\${IP}:${PORT}/?token=\${TOKEN}"; fi
EOF
chmod 755 /usr/local/bin/spot-console-url

systemctl daemon-reload
systemctl enable spot-worker spot-console >/dev/null
systemctl restart spot-console
[[ -f "${DATA_DIR}/service-account.json" ]] && systemctl restart spot-worker
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow ${PORT}/tcp >/dev/null && ok "Opened port ${PORT} in ufw"; fi

step "Keep running with the lid closed"
sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true
ok "Sleep disabled, lid close ignored (takes effect after reboot)"

for _ in $(seq 1 10); do [[ -f "${DATA_DIR}/console-token" ]] && break; sleep 1; done
step "Done"
echo "One-time setup: open the server console from a phone or laptop on THIS Wi-Fi:"
/usr/local/bin/spot-console-url | sed 's/^/  /'
echo
echo "1. In the console, click Connect with Spot Solutions and sign in with Google (an admin account)."
echo "   No admin yet (a brand-new project)? Use 'First server ever? Use a key file' in the same card."
if [[ "${NO_LOCAL}" == 1 ]]; then echo "   This server uses Gemini: add a Gemini key under AI models (or each curator in the app). A local model can be turned on there too."; else echo "   Local or Gemini only, and which models, is under AI models in the console."; fi
echo "2. Link WhatsApp at https://spot-solutions.web.app → Settings."
echo "After that, everything (restarts, logs, updates) is in the app → Account → Server, from anywhere."
echo "The server updates itself; the console has an Update now button. Forgot the link later? sudo spot-console-url"
