# Run the server on a Mac

**Spot Server** is a small Mac app that turns any Mac (Apple Silicon or Intel, macOS 13+) into the Spot Solutions server: WhatsApp sessions, local Gemma and the server console, running in the background.

## Install

Easiest, in Terminal:

```bash
curl -fsSL https://spot-solutions.web.app/install-mac.sh | bash
```

Or download [SpotServer-mac.zip](https://spot-solutions.web.app/dl/SpotServer-mac.zip), double-click it, drag **Spot Server** into Applications, then open it. The first time macOS says it can't verify the developer: open **System Settings → Privacy & Security** and click **Open Anyway**. (The app isn't notarized by Apple; the Terminal install avoids this prompt.)

## Set up

1. Open **Spot Server** and type your email.
2. Click **Set up this Mac**. It downloads Node.js, Ollama and Gemma (about 3.5 GB) into `~/Library/Application Support/SpotSolutions`. It needs no Homebrew and no admin password. If Ollama is already running on the Mac, it uses that.
3. The server console appears inside the app. Drop in your Firebase service-account key there; the worker starts by itself.
4. Link WhatsApp at spot-solutions.web.app → Settings.

## Everyday

| In the app | What it does |
|---|---|
| **Start server / Stop server** | Starts or stops Ollama, the worker and the console |
| **Keep awake, even with the lid closed** | Turns off sleep (asks for your password once). Turn it off to restore normal sleep. |
| **Start when I log in** | Brings the server back after a restart |
| Menu bar 🎙 | Status, start/stop, open the app. Closing the window doesn't stop the server. |
| More → Update / Restart / Uninstall | Updates the code, restarts a part, or removes it (keeping your WhatsApp session and keys) |

From Terminal, the same controls are in `spotctl` inside the app:

```bash
"/Applications/Spot Server.app/Contents/Resources/spotctl" status
```

## For a Mac that stays on

- Keep it on power, and turn on **Keep awake, even with the lid closed**.
- macOS runs background services only while you're logged in. For an always-on Mac, turn on **automatic login** (System Settings → Users & Groups) together with **Start when I log in**. Don't use FileVault automatic login on a Mac others can reach.
