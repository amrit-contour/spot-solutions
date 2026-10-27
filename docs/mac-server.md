# Run the server on a Mac

**Nothing BOT Server** is a small Mac app that turns any Mac (Apple Silicon or Intel, macOS 13+) into the Nothing BOT Server: WhatsApp sessions, local Gemma and the server console, running in the background.

## Install

Easiest, in Terminal:

```bash
curl -fsSL https://nothingbotcurating.web.app/install-mac.sh | bash
```

Or download [NothingBotServer-mac.zip](https://nothingbotcurating.web.app/dl/NothingBotServer-mac.zip), double-click it, drag **Nothing BOT Server** into Applications, then open it. The first time macOS says it can't verify the developer: open **System Settings → Privacy & Security** and click **Open Anyway**. (The app isn't notarized by Apple; the Terminal install avoids this prompt.)

## Set up

1. Open **Nothing BOT Server** and type your email.
2. Click **Set up this Mac** (the Terminal install command already did this). It downloads Node.js and, on a Mac with about 8 GB of memory or more, Ollama and Gemma (about 3.5 GB) into `~/Library/Application Support/NothingBotServer`. It needs no Homebrew and no admin password. If Ollama is already running on the Mac, it uses that.
3. The server console appears inside the app. Click **Connect with Nothing BOT Curating**, open the link (or scan the QR with your phone), sign in with Google, check the 4-character code and approve. The worker starts by itself, with a key made for this Mac only, and your email becomes one of its admins. A join code from the app (**Account, Server, Add a server**) works too, and **First server ever? Use a key file** is for a brand-new project (see [multi-server.md](multi-server.md)).
4. Link WhatsApp at spot-solutions.web.app → Settings → Show QR code.

**Local model or Gemini only.** A Mac with little memory (under about 8 GB) starts on Gemini, and any Mac can switch in the console under **AI models** (**Local model on this computer**, with progress). Add a Gemini key there, or each curator under Settings → AI models. A Gemini-only server can't host accounts set to **Local only**. From Terminal: `nbsctl local on` or `nbsctl local off`. Updates keep the choice.

## Everyday

| In the app | What it does |
|---|---|
| **Start server / Stop server** | Starts or stops Ollama, the worker and the console |
| **Keep awake, even with the lid closed** | Turns off sleep (asks for your password once). Turn it off to restore normal sleep. |
| **Start when I log in** | Brings the server back after a restart |
| Menu bar icon | Status, start/stop, open the app. Closing the window doesn't stop the server. |
| More → Update / Restart / Uninstall | Updates the code, restarts the worker or Ollama, or removes it (keeping your WhatsApp session and keys) |

From Terminal, the same controls are in `nbsctl` inside the app:

```bash
"/Applications/Nothing BOT Server.app/Contents/Resources/nbsctl" status
```

| Command | What it does |
|---|---|
| `nbsctl setup` | Installs or updates (re-run to update) |
| `nbsctl update` | Updates to the latest release (checksum-verified), restarts the worker and console on it, refreshes the model. What the console's **Update now** runs |
| `nbsctl local on\|off` | Turns the local model on or off |
| `nbsctl start` / `stop` | Starts or stops Ollama, the worker and the console |
| `nbsctl restart [worker\|ollama\|console]` | Restarts one part, or all |
| `nbsctl awake on\|off` | Keep running with the lid closed (asks for your password) |
| `nbsctl login on\|off` | Start the server when you log in |
| `nbsctl logs` | Follows the worker log |
| `nbsctl uninstall [--all]` | Removes the code, launch agents and logs (and the old "Nothing BOT Server" app and launch agents if present); keeps your data and says where it is. `--all` also deletes your WhatsApp session and keys |

Everything lives in `~/Library/Application Support/NothingBotServer` (`app`, `data` with the key and WhatsApp logins, `logs`, `runtime`).

## Moving the data to an external drive

In the console, **Storage**, type the new folder (for example `/Volumes/Backup HDD/NothingBotServer/data`) and press **Check folder**, then **Move data**. The worker stops, everything is copied and checked, the launch agents are rewritten to use the new folder (`nbsctl apply`, from the `data-dir` file in `~/Library/Application Support/NothingBotServer`, which every `nbsctl` run reads, so updates and re-running setup keep it), the worker and console restart, and the console waits for WhatsApp to be ready again. Any failure switches back to the old folder. **Delete the old copy** appears only afterwards. Use an APFS or Mac OS Extended drive, and keep it connected: the server can't start without it.

## Updating

The server updates itself: the console checks every 30 minutes and installs a new release a few minutes after it appears (turn that off under **Updates** in the console), or press **Update now** there or **Update** on the Server page of the app. A Mac set up before this release needs one manual update first: **More → Update Nothing BOT Server**, or run the install command again. Either keeps your key and WhatsApp session. If you run several servers, stop any still on an older release first, see [multi-server.md](multi-server.md).

**The app's own icon is not part of an update.** Updates replace the server code in `~/Library/Application Support/NothingBotServer/app` (the console page, its favicon and logo included). The app in `/Applications` (Dock icon, window header, menu bar) is never replaced by an update, because re-signing or swapping a running app from a background job is not safe. A Mac installed before the server-rack icon keeps the old Dock icon until you run the install command above once more (it replaces the app and keeps your data).

## For a Mac that stays on

- Keep it on power, and turn on **Keep awake, even with the lid closed**. With a second server in the fleet, an account moves there if this Mac goes to sleep or offline (see [multi-server.md](multi-server.md)).
- macOS runs background services only while you're logged in. For an always-on Mac, turn on **automatic login** (System Settings → Users & Groups) together with **Start when I log in**. Don't use FileVault automatic login on a Mac others can reach.
