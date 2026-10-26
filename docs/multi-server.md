# Running several servers

You can run as many servers as you like against one Firebase project. Each WhatsApp account runs on one server at a time. If that server goes offline, another one takes the account over with its saved login. Nobody scans a new QR code.

Two servers are worth it if one laptop is all you have between a lineup and a lost weekend. A second server can be a spare Mac, a Windows PC, an Ubuntu box or a cloud VM. This page covers the user side. The protocol is in [fleet.md](fleet.md) and the code design in [architecture.md](architecture.md).

## What failover does

- Each server heartbeats every 30 seconds. A server counts as online if its last heartbeat is under 75 seconds old.
- The server running an account renews a lease on it every 30 seconds.
- If the holder loses internet for 90 seconds, it stops its own WhatsApp, so two servers never run one account.
- After 150 seconds without a renewal, another server may take the account. The best-ranked server claims first. The Nth-ranked one waits N x 20 seconds before trying.
- The new server downloads the encrypted login copy, starts WhatsApp, and replays any commands that were left pending.
- The login copy is uploaded every 10 minutes while the account is running, and also when a server stops cleanly or hands an account over.

These numbers come from `packages/shared/src/fleet.ts`.

| Name | Value |
| --- | --- |
| Lease renewal | 30 s |
| Holder fences itself | 90 s without a renewal |
| Others may claim | 150 s without a renewal |
| Server counts as online | heartbeat under 75 s old |
| Claim stagger | 20 s per rank |
| Login upload | every 10 min |

A hard crash means a gap of a few minutes before the account is back (150 seconds, then the restore and the WhatsApp start). A clean stop is quicker: the server uploads the login and releases its accounts first, so another server can claim them straight away (still staggered by rank).

Which server gets an account, best first: the pinned server, then servers with a local model, then the least loaded, then the newest install. A server stops taking accounts when it reaches its limit. The limit is (memory minus 5.5 GB) / 450 MB with a local model, and (memory minus 1.5 GB) / 450 MB without one. Set `SPOT_MAX_ACCOUNTS` in the worker's `.env` to override it.

## One key per device

Every server needs its own Firebase service-account key. Never copy one key between computers. If a laptop is lost or retired, you revoke its key and the others carry on.

You create keys on your own Mac or Linux machine, with the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) installed and signed in (`gcloud auth login`), from the project folder.

```bash
deploy/new-server-key.sh <device-name> [--dry-run]
deploy/new-server-key.sh studio-mac
```

What it does:

1. Makes a service account named `spot-<device-name>`. The device name is lower-cased and anything but letters, digits and dashes becomes a dash. The full account name must be 6 to 30 characters, so the device name can be at most 25.
2. Gives it only what the worker uses: `roles/datastore.user` (Firestore), `roles/firebasecloudmessaging.admin` (push) on the project, and `roles/storage.objectAdmin` on the default bucket only.
3. Saves the key to `~/.spot-keys/spot-<device-name>.json` (folder mode 700). Set `SPOT_KEY_DIR` to change the folder.

Running it again for the same device adds a fresh key to the same account. `--dry-run` prints the `gcloud` commands and creates nothing. `SPOT_PROJECT` and `SPOT_BUCKET` override the project (default `spot-solutions`) and bucket (default `spot-solutions.firebasestorage.app`). The script is also served at `https://spot-solutions.web.app/new-server-key.sh`.

Put the key on the server:

1. Open that server's console. Mac: inside the Spot Server app. Windows: the **Spot Server Console** desktop shortcut. Ubuntu: run `sudo spot-console-url` and open the link.
2. Drop `spot-<device-name>.json` onto **Drop your service-account .json here**. The worker restarts by itself.
3. Delete the key file from the machine you made it on. It is a password.

To revoke a device:

```bash
deploy/revoke-server-key.sh <device-name> [--dry-run] [--yes]
deploy/revoke-server-key.sh studio-mac
```

It asks you to type the device name, then deletes every key of that account first (so access ends even if a later step fails), removes its roles, and deletes the account. `--yes` skips the question. `--dry-run` shows the commands. The device's worker loses access once its cached token runs out: up to an hour, usually minutes. Other servers take over its accounts as in any failover. Then wipe the device or uninstall Spot Solutions there.

## Gemini-only servers

A computer without room for Gemma (under about 8 GB of memory) can still be a server. Install it without the local model and it answers with Gemini. The installer then skips Ollama and the Gemma download. Add a Gemini key in that server's console (**Server Gemini key**) or let each curator add their own under **Settings, AI models**.

Gemini receives the text of the messages it reads. A Gemini-only server cannot host an account set to **Local only** (see below).

| OS | How |
| --- | --- |
| **Ubuntu / Debian** | `curl -fsSL https://spot-solutions.web.app/install.sh \| sudo SPOT_NO_LOCAL_MODEL=1 bash`. Or pass the flag: `... \| sudo bash -s -- --no-local-model`. If you set neither and run it in a terminal on a first install, it asks once (30 seconds, default is yes to a local model). |
| **Windows** | Double-click `Install Spot Solutions (Gemini only).cmd` instead of the normal one. Or set `$env:SPOT_NO_LOCAL_MODEL = "1"` in the PowerShell window before the one-liner. |
| **macOS** | Tick **Gemini only** in Spot Server before **Set up this Mac**. Or in Terminal: `SPOT_NO_LOCAL_MODEL=1 spotctl setup` (the `spotctl` inside the app, see [mac-server.md](mac-server.md)). |

Re-running an installer keeps whatever the last run chose. To switch a server back to a local model, re-run with `SPOT_NO_LOCAL_MODEL=0` (Windows: `$env:SPOT_NO_LOCAL_MODEL = "0"`; Mac: `SPOT_NO_LOCAL_MODEL=0 spotctl setup`).

## Local only vs Local first

Each curator picks one under **Settings, AI models**.

| Policy | What it means |
| --- | --- |
| **Local first** (default) | Your local model answers. Gemini steps in when it is down, or if you picked it as a model. A server without a local model can host your account. |
| **Local only** | Your chats never reach Gemini. Only a server running a local model (Ollama with at least one model) can host your account, and Gemini routes are switched off for it. |

If a curator uses Local only and no server with Gemma is online, the account waits until one is. Keep at least one Gemma server if anyone uses Local only.

## Pin and Move

Both live in the app. A curator sees the buttons when at least two servers are online.

**Curators:** **Settings**, then the **WhatsApp & app** tab, shows "Running on <server>" and when the login was last backed up.

- **Keep on this server** pins the account. Whenever that server is online, the account stays on it, and if it comes back after an outage the account is pulled back from wherever it went.
- **Stop keeping on this server** unpins it.
- **Move to...** hands the account to another online server. Expect WhatsApp to reconnect in about a minute.

**Admins:** **Account, Server, Fleet** lists every server (load, local model, online) and every approved account. The menu next to an account has **Move to**, **Pin to this server** and **Unpin**.

A move is refused, with a message, if the target is offline, full, draining, or has no local model for an account set to Local only. The account stays where it is.

## What you will see

**Notices** appear as dismissible cards in the app:

- "Your WhatsApp moved from X to Y." After a crash: "...because X stopped responding."
- A warning if an old server is blocking the new ones (see below).

**Push notifications** go to every browser or phone where you turned on **Settings, WhatsApp & app, Notifications on this device**. On iPhone and iPad, add the app to your home screen first.

| Push | When |
| --- | --- |
| Your account moved | An account moved to another server. |
| WhatsApp needs a scan | The login could not be restored and you must link again. |
| A server went offline | A server holding your account stopped responding. Another one takes over shortly. |
| New spot request | Defined, but off by default. |

The Server page and the Settings card also show a server as "isn't responding" once its lease is stale.

## Upgrading safely

Stop any server running an older Spot Solutions release before you link a new one.

Servers from before the fleet release heartbeat but ignore leases: they start every approved account themselves. If one stays on next to a fleet server, both would answer the same chats. So fleet servers check for them. While a server without fleet support is online, every fleet server:

- claims and starts nothing (your WhatsApp is paused on the newer servers),
- logs `[fleet] old server "<hostname>" is running`,
- adds a warning notice for each affected curator, once.

They carry on by themselves once the old server is stopped or updated. In **Account, Server, Fleet**, an old server shows "Older version: it doesn't report capacity yet. Update it to join the fleet."

To update a server, run its installer again (see the guide for [Mac](mac-server.md), [Windows](windows-server.md) or [Ubuntu](ubuntu-usb-server.md)). Re-running keeps its key, `.env` and WhatsApp logins.

## If something is off

| Symptom | What to do |
| --- | --- |
| Accounts are paused and a notice mentions an old version | Find the server named in the notice and update or stop it. |
| An admin sees "Waiting for a server" for an account | No server qualifies: all offline, full or draining, or the account is Local only and no Gemma server is online. Start a server. |
| **Move to...** says the server "can't take this account right now" | The target is offline, full, paused, or has no local model. Pick another, or add the model. |
| Account keeps going back to one server | It is pinned there. Unpin it. |
| Asked to scan the QR again | The login copy was missing or corrupt. Check **Settings, WhatsApp & app** for "Login backed up ...". If it says "not backed up yet", the account never finished one upload. |
| A server shows no capacity bar | It is running an older release. Update it. |
| `new-server-key.sh` says the name is too long | Use a device name of 25 characters or fewer. |
| A revoked server still seems alive | Its token can last up to an hour. Stop the worker on the device. |
| Two servers answer the same chat | Look for a server on an older release. The lease stops two fleet servers running one account. |
| A cloned laptop disk shows up as a new server | Expected. A cloned disk gets a new server id, so two servers never merge. |
