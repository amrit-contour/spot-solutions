#!/usr/bin/env bash
# Nothing BOT Server: uninstall on Ubuntu / Debian / Kali. Removes the new server AND the old "Spot Solutions" server.
#
#   curl -fsSL https://nothingbotcurating.web.app/uninstall.sh | sudo bash
#
# Removes the services, code, helper scripts, sudo rule and service accounts. KEEPS the data folders (WhatsApp login,
# keys, settings, backups) and Ollama with its models. To delete the data too, add --delete-data:
#   curl -fsSL https://nothingbotcurating.web.app/uninstall.sh | sudo bash -s -- --delete-data
# Only the data folders this installer made are ever deleted. A data folder you moved to another disk is never touched.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }

DELETE_DATA=0
for a in "$@"; do [[ "$a" == "--delete-data" ]] && DELETE_DATA=1; done

step() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m%s\033[0m\n' "$*"; }

step "Stopping services"
for u in nothing-bot-server-worker nothing-bot-server-console spot-worker spot-console; do
  if [[ -f "/etc/systemd/system/${u}.service" ]] || systemctl list-unit-files "${u}.service" 2>/dev/null | grep -q "${u}"; then
    systemctl disable --now "${u}.service" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${u}.service"
    ok "Removed ${u}"
  fi
done
rm -f /etc/systemd/system/nothing-bot-server-task@.service /etc/systemd/system/spot-task@.service
rm -f /etc/systemd/system/ollama.service.d/nothing-bot-server.conf /etc/systemd/system/ollama.service.d/spot.conf
systemctl daemon-reload

step "Removing helpers and sudo rules"
rm -f /usr/local/sbin/nbsctl /usr/local/sbin/spot-task /usr/local/bin/nbs-console-url /usr/local/bin/spot-console-url
rm -f /etc/sudoers.d/nothing-bot-server-console /etc/sudoers.d/spot-console
rm -rf /usr/local/lib/nothing-bot-server /usr/local/lib/spot-solutions
ok "Done"

step "Removing the program files"
rm -rf /opt/nothing-bot-server /opt/spot-solutions
ok "Removed /opt/nothing-bot-server and the old /opt/spot-solutions"

# Where the data lives: the default folders, plus a disk it was moved to (recorded in the state folder).
CUSTOM=""
for s in /etc/nothing-bot-server /etc/spot-solutions; do
  [[ -f "$s/data-dir" ]] && CUSTOM="$CUSTOM $(head -n1 "$s/data-dir")"
done
KEPT=()
for d in /var/lib/nothing-bot-server /var/lib/spot-solutions; do [[ -d "$d" ]] && KEPT+=("$d"); done

step "Service accounts"
for u in nbs spot; do
  if id -u "$u" >/dev/null 2>&1; then
    home="$(getent passwd "$u" | cut -d: -f6)"
    # Only remove the accounts this installer made: system accounts whose home is one of its data folders.
    case "$home" in
      /var/lib/nothing-bot-server|/var/lib/spot-solutions) userdel "$u" >/dev/null 2>&1 && ok "Removed account $u" || true ;;
      *) ok "Left account $u alone (not one of ours)" ;;
    esac
  fi
done

if [[ $DELETE_DATA == 1 ]]; then
  step "Deleting data (--delete-data)"
  for d in "${KEPT[@]:-}"; do [[ -n "$d" ]] && rm -rf "$d" && ok "Deleted $d"; done
  rm -rf /etc/nothing-bot-server /etc/spot-solutions
  for d in $CUSTOM; do [[ -n "$d" ]] && echo "  Your data folder on another disk was NOT deleted: $d (delete it yourself if you want it gone)"; done
else
  step "Kept"
  for d in "${KEPT[@]:-}"; do [[ -n "$d" ]] && echo "  Data kept: $d"; done
  for d in $CUSTOM; do [[ -n "$d" ]] && echo "  Data kept: $d"; done
  echo "  Settings folder kept: /etc/nothing-bot-server /etc/spot-solutions (if present)"
  echo "  Ollama and its models were not touched."
  echo "  To delete the data as well, run this again with --delete-data."
fi

step "Done"
echo "Install again any time:  curl -fsSL https://nothingbotcurating.web.app/install.sh | sudo bash"
