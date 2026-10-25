SPOT SOLUTIONS - WINDOWS SERVER
================================

Turns this laptop into the always-on Spot Solutions server: WhatsApp + local Gemma.

BEFORE YOU START
  - Windows 10 or 11, 8 GB RAM recommended, plugged into power, on Wi-Fi/Ethernet.
  - Have your Firebase service-account key (.json) on this laptop, e.g. in Downloads.
    Get it: console.firebase.google.com -> your project -> gear icon -> Project settings
    -> Service accounts -> Generate new private key.
  - "App Installer" (winget) must be present. It is on most Windows 10/11 machines;
    if not, install it from the Microsoft Store.

INSTALL
  1. Unzip this folder anywhere.
  2. Double-click "Install Spot Solutions.cmd" and click Yes on the admin prompt.
     It installs Node.js and Ollama, downloads Gemma (~3.3 GB), and sets up two
     startup tasks: the worker and the Server Console. It asks you nothing.
  3. The Server Console opens (also on your desktop as "Spot Server Console"):
     - drop in your Firebase service-account key (.json). Get it at
       console.firebase.google.com -> project -> gear -> Project settings ->
       Service accounts -> Generate new private key. The worker starts by itself.
     - add your email under Admins, so the server shows in the app (Account -> Server).
  4. Open "Spot Solutions" on the desktop -> Settings -> Show QR code, and scan it
     from WhatsApp on your phone.

Everything starts by itself at boot (even before anyone logs in), restarts if it
crashes, and the laptop never sleeps on power, even with the lid closed.
Day to day you manage it from the app (Account -> Server: health, logs, restarts),
from anywhere. The console is only reachable on this laptop and your home Wi-Fi.

EVERYDAY
  Open Server Console.cmd - status, logs, keys (same as the desktop shortcut)
  View Logs.cmd           - raw worker log
  Restart Worker.cmd      - restart it if something looks stuck
  Uninstall.cmd           - stop it, remove tasks and shortcuts (keeps your data)

Files live in C:\SpotSolutions (app\ = code, data\ = WhatsApp session, key, logs).
To update, run "Install Spot Solutions.cmd" again.
