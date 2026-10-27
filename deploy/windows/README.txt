NOTHING BOT SERVER - WINDOWS
============================

Turns this laptop into the always-on Nothing BOT Server: WhatsApp + local Gemma,
for Nothing BOT Curating (and Nothing BOT Comedy, the comic-side app).

BEFORE YOU START
  - Windows 10 or 11, 8 GB RAM recommended, plugged into power, on Wi-Fi/Ethernet.
  - A Google account that is an admin of your Nothing BOT Curating project. You sign in
    with it in the server console. No key file to download or copy.
  - "App Installer" (winget) is used to install Ollama. It is on most Windows 10/11
    machines; if not, install it from the Microsoft Store (not needed for Gemini only).

INSTALL
  1. Unzip this folder anywhere.
  2. Double-click "Install Nothing BOT Server.cmd" and click Yes on the admin prompt.
     It installs its own Node.js (C:\NothingBotServer\node) and Ollama, downloads Gemma (~3.5 GB), and sets up three
     scheduled tasks: the worker, the Server Console and the updater. It asks you nothing.
     No room for Gemma (under ~8 GB RAM)? Double-click "Install Nothing BOT Server (Gemini
     only).cmd" instead: no Ollama, no download; AI runs on Gemini (add a key in the
     console or the app). That server can't host accounts set to "Local only".
     Same thing without the zip, in PowerShell as Administrator:
       Set-ExecutionPolicy -Scope Process Bypass -Force
       irm https://nothingbotcurating.web.app/install.ps1 | iex
     An old pre-rename "Spot Solutions" install on this PC is stopped and removed
     (its data is kept).
  3. The Server Console opens (also on your desktop as "Nothing BOT Server Console"):
     - Setup: click "Connect with Nothing BOT Curating", open the link (or scan the QR with your phone), sign in with
       Google, check the 4-character code and approve. The worker starts by itself and your email
       becomes an admin, so the server shows in the app (Account -> Server).
       (A join code from the app works too.)
     - Optional, AI models: add a Gemini key (it is checked with Google before it is saved), pick and
       test models, or turn the local model on or off.
  4. Open "Nothing BOT Curating" on the desktop -> Settings -> Show QR code, and scan it
     from WhatsApp on your phone.

Everything starts by itself at boot (even before anyone logs in), restarts if it
crashes, and the laptop never sleeps on power, even with the lid closed.
Day to day you manage it from the app (Account -> Server: health, logs, restarts),
from anywhere. The console is only reachable on this laptop and your home Wi-Fi.

IN THE SERVER CONSOLE
  Setup      - connected / admins / Gemini key, one card per step
  Health     - Check and repair (finds or downloads what the server needs, such as Chrome)
  Services   - Stop and Start for the worker and for Ollama, plus Stop server / Start server.
               A stopped Ollama stays stopped across restarts and updates until you press Start.
  AI models  - Gemini key, model choice and tests, local models, default routing
  Display options (the sliders icon) - theme, NBC or Classic look, customize the page
  Storage    - move the data folder to another drive

EVERYDAY
  Open Server Console.cmd - status, logs, keys (same as the desktop shortcut)
  View Logs.cmd           - raw worker log
  Restart Worker.cmd      - restart it if something looks stuck
  Uninstall.cmd           - stop it, remove tasks, shortcuts and program files (keeps your data;
                          also removes an old Spot Solutions server if present)

Files live in C:\NothingBotServer (app\ = code, data\ = WhatsApp session, key, logs).
The server updates itself from nothingbotcurating.web.app (check every 30 minutes; "Update now"
in the console or the app). To update by hand, run "Install Nothing BOT Server.cmd" again.
