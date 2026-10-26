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
3. The server console appears inside the app. Type the join code an admin made in the app (**Account, Server, Add a server**) under **Enter join code**, check the device name and click **Join**. The worker starts by itself, with a key made for this Mac only. Without a code, click **or drop a key file** and drop a key made with `deploy/new-server-key.sh <name>` (see [multi-server.md](multi-server.md)), then delete the file.
4. Link WhatsApp at spot-solutions.web.app → Settings → Show QR code.

**Gemini only.** A Mac with little memory can skip the local model. Tick **Gemini only** before **Set up this Mac**: it downloads Node.js only, and AI runs on Gemini (add a Gemini key in the console, or each curator under Settings → AI models). That server can't host accounts set to **Local only**. From Terminal: `SPOT_NO_LOCAL_MODEL=1 spotctl setup`; switch back with `SPOT_NO_LOCAL_MODEL=0 spotctl setup`. Updates keep the choice.

## Everyday

| In the app | What it does |
|---|---|
| **Start server / Stop server** | Starts or stops Ollama, the worker and the console |
| **Keep awake, even with the lid closed** | Turns off sleep (asks for your password once). Turn it off to restore normal sleep. |
| **Start when I log in** | Brings the server back after a restart |
| Menu bar icon | Status, start/stop, open the app. Closing the window doesn't stop the server. |
| More → Update / Restart / Uninstall | Updates the code, restarts the worker or Ollama, or removes it (keeping your WhatsApp session and keys) |

From Terminal, the same controls are in `spotctl` inside the app:

```bash
"/Applications/Spot Server.app/Contents/Resources/spotctl" status
```

| Command | What it does |
|---|---|
| `spotctl setup` | Installs or updates (re-run to update) |
| `spotctl start` / `stop` | Starts or stops Ollama, the worker and the console |
| `spotctl restart [worker\|ollama\|console]` | Restarts one part, or all |
| `spotctl awake on\|off` | Keep running with the lid closed (asks for your password) |
| `spotctl login on\|off` | Start the server when you log in |
| `spotctl logs` | Follows the worker log |
| `spotctl uninstall [--all]` | Removes the code and services; `--all` also removes your WhatsApp session and keys |

Everything lives in `~/Library/Application Support/SpotSolutions` (`app`, `data` with the key and WhatsApp logins, `logs`, `runtime`).

## Updating

In the app: **More → Update Spot Solutions**, or run `spotctl setup` again. It keeps your key and WhatsApp session. If you run several servers, stop any still on an older release first, see [multi-server.md](multi-server.md).

## For a Mac that stays on

- Keep it on power, and turn on **Keep awake, even with the lid closed**. With a second server in the fleet, an account moves there if this Mac goes to sleep or offline (see [multi-server.md](multi-server.md)).
- macOS runs background services only while you're logged in. For an always-on Mac, turn on **automatic login** (System Settings → Users & Groups) together with **Start when I log in**. Don't use FileVault automatic login on a Mac others can reach.
