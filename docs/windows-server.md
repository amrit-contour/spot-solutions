# Run the server on Windows

Turn any Windows 10 or 11 PC into the Nothing BOT Server: WhatsApp sessions, local Gemma and the server console. It starts at boot, even before anyone logs in, and restarts itself if it crashes.

You need:

| | |
|---|---|
| **A PC** | Windows 10 or 11. 8 GB RAM recommended (Gemma 3 4B uses about 3.5 GB). Keep it plugged in and online. |
| **winget** | Part of Windows "App Installer". Only used to install Ollama, so you don't need it for a Gemini-only server or if Ollama is already installed. Most PCs have it. |
| **An admin account** | You sign in with Google in the server console and approve it. No key files. See [multi-server.md](multi-server.md). |

## Install

### Option 1: the zip

1. Download [NothingBotServer-Windows.zip](https://nothingbotcurating.web.app/dl/NothingBotServer-Windows.zip) and unzip it anywhere.
2. Double-click **Install Nothing BOT Server.cmd** and click **Yes** on the admin prompt.

It asks you nothing. It takes a few minutes, mostly the Gemma download (about 3.5 GB).

### Option 2: one line in PowerShell

Open PowerShell **as Administrator** and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
irm https://nothingbotcurating.web.app/install.ps1 | iex
```

To set your admin email at the same time, run this first: `$env:ADMIN_EMAILS = "you@gmail.com"`.

### Local model or Gemini only

There is one installer. A PC with about 8 GB of RAM or more starts with Ollama and Gemma; a smaller one starts on Gemini. You can switch any time in the console under **AI models**, which installs or turns off the local model for you. `Install Nothing BOT Server (Gemini only).cmd` still exists and forces Gemini at install time. A Gemini-only server can't host accounts set to **Local only**. See [multi-server.md](multi-server.md).

## What the installer does

| Step | Result |
|---|---|
| Node.js | Its own copy of the latest Node 22 LTS in `C:\NothingBotServer\node`. The boot task runs as the SYSTEM account, which can't use per-user installs. |
| Ollama and Gemma | Installs Ollama with winget (skipped if it's already there), keeps models in `C:\NothingBotServer\ollama`, keeps them loaded for 24 hours, and pulls `gemma3:4b`. Skipped on a Gemini-only server. |
| Code | Downloads the code from nothingbotcurating.web.app into `C:\NothingBotServer\app` and installs the worker's dependencies with the pinned pnpm. Chrome for WhatsApp Web goes in `C:\NothingBotServer\chrome`. |
| Configuration | Writes `app\apps\worker\.env` and locks `C:\NothingBotServer\data` so only SYSTEM and Administrators can read it. |
| Worker | A scheduled task `NothingBotServerWorker` that starts at boot as SYSTEM and restarts after a crash. It waits until a Firebase key exists, starts Ollama if needed, and logs to `data\worker.log`. |
| Console | A second task, `NothingBotServerConsole`, serves the server console on port 7420 (log: `data\console.log`). |
| Updates | A third task, `NothingBotServerUpdate` (SYSTEM, no trigger), started by the console to update the server or turn the local model on or off. It runs `update.ps1`, which runs the release's `deploy\windows\update-core.ps1`. |
| Firewall | An inbound rule "Nothing BOT Curate Console" for TCP 7420, **private networks only**. |
| Shortcuts | **Nothing BOT Server Console** and **Nothing BOT Curate** on the desktop (all users) and in the Start menu. They open in an Edge app window when Edge is installed. |
| Power | No standby or hibernate on power, and closing the lid on power does nothing. |

At the end the console opens and the installer prints a link for a phone on the same Wi-Fi.

## Finish setup in the console

1. Click **Connect with Nothing BOT Curate**, open the link (or scan the QR with your phone), sign in with Google as an admin, check the 4-character code and approve. The worker starts by itself and your email is added as an admin, so the server shows in the app under **Account, Server**. A join code from the app works too; a key file is only for the very first server of a brand-new project (**First server ever?**).
2. Optional: under **AI models**, add a Gemini key (it is checked with Google before it is saved), pick and test models, or turn the local model on or off.
3. Open **Nothing BOT Curate** from the desktop, go to **Settings, Show QR code**, and scan it from WhatsApp on your phone (**Linked devices**).

## Everyday

Day to day you manage the server from the app (**Account, Server**: health, logs, restart buttons), from anywhere. On the PC itself, these files are in the unzipped folder:

| File | What it does |
|---|---|
| **Open Server Console.cmd** | Opens `http://localhost:7420` (same as the desktop shortcut). |
| **View Logs.cmd** | Follows the live worker log. Closing the window doesn't stop the worker. |
| **Restart Worker.cmd** | Stops the worker and its browsers. The boot task starts it again within 10 seconds. |
| **Uninstall.cmd** | Removes the tasks, shortcuts, firewall rule and program files, for this server and for an old pre-rename Spot Solutions install. Keeps your data. |

To stop or start it from PowerShell as Administrator:

```powershell
Stop-ScheduledTask NothingBotServerWorker
Start-ScheduledTask NothingBotServerWorker
```

Stopping is safe. WhatsApp closes cleanly and a backup of the login is saved. When the worker starts again it reconnects without a QR code.

## Where things live

Everything is under `C:\NothingBotServer`.

| Path | What's in it |
|---|---|
| `app\` | The code. Settings are in `app\apps\worker\.env`. |
| `data\` | `service-account.json` (the key), `worker.log`, `console.log`, `console-token`. Can be moved to another drive: see below. |
| `data\wwebjs\` | WhatsApp logins (`session-<uid>`), the server id (`server.json`) and login-backup markers. |
| `node\`, `ollama\`, `chrome\` | Node.js, the Gemma models, Chrome. |
| `run-worker.ps1`, `run-console.ps1` | The launchers the tasks run. |

## Moving the data to another drive

When `C:` is nearly full (WhatsApp can lose its login when it can't save it), keep the data on another drive. Open the console, **Storage**, type the new folder (for example `D:\NothingBotServer\data`), tick **Also move the AI models** if you want the Gemma files (several GB) moved too, press **Check folder**, then **Move data**.

What happens, with progress in the console: the worker (and Ollama, for models) stops and any browser it left behind is closed; everything is **copied** (never moved) to the new folder, then checked file by file (sizes, the WhatsApp login and backup folders, the key and token byte for byte); only then is the new folder switched on (`.env`, the two launcher scripts, `OLLAMA_MODELS`, and the file `C:\NothingBotServer\data-dir.txt` that the installer and the updater read, so neither puts the data back on `C:`); the worker restarts and the console waits for every WhatsApp account to be ready again, with no QR. If any step fails it switches back to the old folder, restarts, removes the half-made copy and says what went wrong. Only after it worked does **Delete the old copy** appear, as its own button.

The folder must be on a local NTFS drive (not a network share, not FAT32), outside `C:\NothingBotServer\app`, empty or new, with room for the data plus 1 GB. It is locked to SYSTEM and Administrators like the original. The Windows long-path setting is switched on so WhatsApp's deep browser folders copy cleanly. If the drive is unplugged later, the worker waits and the installer tells you to plug it back in.

The console also warns at the top when the data drive has under 2 GB free, with a **Move data…** shortcut.

## Update

The Console shortcut uses the Nothing BOT Server icon (`nbs-server.ico`, shipped in the code and the zip). An update copies it to `C:\NothingBotServer` and points an existing Console shortcut at it; Windows may need a sign-out or an icon-cache refresh to show it.

The server updates itself: the console checks every 30 minutes and installs a release a few minutes after it appears (switch off under **Updates**), or press **Update now** (or **Update** on the Server page of the app). Nothing needs an admin prompt: the update runs as the SYSTEM task above. A PC installed before this release needs the manual route once, which is to run the installer again. Re-running is safe: it stops the old worker and its browsers, updates the code, keeps your key, `.env` and WhatsApp logins, and restarts the tasks. It keeps the last choice between local model and Gemini-only unless you set `NBS_NO_LOCAL_MODEL`.

Use the PowerShell one-liner, or download the zip again. The `.cmd` in an old unzipped folder runs the `install.ps1` stored next to it, which may be out of date.

If you run other servers too, stop any that are still on an older release first, see [multi-server.md](multi-server.md).

## Uninstall

Double-click **Uninstall.cmd** (in the unzipped folder). It stops the worker and console, removes the scheduled tasks, the firewall rule, the shortcuts and the program files (`app`, `node`, `chrome`), for this server **and** for an old pre-rename "Spot Solutions" server if one is still on the PC. It **keeps** the data folder (`C:\NothingBotServer\data`), the AI models and a data folder you moved to another drive, and prints what it kept. To delete the data too, run this in PowerShell as Administrator from the unzipped folder: `.\uninstall.ps1 -DeleteData` (a data folder on another drive is never deleted by it). Ollama itself stays installed (remove it from Settings, Apps). On your phone, remove the old entry under **WhatsApp, Linked devices**.

## If something's off

| Symptom | Fix |
|---|---|
| App says "Server offline" | Check the PC is on and online. Double-click **Restart Worker.cmd**, then **View Logs.cmd**. |
| Nothing starts after install | The worker waits until the server is connected. Click **Connect with Nothing BOT Curate** in the console (or enter a join code from the app). |
| The installer says it can't install Ollama | Install it from ollama.com/download, then run the installer again. |
| The installer says to run as Administrator | Use the `.cmd` and click Yes on the prompt, or open PowerShell as Administrator. |
| Console doesn't open from a phone | The PC must be on the same Wi-Fi, and that network set to **Private**. Use the link the installer printed. |
| Very slow replies | Switch to a smaller model under **Settings, AI models**, or add a Gemini key. |
| QR never appears | Wait a minute after starting, then check the log in **View Logs.cmd** and restart the worker. |
