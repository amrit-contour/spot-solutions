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
  3. It installs Node.js, Git, Ollama and the Gemma model (about 3.5 GB download).
  4. A file picker opens: choose the .json key. (The project ID is read from it.)
     Then type your email so this server shows up under Account -> Server in the app.
  5. When it says Done, open https://spot-solutions.web.app on any computer
     -> Settings -> Show QR code, and scan it from WhatsApp on your phone.

It starts by itself at every boot (even before anyone logs in), restarts if it
crashes, and the laptop is set to never sleep on power, even with the lid closed.

EVERYDAY
  View Logs.cmd       - watch what the worker is doing
  Restart Worker.cmd  - restart it if something looks stuck
  Uninstall.cmd       - stop it and remove the startup task (keeps your data)

Files live in C:\SpotSolutions (app\ = code, data\ = WhatsApp session, key, log).
To update, run "Install Spot Solutions.cmd" again.
