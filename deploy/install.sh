#!/usr/bin/env bash
# Spot Solutions worker — native install for Ubuntu Server 24.04 (x86_64).
# Installs Node 22, Chromium deps, Ollama + Gemma, and two systemd services
# that start on boot and restart on failure.
#
#   curl -fsSL https://raw.githubusercontent.com/amrit-dash/spot-solutions/main/deploy/install.sh | sudo bash
#
# Re-running is safe: it updates the code and restarts the service.
set -euo pipefail

REPO="https://github.com/amrit-dash/spot-solutions.git"
APP_DIR="/opt/spot-solutions"
DATA_DIR="/var/lib/spot-solutions"
SVC_USER="spot"
MODEL="${GEMMA_MODEL:-gemma3:4b}"

[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
. /etc/os-release
[[ "${ID}" == "ubuntu" ]] || echo "Warning: tested on Ubuntu 24.04, you're on ${PRETTY_NAME}."

step() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }

step "System packages"
apt-get update -y
# Chrome itself comes from Puppeteer (Ubuntu's chromium is a snap, which breaks under a service user).
apt-get install -y --no-install-recommends ca-certificates curl git gnupg fonts-noto-color-emoji \
  libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libgbm1 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 libasound2t64

step "Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1)" != "v22" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable

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
sleep 3
ollama pull "${MODEL}"

step "Service user and code"
id -u "${SVC_USER}" >/dev/null 2>&1 || useradd --system --create-home --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin "${SVC_USER}"
if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" pull --ff-only
else
  git clone --depth 1 "${REPO}" "${APP_DIR}"
fi
chown -R "${SVC_USER}:${SVC_USER}" "${APP_DIR}"
sudo -u "${SVC_USER}" -H bash -c "cd ${APP_DIR} && corepack pnpm install --frozen-lockfile --filter @spot/worker..."

step "Configuration"
ENV_FILE="${APP_DIR}/apps/worker/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  read -rp "Firebase project ID: " PROJECT_ID </dev/tty
  read -rp "Path to your service-account JSON on this machine: " SA_SRC </dev/tty
  install -o "${SVC_USER}" -g "${SVC_USER}" -m 600 "${SA_SRC}" "${DATA_DIR}/service-account.json"
  read -rp "Gemini API key for fallback (optional, Enter to skip): " GEMINI </dev/tty
  cat > "${ENV_FILE}" <<EOF
FIREBASE_SERVICE_ACCOUNT=${DATA_DIR}/service-account.json
FIREBASE_PROJECT_ID=${PROJECT_ID}
OLLAMA_URL=http://127.0.0.1:11434
GEMINI_API_KEY=${GEMINI}
WWEBJS_DATA=${DATA_DIR}/wwebjs
CHROME_PATH=
EOF
  chown "${SVC_USER}:${SVC_USER}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi

step "systemd service"
cat > /etc/systemd/system/spot-worker.service <<EOF
[Unit]
Description=Spot Solutions worker (WhatsApp + Gemma)
After=network-online.target ollama.service
Wants=network-online.target ollama.service

[Service]
User=${SVC_USER}
WorkingDirectory=${APP_DIR}/apps/worker
ExecStart=/usr/bin/env corepack pnpm start
Restart=always
RestartSec=10
# Chromium per WhatsApp session is memory hungry; keep the box responsive.
MemoryHigh=5G
Nice=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now spot-worker
systemctl restart spot-worker

step "Done"
echo "Logs:     journalctl -u spot-worker -f"
echo "Status:   systemctl status spot-worker"
echo "Then open https://spot-solutions.web.app → Settings → Show QR code."
