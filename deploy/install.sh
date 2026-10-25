#!/usr/bin/env bash
# Spot Solutions server: one-shot install for Ubuntu 24.04+ / Debian / Kali (x86_64 or arm64).
#
#   curl -fsSL https://spot-solutions.web.app/install.sh | sudo bash
#   # optional: | sudo ADMIN_EMAILS=you@gmail.com bash
#
# Installs Node 22, Chrome's libraries, Ollama + Gemma, then three systemd services:
#   ollama        local AI
#   spot-worker   WhatsApp + curation (starts once a Firebase key is added)
#   spot-console  local web console on port 7420: status, logs, key upload, restarts
# Asks nothing: add keys from the console afterwards. Re-running updates and restarts.
set -euo pipefail

SRC_URL="${SPOT_SRC_URL:-https://spot-solutions.web.app/dl/spot-solutions.tar.gz}"
APP_DIR="/opt/spot-solutions"
DATA_DIR="/var/lib/spot-solutions"
SVC_USER="spot"
MODEL="${GEMMA_MODEL:-gemma3:4b}"
PNPM="pnpm@9.15.4"
PORT=7420

[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
. /etc/os-release
case "${ID} ${ID_LIKE:-}" in *ubuntu*|*debian*|*kali*) ;; *) echo "Warning: built for Ubuntu/Debian/Kali, you're on ${PRETTY_NAME}. Trying anyway." ;; esac

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
ENV_FILE="${APP_DIR}/apps/worker/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  cat > "${ENV_FILE}" <<EOF
FIREBASE_SERVICE_ACCOUNT=${DATA_DIR}/service-account.json
FIREBASE_PROJECT_ID=
OLLAMA_URL=http://127.0.0.1:11434
GEMINI_API_KEY=
WWEBJS_DATA=${DATA_DIR}/wwebjs
CHROME_PATH=
SPOT_ADMIN_EMAILS=${ADMIN_EMAILS:-}
EOF
elif [[ -n "${ADMIN_EMAILS:-}" ]]; then
  sed -i "s|^SPOT_ADMIN_EMAILS=.*|SPOT_ADMIN_EMAILS=${ADMIN_EMAILS}|" "${ENV_FILE}"
fi
chown "${SVC_USER}:${SVC_USER}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

# The console may restart these two services, and nothing else.
cat > /etc/sudoers.d/spot-console <<EOF
${SVC_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl restart spot-worker, /usr/bin/systemctl restart ollama
EOF
chmod 440 /etc/sudoers.d/spot-console
visudo -cf /etc/sudoers.d/spot-console >/dev/null

step "systemd services"
cat > /etc/systemd/system/spot-worker.service <<EOF
[Unit]
Description=Spot Solutions worker (WhatsApp + Gemma)
After=network-online.target ollama.service
Wants=network-online.target ollama.service
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
echo "1. Drop your Firebase service-account key into the console (starts the worker)."
echo "2. Add your email under Admins to see this server in the app."
echo "3. Link WhatsApp at https://spot-solutions.web.app → Settings."
echo "After that, everything (including restarts and logs) is in the app → Account → Server, from anywhere."
echo "Forgot the link later? sudo spot-console-url"
