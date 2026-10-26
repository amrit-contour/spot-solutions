# Moving to Nothing BOT Server

The self-hosted server used to be called "Spot Solutions" (and "Spot Server" on the Mac). It is now **Nothing BOT Server** everywhere: the Mac app, the Windows folder, the Linux services, the downloads and the settings names. The web app is called Nothing BOT Curating. This page has the naming scheme, how old servers are kept apart from new ones, and how to move your own server across without a new QR code.

## The naming scheme

One name, written three ways. Use the right one for the place.

| Form | Where it is used |
| --- | --- |
| **Nothing BOT Server** (display) | Anything a person reads: app and window names, menu items, page text, shortcuts, the firewall rule. |
| **NothingBotServer** (PascalCase id) | Windows and Mac folders and files: `C:\NothingBotServer`, `~/Library/Application Support/NothingBotServer`, scheduled tasks `NothingBotServerWorker`, `NothingBotServerConsole`, `NothingBotServerUpdate`, the downloads `NothingBotServer-Windows.zip` and `NothingBotServer-mac.zip`. |
| **nothing-bot-server** (kebab id) | Linux and web: systemd units `nothing-bot-server-worker`, `nothing-bot-server-console`, `nothing-bot-server-task@`; `/opt/nothing-bot-server`, `/var/lib/nothing-bot-server`, `/etc/nothing-bot-server`, `/usr/local/lib/nothing-bot-server`; the download `dl/nothing-bot-server.tar.gz` and its release file `dl/nothing-bot-server.json`. |
| **app.nothingbot.server** (reverse-DNS id) | macOS: bundle id `app.nothingbot.server`; launchd labels `app.nothingbot.server.worker`, `.console`, `.ollama`, `.update`. |

| What | Before | Now |
| --- | --- | --- |
| Mac app | `Spot Server.app` | `Nothing BOT Server.app` (binary `NothingBotServer`) |
| Mac data and program folder | `~/Library/Application Support/SpotSolutions` | `~/Library/Application Support/NothingBotServer` |
| Mac launch agents | `com.spotsolutions.*` | `app.nothingbot.server.*` |
| Control command | `spotctl` (Mac), `spot-task` (Ubuntu) | `nbsctl` on both ("Nothing BOT Server control": short, one name to remember; it does different jobs on each system but is always "the thing that controls the server") |
| Windows folder | `C:\SpotSolutions` | `C:\NothingBotServer` |
| Windows tasks | `SpotSolutionsWorker`, `...Console`, `...Update` | `NothingBotServerWorker`, `...Console`, `...Update` |
| Windows firewall rule | "Spot Solutions Console" | "Nothing BOT Server Console" |
| Windows shortcuts | "Spot Server Console", Start menu folder "Spot Solutions" | "Nothing BOT Server Console", Start menu folder "Nothing BOT Server" (the "Nothing BOT Curating" shortcut opens the web app) |
| Windows installers | `Install Spot Solutions.cmd` | `Install Nothing BOT Server.cmd` (and `... (Gemini only).cmd`) |
| Linux services | `spot-worker`, `spot-console`, `spot-task@` | `nothing-bot-server-worker`, `nothing-bot-server-console`, `nothing-bot-server-task@` |
| Linux paths | `/opt/spot-solutions`, `/var/lib/spot-solutions`, `/etc/spot-solutions`, `/usr/local/lib/spot-solutions` | the same with `nothing-bot-server` |
| Linux service user | `spot` | `nbs` |
| Console link helper | `spot-console-url` | `nbs-console-url` |
| Settings (`.env`, service definitions) | `SPOT_*` | `NBS_*` (the old `SPOT_*` names still work as a fallback, see below) |
| Downloads | `dl/spot-solutions.tar.gz`, `SpotSolutions-Windows.zip`, `SpotServer-mac.zip`, `dl/version.json` | `dl/nothing-bot-server.tar.gz`, `NothingBotServer-Windows.zip`, `NothingBotServer-mac.zip`, `dl/nothing-bot-server.json` |
| Where servers update from | `https://spot-solutions.web.app` | `https://nothingbotcurating.web.app` (`DIST_BASE`, or `NBS_DIST_URL` to override) |

**Not renamed on purpose:** the code packages (`@spot/*`), Firestore collections and paths, Storage paths (`vault/...`), Firebase and IAM names (project `spot-solutions`, service accounts `spot-<device>` and `spot-enroller`), the key folder `~/.spot-keys`, and command names. Nothing on the cloud side changes, which is why a new server can pick up where an old one stopped.

### `SPOT_*` still works

Every setting now reads `NBS_*`. At start the worker, the console, the installers and `nbsctl` copy any `SPOT_X` they find into `NBS_X` when `NBS_X` isn't set, so an old `.env` or service file keeps working. `NBS_X` always wins. When the console saves a setting it also drops the old `SPOT_X` line.

## Old servers are frozen, not updated

Servers installed before the rename (release `3c43570` and earlier) check `https://spot-solutions.web.app/dl/version.json` and download `/dl/spot-solutions.tar.gz`. The renamed release would run against their old folders and services and break them, so they must never be offered it.

- Every hosting site serves the same `apps/web/dist`. `deploy/build-dist.sh` copies the **frozen legacy files** from the gitignored folder `deploy/legacy-dl/` into `dist/dl/` on every build: `version.json`, `spot-solutions.tar.gz`, `SpotSolutions-Windows.zip`, `SpotServer-mac.zip`. They are byte for byte what the live site served when the rename was prepared (`version` `3c43570`), so old servers keep seeing "up to date".
- The build **fails loudly** if one is missing, if `version.json` isn't valid, or if the tarball no longer matches the sha256 in it. If the folder is lost, recover the files from a backup (or from the live site while it still serves them), never from a new build.
- New files use new names (`dl/nothing-bot-server.json`, `dl/nothing-bot-server.tar.gz`, ...), so the two sets can never collide. New servers read `dl/nothing-bot-server.json` from `nothingbotcurating.web.app`.
- The install addresses at the site root (`install.sh`, `install.ps1`, `install-mac.sh`) always serve the **new** installers, on every site. Old servers never re-run an installer, so they are unaffected; a fresh install always gets the new layout.
- The Server page in the app compares each server's version with the latest new release, so an old server shows as out of date. That is true; reinstall it (below) instead of pressing Update.

## Moving your own server

Plan: install the new server, connect it to the same account. It downloads the encrypted login from the cloud vault and starts WhatsApp **without a QR code**. A local backup is only a safety net.

### Why no QR is needed

Each account's WhatsApp login is uploaded to the vault (Storage `vault/`, key in `vaultKeys/`, newest copy wins, see [fleet.md](fleet.md)). A new server that is connected to the same account asks "who has the newest login?" before it starts WhatsApp, sees the vault copy, restores it and starts. This needs a vault copy that is newer than the last time the old server changed the login, which is why the migration script forces a fresh upload first. A clean stop of the worker (what the script does) always uploads, and releases the account's lease.

### The steps, on the Mac that runs your server

```bash
bash deploy/migrate/migrate-mac.sh
# or:  curl -fsSL https://nothingbotcurating.web.app/migrate-mac.sh | bash
```

It prints plain output, one step at a time, and changes nothing permanent:

1. **Is this Mac the holder?** It reads the account lease (`users/{uid}/fleet/lease`) with this server's own key, the way the worker does, and checks that this Mac's server id holds it. If it can't read the cloud (no key, program files missing) it asks you to confirm in the app (Account, Server, Fleet). If another server holds the account, it stops and tells you.
2. **Clean stop.** It unloads the launch agents. The worker gets SIGTERM, closes WhatsApp, uploads every login to the vault (`gen + 1`) and releases the lease. It waits until the worker has exited.
3. **Verify.** It reads `users/{uid}/fleet/vault` (and `vault_agent` if you linked an agent number) and waits up to 4 minutes (`--timeout`) until `gen` is higher than before and `savedAt` is later than the start of the run, for every account. If not, it says **do not uninstall yet**.
4. **Local backup.** `~/NothingBotServer-backup-<date>.tar.gz` (mode 600, with a `.sha256` next to it): the `session-*` folders (without Chromium caches), the `vault-*.json` markers, `server.json`, `console.json` and the non-secret settings from `.env`. The Firebase key is left out unless you pass `--include-key`. It reads the archive back to check it. The server is stopped while it is copied, so the copy is consistent.
5. **Next steps**, printed: how to uninstall the old server on Mac, Windows and Ubuntu, and the new install commands.

Options: `--restart-after` (start the old server again if you are not moving yet), `--include-key`, `--timeout SECONDS`, `--yes`.

Then:

| Step | Mac | Windows | Ubuntu |
| --- | --- | --- | --- |
| Uninstall the old server | The new installer stops and removes it for you. Or **Spot Server, More, Uninstall**, or run `spotctl uninstall` from inside the old app. | PowerShell as Administrator: `irm https://nothingbotcurating.web.app/uninstall.ps1 \| iex` | `curl -fsSL https://nothingbotcurating.web.app/uninstall.sh \| sudo bash` |
| Install the new server | `curl -fsSL https://nothingbotcurating.web.app/install.sh \| bash` | `Set-ExecutionPolicy -Scope Process Bypass -Force; irm https://nothingbotcurating.web.app/install.ps1 \| iex` | `curl -fsSL https://nothingbotcurating.web.app/install.sh \| sudo bash` |

Then open the new server's console, click **Connect with Nothing BOT Curating**, sign in as an admin and approve. In the app, **Settings, WhatsApp** should show the account running again with no QR. Afterwards, remove the old server in **Account, Server** so its key is revoked.

### Uninstallers

All three uninstallers remove **both** the new and the old pieces (tasks, shortcuts, launch agents or units, program folders, firewall rule, the old Mac app, the old service accounts) and print what they kept.

- To pass the flag to the Windows uninstaller straight from the web, use `& ([scriptblock]::Create((irm https://nothingbotcurating.web.app/uninstall.ps1))) -DeleteData` (without the flag it keeps the data).
- They **keep your data folders** (WhatsApp login, keys, settings) and the Ollama models unless you pass a flag: `nbsctl uninstall --all` (Mac), `uninstall.ps1 -DeleteData` (Windows), `uninstall.sh --delete-data` (Ubuntu).
- A data folder you moved to another disk is never deleted automatically, even with the flag.
- The new installers also stop an old server on the same machine (so two servers never share one WhatsApp login) and keep its data.

### If the new server shows a QR code

That means the vault copy was missing or didn't restore. Use the backup, on the new Mac install:

```bash
bash deploy/migrate/restore-backup.sh ~/NothingBotServer-backup-2026-10-27.tar.gz
# or:  curl -fsSL https://nothingbotcurating.web.app/restore-backup.sh | bash -s -- <file>
```

It checks the checksum, stops the server, moves whatever is in the new data folder aside (never deletes it), puts the saved logins back (including `vault-*.json` and `server.json`, so the server keeps its fleet id), and adds the settings the new `.env` doesn't have yet (admin emails, Gemini key, AI mode). Then start the server. The worker uses the local login if it is at least as new as the vault, and uploads it within a minute of WhatsApp being ready. `--data-dir DIR` restores somewhere else (data on another drive). Delete the backup once the new server has run fine for a few days: it holds your WhatsApp login.

### Windows and Ubuntu servers

Those have no script of their own: stop the service (`Stop-ScheduledTask NothingBotServerWorker` or `SpotSolutionsWorker`; `sudo systemctl stop spot-worker`), which does the same clean upload, check **Settings, WhatsApp** says "Login backed up" a minute ago, then uninstall and install as above. Copy the data folder somewhere first if you want a backup.

## Needs a real machine

The scripts were checked for syntax and run against a fake home folder, not on every platform. Before relying on them, run once on a real Windows PC (`install.ps1`, `uninstall.ps1`, the `.cmd` files) and a real Ubuntu box (`install.sh`, `uninstall.sh`, the `nbsctl` helper, systemd units), including installing over an old server.
