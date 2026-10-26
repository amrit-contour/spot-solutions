# Run the server on Windows

Turn any Windows 10 or 11 PC into the Spot Solutions server: WhatsApp sessions, local Gemma and the server console. It starts at boot, even before anyone logs in, and restarts itself if it crashes.

You need:

| | |
|---|---|
| **A PC** | Windows 10 or 11. 8 GB RAM recommended (Gemma 3 4B uses about 3.5 GB). Keep it plugged in and online. |
| **winget** | Part of Windows "App Installer". Only used to install Ollama, so you don't need it for a Gemini-only server or if Ollama is already installed. Most PCs have it. |
| **A join code** | One key per device, made for you. An admin makes a code in the app under **Account, Server, Add a server**. See [multi-server.md](multi-server.md). |

## Install

### Option 1: the zip

1. Download [SpotSolutions-Windows.zip](https://spot-solutions.web.app/dl/SpotSolutions-Windows.zip) and unzip it anywhere.
2. Double-click **Install Spot Solutions.cmd** and click **Yes** on the admin prompt.

It asks you nothing. It takes a few minutes, mostly the Gemma download (about 3.5 GB).

### Option 2: one line in PowerShell

Open PowerShell **as Administrator** and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
irm https://spot-solutions.web.app/install.ps1 | iex
```

To set your admin email at the same time, run this first: `$env:ADMIN_EMAILS = "you@gmail.com"`.

### Gemini only

No room for Gemma (under about 8 GB of RAM)? Double-click **Install Spot Solutions (Gemini only).cmd** instead. It skips Ollama and the Gemma download, and AI runs on Gemini, so you add a Gemini key later. In PowerShell, run `$env:SPOT_NO_LOCAL_MODEL = "1"` before the one-liner. This server can't host accounts set to **Local only**. See [multi-server.md](multi-server.md).

## What the installer does

| Step | Result |
|---|---|
| Node.js | Its own copy of the latest Node 22 LTS in `C:\SpotSolutions\node`. The boot task runs as the SYSTEM account, which can't use per-user installs. |
| Ollama and Gemma | Installs Ollama with winget (skipped if it's already there), keeps models in `C:\SpotSolutions\ollama`, keeps them loaded for 24 hours, and pulls `gemma3:4b`. Skipped on a Gemini-only server. |
| Code | Downloads the code from spot-solutions.web.app into `C:\SpotSolutions\app` and installs the worker's dependencies with the pinned pnpm. Chrome for WhatsApp Web goes in `C:\SpotSolutions\chrome`. |
| Configuration | Writes `app\apps\worker\.env` and locks `C:\SpotSolutions\data` so only SYSTEM and Administrators can read it. |
| Worker | A scheduled task `SpotSolutionsWorker` that starts at boot as SYSTEM and restarts after a crash. It waits until a Firebase key exists, starts Ollama if needed, and logs to `data\worker.log`. |
| Console | A second task, `SpotSolutionsConsole`, serves the server console on port 7420 (log: `data\console.log`). |
| Firewall | An inbound rule "Spot Solutions Console" for TCP 7420, **private networks only**. |
| Shortcuts | **Spot Server Console** and **Spot Solutions** on the desktop (all users) and in the Start menu. They open in an Edge app window when Edge is installed. |
| Power | No standby or hibernate on power, and closing the lid on power does nothing. |

At the end the console opens and the installer prints a link for a phone on the same Wi-Fi.

## Finish setup in the console

1. Type the join code (from **Account, Server, Add a server** in the app) under **Enter join code**, check the device name, and click **Join**. The worker starts by itself. No code? Click **or drop a key file** and drop a key made with `deploy/new-server-key.sh` (then delete the file, it is a password).
2. Under **Admins**, add your email. This shows the server in the app under **Account, Server**, from anywhere.
3. Gemini-only server: also add a Gemini key (the console, or each curator under **Settings, AI models**).
4. Open **Spot Solutions** from the desktop, go to **Settings, Show QR code**, and scan it from WhatsApp on your phone (**Linked devices**).

## Everyday

Day to day you manage the server from the app (**Account, Server**: health, logs, restart buttons), from anywhere. On the PC itself, these files are in the unzipped folder:

| File | What it does |
|---|---|
| **Open Server Console.cmd** | Opens `http://localhost:7420` (same as the desktop shortcut). |
| **View Logs.cmd** | Follows the live worker log. Closing the window doesn't stop the worker. |
| **Restart Worker.cmd** | Stops the worker and its browsers. The boot task starts it again within 10 seconds. |
| **Uninstall.cmd** | Removes the tasks, shortcuts and firewall rule. Keeps your data. |

To stop or start it from PowerShell as Administrator:

```powershell
Stop-ScheduledTask SpotSolutionsWorker
Start-ScheduledTask SpotSolutionsWorker
```

Stopping is safe. WhatsApp closes cleanly and a backup of the login is saved. When the worker starts again it reconnects without a QR code.

## Where things live

Everything is under `C:\SpotSolutions`.

| Path | What's in it |
|---|---|
| `app\` | The code. Settings are in `app\apps\worker\.env`. |
| `data\` | `service-account.json` (the key), `worker.log`, `console.log`, `console-token`. |
| `data\wwebjs\` | WhatsApp logins (`session-<uid>`), the server id (`server.json`) and login-backup markers. |
| `node\`, `ollama\`, `chrome\` | Node.js, the Gemma models, Chrome. |
| `run-worker.ps1`, `run-console.ps1` | The launchers the tasks run. |

## Update

Run the installer again. Re-running is safe: it stops the old worker and its browsers, updates the code, keeps your key, `.env` and WhatsApp logins, and restarts the tasks. It keeps the last choice between local model and Gemini-only unless you set `SPOT_NO_LOCAL_MODEL`.

Use the PowerShell one-liner, or download the zip again. The `.cmd` in an old unzipped folder runs the `install.ps1` stored next to it, which may be out of date.

If you run other servers too, stop any that are still on an older release first, see [multi-server.md](multi-server.md).

## Uninstall

Double-click **Uninstall.cmd**. It stops the worker, removes the two scheduled tasks, the firewall rule and the shortcuts, and keeps `C:\SpotSolutions\data`. To remove everything, delete `C:\SpotSolutions` afterwards. Ollama itself stays installed (remove it from Settings, Apps). On your phone, remove the old entry under **WhatsApp, Linked devices**.

## If something's off

| Symptom | Fix |
|---|---|
| App says "Server offline" | Check the PC is on and online. Double-click **Restart Worker.cmd**, then **View Logs.cmd**. |
| Nothing starts after install | The worker waits for a Firebase key. Enter a join code in the console (or drop a key file). |
| The installer says it can't install Ollama | Install it from ollama.com/download, then run the installer again. |
| The installer says to run as Administrator | Use the `.cmd` and click Yes on the prompt, or open PowerShell as Administrator. |
| Console doesn't open from a phone | The PC must be on the same Wi-Fi, and that network set to **Private**. Use the link the installer printed. |
| Very slow replies | Switch to a smaller model under **Settings, AI models**, or add a Gemini key. |
| QR never appears | Wait a minute after starting, then check the log in **View Logs.cmd** and restart the worker. |
