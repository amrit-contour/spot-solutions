# A pocket server on a pen drive

Turn an old laptop into the always-on Spot Solutions server, with Ubuntu installed **onto a USB drive**. The laptop's own disk is never touched: boot from the stick and it's a server, boot without it and it's the laptop you had.

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
   - **Profile:** hostname `spot-server` and a username of your choice.
   - **SSH:** tick **Install OpenSSH server**.
   - Skip the featured snaps.
3. When it finishes, remove the installer stick and reboot. In the BIOS, set **USB first** in the boot order, so the laptop boots the server whenever the stick is in.

## 3. Make it behave like a server

SSH in from your main computer (`ssh you@spot-server.local`, or use the IP from `ip a`), then:

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

## 4. Install Spot Solutions

Copy your Firebase service-account key over (from the machine that has it):

```bash
scp apps/worker/service-account.json you@spot-server.local:~/
```

Then on the server:

```bash
curl -fsSL https://raw.githubusercontent.com/amrit-dash/spot-solutions/main/deploy/install.sh | sudo bash
```

It asks for your Firebase project ID and the key's path (`/home/you/service-account.json`). Then it installs Node, Ollama and Gemma, and sets up two services that start on boot and restart if they crash: `ollama` and `spot-worker`. Delete the copied key from your home folder afterwards; the installer keeps its own locked-down copy.

```bash
journalctl -u spot-worker -f     # live logs
systemctl status spot-worker     # is it up?
```

Prefer containers? `docker compose -f deploy/docker-compose.yml up -d` from a clone of the repo does the same thing.

## 5. Link WhatsApp

On any computer, open **spot-solutions.web.app → Settings → Show QR code** and scan it with your phone (WhatsApp → Linked devices). From then on the server keeps the session alive. You run everything else from your phone, with the app installed to your home screen.

Linking only reads messages that arrive *after* you link. Auto-acknowledge stays off until you turn it on in Settings.

## Several curators on one server

Every curator who signs in gets their own WhatsApp session on this server. Rough sizing:

| RAM | Gemma model | WhatsApp sessions |
|---|---|---|
| 8 GB | `gemma3:4b` | about 6 |
| 8 GB | `gemma3:1b` | about 10 |
| 16 GB | `gemma3:4b` | 20+ |

Each session is one headless Chromium, using roughly 300–400 MB. Gemma is shared and handles one message burst at a time.

## Updating

Run the same install command again. It pulls the latest code and restarts the worker. Your WhatsApp sessions survive, because they live in `/var/lib/spot-solutions`.

## If something's off

| Symptom | Fix |
|---|---|
| App says "Server offline" | `systemctl status spot-worker`; check the laptop is awake and online |
| QR never appears | `journalctl -u spot-worker -n 100`; try `sudo systemctl restart spot-worker` |
| Very slow replies | Switch to `gemma3:1b` in Settings → Model, or add a Gemini API key for fallback |
| Laptop won't boot the stick | BIOS: USB first in boot order, Secure Boot off |
