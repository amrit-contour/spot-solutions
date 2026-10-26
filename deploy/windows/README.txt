NOTHING BOT SERVER - WINDOWS
=======
====================

Turns this laptop into the always-on Nothing BOT Server: WhatsApp + local Gemma.

BEFORE YOU START
  - Windows 10 or 11, 8 GB RAM recommended, plugged into power, on Wi-Fi/Ethernet.
  - Have this laptop's own service-account key (.json) on it, e.g. in Downloads.
    Make one per device on the admin's Mac: bash deploy/new-server-key.sh <name>
    (it lands in ~/.spot-keys/). Revoke it later with deploy/revoke-server-key.sh.
  - "App Installer" (winget) is used to install Ollama. It is on most Windows 10/11
    machines; if not, install it from the Microsoft Store (not needed for Gemini only).

INSTALL
  1. Unzip this folder anywhere.
  2. Double-click "Install Nothing BOT Server.cmd" and click Yes on the admin prompt.
     It installs its own Node.js (C:\NothingBotServer\node) and Ollama, downloads Gemma (~3.5 GB), and sets up two
     startup tasks: the worker and the Server Console. It asks you nothing.
     No room for Gemma (under ~8 GB RAM)? Double-click "Install Nothing BOT Server (Gemini
     only).cmd" instead: no Ollama, no download; AI runs on Gemini (add a key in the
     console or the app). That server can't host accounts set to "Local only".
  3. The Server Console opens (also on your desktop as "Nothing BOT Server Console"):
     - drop in this laptop's own Firebase key (.json). One key per device: on the admin's
       Mac run deploy/new-server-key.sh <name> (see the Server guide, "Running several
       servers"). The worker starts by itself.
     - add your email under Admins, so the server shows in the app (Account -> Server).
  4. Open "Nothing BOT Curating" on the desktop -> Settings -> Show QR code, and scan it
     from WhatsApp on your phone.

Everything starts by itself at boot (even before anyone logs in), restarts if it
crashes, and the laptop never sleeps on power, even with the lid closed.
Day to day you manage it from the app (Account -> Server: health, logs, restarts),
from anywhere. The console is only reachable on this laptop and your home Wi-Fi.

EVERYDAY
  Open Server Console.cmd - status, logs, keys (same as the desktop shortcut)
  View Logs.cmd           - raw worker log
  Restart Worker.cmd      - restart it if something looks stuck
  Uninstall.cmd           - stop it, remove tasks, shortcuts and program files (keeps your data;
                          also removes the old Spot Solutions server if present)

Files live in C:\NothingBotServer (app\ = code, data\ = WhatsApp session, key, logs).
To update, run "Install Nothing BOT Server.cmd" again.
