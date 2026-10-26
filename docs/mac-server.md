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
2. Click **Set up this Mac** (the Terminal install command already did this). It downloads Node.js and, on a Mac with about 8 GB of memory or more, Ollama and Gemma (about 3.5 GB) into `~/Library/Application Support/SpotSolutions`. It needs no Homebrew and no admin password. If Ollama is already running on the Mac, it uses that.
3. The server console appears inside the app. Click **Connect with Spot Solutions**, open the link (or scan the QR with your phone), sign in with Google, check the 4-character code and approve. The worker starts by itself, with a key made for this Mac only, and your email becomes one of its admins. A join code from the app (**Account, Server, Add a server**) works too, and **First server ever? Use a key file** is for a brand-new project (see [multi-server.md](multi-server.md)).
4. Link WhatsApp at spot-solutions.web.app → Settings → Show QR code.

**Local model or Gemini only.** A Mac with little memory (under about 8 GB) starts on Gemini, and any Mac can switch in the console under **AI models** (**Local model on this computer**, with progress). Add a Gemini key there, or each curator under Settings → AI models. A Gemini-only server can't host accounts set to **Local only**. From Terminal: `spotctl local on` or `spotctl local off`. Updates keep the choice.

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
| `spotctl update` | Updates to the latest release (checksum-verified), restarts the worker and console on it, refreshes the model. What the console's **Update now** runs |
| `spotctl local on\|off` | Turns the local model on or off |
| `spotctl start` / `stop` | Starts or stops Ollama, the worker and the console |
| `spotctl restart [worker\|ollama\|console]` | Restarts one part, or all |
| `spotctl awake on\|off` | Keep running with the lid closed (asks for your password) |
| `spotctl login on\|off` | Start the server when you log in |
| `spotctl logs` | Follows the worker log |
| `spotctl uninstall [--all]` | Removes the code and services; `--all` also removes your WhatsApp session and keys |

Everything lives in `~/Library/Application Support/SpotSolutions` (`app`, `data` with the key and WhatsApp logins, `logs`, `runtime`).

## Updating

The server updates itself: the console checks every 30 minutes and installs a new release a few minutes after it appears (turn that off under **Updates** in the console), or press **Update now** there or **Update** on the Server page of the app. A Mac set up before this release needs one manual update first: **More → Update Spot Solutions**, or run the install command again. Either keeps your key and WhatsApp session. If you run several servers, stop any still on an older release first, see [multi-server.md](multi-server.md).

## For a Mac that stays on

- Keep it on power, and turn on **Keep awake, even with the lid closed**. With a second server in the fleet, an account moves there if this Mac goes to sleep or offline (see [multi-server.md](multi-server.md)).
- macOS runs background services only while you're logged in. For an always-on Mac, turn on **automatic login** (System Settings → Users & Groups) together with **Start when I log in**. Don't use FileVault automatic login on a Mac others can reach.
