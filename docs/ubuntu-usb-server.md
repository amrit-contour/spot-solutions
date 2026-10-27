# A pocket server on a pen drive

Turn an old laptop into the always-on Nothing BOT Server, with Ubuntu installed **onto a USB drive**. The laptop's own disk is never touched: boot from the stick and it's a server, boot without it and it's the laptop you had.

You need:

| | |
|---|---|
| **Installer stick** | Any USB drive, 4 GB or more. It gets wiped. |
| **Server stick** | The bigger drive: 64 GB or more, USB 3. A small SSD in a USB enclosure is far better (faster and lasts longer), but a good pen drive works. It gets wiped. |
| **Old laptop** | 8 GB RAM recommended (Gemma 3 4B uses about 3.5 GB). Keep it plugged in. |
| **Another computer** | To flash the installer. |

> A full install onto USB is not the same as a "live USB with persistence". A full install is a normal Ubuntu system that happens to live on a removable drive, and it's much more reliable for a server.

## 1. Make the installer stick

1. Download **Ubuntu Server 24.04 LTS** (amd64) from ubuntu.com/download/server.
2. Flash it to the **small** stick with [balenaEtcher](https://etcher.balena.io) (or Rufus on Windows).

## 2. Install Ubuntu onto the server stick

1. Plug **both** sticks into the laptop. Power it on and open the boot menu (usually F12, F9, Esc or F2; it flashes on screen). Pick the installer stick.
   - If it refuses to boot, turn off **Secure Boot** in the BIOS and try again.
2. Go through the installer:
   - **Network:** connect Wi-Fi or Ethernet now. It's much easier than doing it later.
   - **Storage:** choose *Custom storage layout* or *Use an entire disk*, and **select the big USB drive**. Check the size and model carefully. **Do not pick the laptop's internal disk.**
   - **Profile:** hostname `nbs-server` and a username of your choice.
   - **SSH:** tick **Install OpenSSH server**.
   - Skip the featured snaps.
3. When it finishes, remove the installer stick and reboot. In the BIOS, set **USB first** in the boot order, so the laptop boots the server whenever the stick is in.

## 3. Make it behave like a server

SSH in from your main computer (`ssh you@nbs-server.local`, or use the IP from `ip a`), then:

```bash
# Keep running with the lid closed, and never sleep
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo systemctl restart systemd-logind

# Be gentle on the USB drive: logs in RAM, no access-time writes
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=64M\n' | sudo tee /etc/systemd/journald.conf.d/usb.conf
sudo sed -i 's/\(\s\/\s\+ext4\s\+\)defaults/\1defaults,noatime/' /etc/fstab
sudo systemctl restart systemd-journald

# 4 GB swap as a safety net for Gemma + Chromium
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Security updates install themselves
sudo apt install -y unattended-upgrades
```

Optional, but handy: install [Tailscale](https://tailscale.com/download/linux) (`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`) to SSH in from anywhere, without opening ports on your router.

## 4. Install Nothing BOT Server

On the server (in its own terminal, or over SSH):

```bash
curl -fsSL https://nothingbotcurating.web.app/install.sh | sudo ADMIN_EMAILS=you@gmail.com bash
```

It installs Node 22, Chrome's libraries, Ollama and Gemma (about a 3.5 GB download), and three services that start on boot and restart on crash. If you run it in a terminal on a first install, it asks one question: run AI on this machine with Ollama and Gemma? (30 seconds, then yes). Set `NBS_NO_LOCAL_MODEL=1` to skip the question and the download:

| Service | What it does |
|---|---|
| `ollama` | Local AI |
| `nothing-bot-server-worker` | WhatsApp + curation. Idle until a Firebase key is added. |
| `nothing-bot-server-console` | Local web console on port **7420** |

**Local model or Gemini only.** A machine under about 8 GB of memory starts on Gemini with no Ollama or Gemma. You can switch either way in the console under **AI models**, any time. A Gemini-only server can't host accounts set to **Local only**. To force it at install time, set `NBS_NO_LOCAL_MODEL=1` (or `--no-local-model`, or `=0`). See [multi-server.md](multi-server.md).

The installer also puts `nbsctl` in `/usr/local/sbin` (root-owned) with the unit `nothing-bot-server-task@.service`, and lets the `spot` user start only `nothing-bot-server-task@update`, `nothing-bot-server-task@local-on` and `nothing-bot-server-task@local-off` (and restart the worker and Ollama). That is how the console updates the server and turns the local model on or off without being root.

At the end it prints a link like `http://192.168.1.42:7420/?token=…`. Open it from your phone or Mac on the same Wi-Fi. The console is served from the laptop itself, so it's only reachable on your home network, and you only need it once, for the key.

> **Day to day you never need the same Wi-Fi.** The laptop and your phone each talk to Firebase over the internet, so the app works from mobile data or anywhere. Logs, restarts and health live in the app under **Account → Server**.

## 5. Finish setup in the console

The console has Setup steps, a Health card (Check and repair), Services with Restart plus Stop and Start for the worker and for Ollama, CPU/RAM/disk, AI models (Gemini key check, local models, routing), live worker logs, and a Display options menu (theme, brand).

1. **Connect with Nothing BOT Curate:** click it, open the link (or scan the QR with your phone), sign in with Google as an admin, check the 4-character code and approve. The server gets its own key and the worker starts by itself. A join code from the app (**Account, Server, Add a server**) works too, and **First server ever? Use a key file** is only for a brand-new project (see [multi-server.md](multi-server.md)).
2. **Admins:** signing in adds your email. It opens **Account menu → Server** in the app: the same health stats plus connected curators, from anywhere. Add other admins in the console's **Admin emails**.
3. **Server Gemini key:** optional on a server with Gemma. Leave it blank; each curator adds their own in the app under **Settings → AI models**, where they can test it, browse models and pick a primary and a fallback. On a Gemini-only server, add one here or have each curator add theirs.

Lost the link? `sudo nbs-console-url`.

## 6. Link WhatsApp

Open **nothingbotcurate.web.app → Settings → Show QR code** on a computer and scan it with your phone (WhatsApp → Linked devices). Only messages that arrive after linking are read, and auto-acknowledge stays off until you turn it on.

## Several curators on one server

Every approved curator gets their own WhatsApp session on this server. Each session is one headless Chromium, using roughly 300 to 450 MB. Gemma is shared and handles one message burst at a time.

The server stops taking accounts at a limit worked out from its memory: (RAM minus 5.5 GB) / 450 MB with Gemma, (RAM minus 1.5 GB) / 450 MB without it. Set `NBS_MAX_ACCOUNTS` in `/opt/nothing-bot-server/apps/worker/.env` to change it.

| RAM | Default limit with Gemma | Gemini-only |
|---|---|---|
| 8 GB | about 5 | about 14 |
| 16 GB | about 23 | about 32 |

Add a second server and accounts spread across both, and move to the other if one goes offline: see [multi-server.md](multi-server.md).

## Updating

The server updates itself: the console checks every 30 minutes and installs a release a few minutes after it appears (switch off under **Updates**), or press **Update now** (or **Update** on the Server page of the app). A server installed before this release needs the install command run once more. Running it again always works: it pulls the latest code and restarts the worker. Your WhatsApp sessions, key and `.env` survive, because they live in `/var/lib/nothing-bot-server` and `/opt/nothing-bot-server/apps/worker/.env`. If you run several servers, stop any still on an older release first (see [multi-server.md](multi-server.md)).

## Where the data and AI models go

A fresh install asks **Where should Nothing BOT keep its data and AI models?** after Node is installed (the WhatsApp logins, backups, logs and the Gemma models; the program stays in `/opt/nothing-bot-server`). It lists the mounted disks with free space and pre-selects the one with the most room, with `<mount>/nothing-bot-server` (`/var/lib/nothing-bot-server` stays the default when the system disk has the most room). Press **Enter** to accept, type a number, or type another full path. It shows free space against what is needed (about 5 GB with `gemma3:4b`) and asks before going ahead on less. It reads the prompt from the terminal, so it also works with `curl ... | sudo bash`.

It refuses, with a one-line reason: cloud folders (Dropbox, Google Drive, OneDrive, iCloud mounts), removable disks (`/media`, `/run/media`, USB), network filesystems (NFS, SMB, sshfs), non-Linux filesystems (FAT, exFAT, NTFS), users' home folders (the service account can't read them) and the program folder. Data goes in `<folder>/data` and the models in `<folder>/ollama`.

The choice is written to `/etc/nothing-bot-server/data-dir` and `models-dir`, the same files **Move data** writes, with `OLLAMA_MODELS` in the `ollama` systemd drop-in (`models.conf`) and the console unit. Re-running the install command and updates keep it and never ask again. Unattended: `curl -fsSL https://nothingbotcurating.web.app/install.sh | sudo NBS_DATA_DIR=/mnt/disk/nothing-bot-server bash` uses that folder (checked the same way), and `... | sudo bash -s -- --yes` (or `NBS_YES=1`) accepts the suggestion. With nobody at the terminal and neither, the default is used. The logic is one file, `deploy/datadir.mjs`, fetched by the installer.

## Moving the data to another disk

In the console, **Storage**, type the new folder on the mounted disk (for example `/mnt/disk/NothingBotServer/data`; ext4, not NTFS or FAT), press **Check folder**, then **Move data**. The console runs as the unprivileged `spot` user, so it only asks systemd to start `nothing-bot-server-task@move-data`, which runs `/usr/local/lib/nothing-bot-server/move.mjs` as root. That helper is root-owned, validates the path again (absolute, no symlinks on the way, not inside the app folder, empty, writable, room for the data plus 1 GB) and copies without following symlinks. It then writes the choice to `/etc/nothing-bot-server/data-dir` (which the installer and `nbsctl` read, so re-running the install command or updating keeps it), adds systemd drop-ins for `nothing-bot-server-console` and `nothing-bot-server-worker` (and `ollama` when the models move), restarts them and waits for WhatsApp. On any failure it puts everything back. **Delete the old copy** is a separate task and only removes the folder recorded by a verified move in `/etc/nothing-bot-server/move.json`. A server installed before this release needs the install command run once more to get the helper.

## If something's off

| Symptom | Fix |
|---|---|
| App says "Server offline" | `systemctl status nothing-bot-server-worker`; check the laptop is awake and online |
| QR never appears | `journalctl -u nothing-bot-server-worker -n 100`; try `sudo systemctl restart nothing-bot-server-worker` |
| Very slow replies | Switch to `gemma3:1b` in Settings → AI models, or add a Gemini API key for fallback |
| Laptop won't boot the stick | BIOS: USB first in boot order, Secure Boot off |
| Console link lost | `sudo nbs-console-url` |

## Uninstall

```bash
curl -fsSL https://nothingbotcurating.web.app/uninstall.sh | sudo bash
```

Removes the services, code, helper scripts, sudo rule and the `nbs` account, for this server **and** for the old "Spot Solutions" server (`spot-worker`, `/opt/spot-solutions`) if it is still there. It **keeps** your data (`/var/lib/nothing-bot-server`, and `/var/lib/spot-solutions` from the old server), a data folder you moved to another disk, and Ollama with its models, and prints what it kept. To delete the data too:

```bash
curl -fsSL https://nothingbotcurating.web.app/uninstall.sh | sudo bash -s -- --delete-data
```

(A data folder on another disk is never deleted by the script; delete it yourself.)

On your phone, also remove the old entry under **WhatsApp → Linked devices**.
