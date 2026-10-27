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

Which server gets an account, best first: the pinned server, then servers with a local model, then the least loaded, then the newest install. A server stops taking accounts when it reaches its limit. The limit is (memory minus 5.5 GB) / 450 MB with a local model, and (memory minus 1.5 GB) / 450 MB without one. Set `NBS_MAX_ACCOUNTS` in the worker's `.env` to override it.

## Connect a server with your account

The quickest way, and the only one most people need. On a freshly installed server, the console starts with **Connect with your Nothing BOT Curating account**.

1. Click **Connect with Nothing BOT Curating**. The console shows a link, a QR code and a 4-character check (like `K7QF`).
2. Open the link on the same computer, or scan the QR code with your phone. Sign in with Google.
3. The page asks **Connect server <name>?** and shows the same 4 characters. Check they match, then click **Connect server**.
4. The console collects its own key, restarts the worker, and adds your email to its admins. The server shows up under **Account, Server** within a minute.

Only admins can approve (the same list as everywhere else in the app); anyone else sees "Ask an admin". The link lasts 15 minutes and works once. Only approve a computer you set up yourself.

How it works: the console makes a random secret and sends only its sha256 to `startDeviceLink`, which returns a one-time code (stored hashed in `deviceLinks`, closed to every client). The link is `https://spot-solutions.web.app/connect-server?c=<code>`. When an admin approves (`approveDeviceLink`, verified email in `config/access.admins`), the console, which polls `pollDeviceLink` with the code and its secret, gets a key made the same way as for a join code. The key is only in that one reply: never in a URL, never stored, never logged. If the reply is lost, the same console can ask again for 10 minutes (the first key's account is revoked first). `startDeviceLink` is limited to 10 per 15 minutes per IP.

## Join a server with a code

The other way, for when signing in on the server's side isn't convenient. Every server has its own Firebase service-account key. Never copy one key between computers. With a join code the app makes that key for you, so nobody needs the Google Cloud CLI.

1. Sign in to the app as an admin and open **Account, Server**. Click **Add a server**. Optionally name it, then click **Make a code**. You get a code like `SPOT-7K3F-Q9TX`, a copy button, a QR of the code text and a countdown. A code works once and lasts 15 minutes.
2. On the new computer, install Nothing BOT Curating (see the guide for [Mac](mac-server.md), [Windows](windows-server.md) or [Ubuntu](ubuntu-usb-server.md)) and open its server console. Type the code under **Have a join code from the app?**. The device name is filled in with the computer's name; change it if you like. Click **Join**.
3. The console trades the code for a key, saves it and restarts the worker. Under **Admins** in the console, add your email if it isn't there yet. The server shows up under **Account, Server** within a minute, and the Add a server card says it joined.

What happens behind the scenes: the code is hashed in Firestore (`joinCodes`), and the console calls the `redeemJoinCode` Cloud Function over HTTPS, at most 10 tries per 15 minutes per IP address. The function creates the service account `spot-<device-name>` (a number is added if the name is taken) with only what the worker uses: `roles/datastore.user` and `roles/firebasecloudmessaging.admin` on the project, and `roles/storage.objectAdmin` on the default bucket only. It returns the key once and records the account in `serverKeys`. If setting up fails, the account is cleaned up and the code works again.

The functions run as their own service account, `spot-enroller`. Set that up once with `deploy/setup-functions-iam.sh`, see [Deploying the functions](#deploying-the-functions).

**Remove a server.** On **Account, Server**, each server has **Remove server**. It deletes the server's key, its Google Cloud account and its roles, and its entries on the Server page. This is how you clear out old or offline servers.

- If the server is online and still runs WhatsApp accounts, you are told so and can remove it anyway. Its key is cut at once, but the computer may keep answering chats until its access runs out (up to an hour), and another server starts those accounts after about 150 seconds. Moving the accounts first is cleaner.
- A server that was set up before join codes, or with the project's default `firebase-adminsdk` key, has no Nothing BOT Curating account. Remove only deletes it from the list and says its key wasn't revoked. The default key is never deleted. Rotate it in the Firebase console if you need to.

If the computer is still on, uninstall Nothing BOT Curating there afterwards.

### Fallback: the key scripts

If the functions aren't deployed or the new server can't reach them, make the key by hand. You need the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) signed in (`gcloud auth login`), run from the project folder.

```bash
deploy/new-server-key.sh <device-name> [--dry-run]
deploy/new-server-key.sh studio-mac
```

It makes the same account with the same roles, and saves the key to `~/.spot-keys/spot-<device-name>.json` (folder mode 700; set `NBS_KEY_DIR` to change it). The device name is lower-cased, anything but letters, digits and dashes becomes a dash, and the full account name must be 6 to 30 characters. Running it again adds a fresh key. `--dry-run` prints the `gcloud` commands. `NBS_PROJECT` and `NBS_BUCKET` override the project (default `spot-solutions`) and bucket (default `spot-solutions.firebasestorage.app`). The script is an admin tool and is not hosted on the website: run it from a checkout of the repo.

In that server's console, open **First server ever? Use a key file** and drop `spot-<device-name>.json` onto it (this is also where the very first server of a brand-new project goes, when nobody is an admin yet). The worker restarts by itself. Delete the file from the machine you made it on. It is a password.

To revoke a device by hand:

```bash
deploy/revoke-server-key.sh <device-name> [--dry-run] [--yes]
```

It asks you to type the device name, deletes every key first (so access ends even if a later step fails), removes the roles and deletes the account. A removed key stops working once the device's cached token runs out: up to an hour, usually minutes. Note that this does not remove the server from the Server page; use **Remove server** for that.

### Deploying the functions

Once, as a project Owner with `gcloud` and `firebase` signed in:

1. `deploy/setup-functions-iam.sh --dry-run` shows what it will do. Then run it without the flag. It enables the APIs, creates `spot-enroller` and gives it: `roles/iam.serviceAccountAdmin`, `roles/iam.serviceAccountKeyAdmin`, `roles/datastore.user`, `roles/logging.logWriter`, `roles/storage.admin` on the default bucket only, and `roles/resourcemanager.projectIamAdmin` limited by an IAM condition to granting just `roles/datastore.user` and `roles/firebasecloudmessaging.admin`. `--unrestricted` drops that condition. It also lets you deploy functions that run as `spot-enroller`.
2. `firebase deploy --only functions` (builds `functions/` first).
3. `pnpm --filter @spot/web build && bash deploy/build-dist.sh && firebase deploy --only firestore:rules,hosting`.

The functions are 2nd gen, Node 22, region `asia-south1`: `createJoinCode`, `removeServer` and `approveDeviceLink` (callable, admins only, by the verified email in `config/access.admins`), `getDeviceLink` (callable, any verified sign-in; says whether you may approve), and the public HTTPS `redeemJoinCode`, `startDeviceLink` and `pollDeviceLink` (protected by the code or the console's secret). `joinCodes`, `serverKeys`, `joinAttempts` and `deviceLinks` in Firestore are closed to every client. No new IAM roles are needed: they run as `spot-enroller` like the others.

## Make another server your primary

Each account runs wherever it is pinned, so to make a different server the main one:

1. Move the accounts there. **Account, Server, Fleet**: open the menu next to an account, **Move to**, pick the new server. Curators can do the same under **Settings, WhatsApp & app, Move to...**.
2. Then **Pin**. Use **Pin to this server** (admins) or **Keep on this server** (curators) on the new server, for each account.

If the pinned server goes offline, another server takes the account after about 150 seconds and WhatsApp reconnects without a QR code. The account then runs there. When the pinned server comes back online, the account is pulled back to it and WhatsApp reconnects again in about a minute. Unpin an account if you want it to stay where it is.

## Starting over

To reset the whole fleet and bring servers back one at a time:

1. On **Account, Server**, click **Remove server** on every server. This revokes the keys made by join codes.
2. Click **Add a server** to make a code.
3. On a computer with Nothing BOT Server installed, open its console and enter the code. Repeat for each server you want.

Curators keep their data. Each account's login backup stays in the cloud, so the first server to join takes the accounts over without a new QR scan. If a server came from the default key, its old key is not revoked by Remove, so rotate it in the Firebase console.

## Local model or Gemini only

A computer without room for Gemma (under about 8 GB of memory) can still be a server and answer with Gemini. There is one installer per system, and the choice is made in the console, under **AI models**: **Local model on this computer** turns Ollama and Gemma on (it installs and downloads them, with progress) or off, at any time. The installer starts you off by memory: a local model at about 8 GB or more, Gemini otherwise. To force it, set `NBS_NO_LOCAL_MODEL=1` (or `0`) when running the installer; re-running keeps the last choice.

Gemini receives the text of the messages it reads. A Gemini-only server cannot host an account set to **Local only** (see below).

**AI models** in the console also has: the server's **Gemini key** (masked, kept only on that server), **Fetch models** and **Test** for a Gemini model, the installed local models with **Test**, **Make default** and a **Download** box with progress, and **Default routing**: local first with Gemini as backup, Gemini first with local as backup, Gemini only, or local only. The routing and models apply to curators who have never saved AI settings of their own; anyone who has (Settings, AI models) keeps their choice. They are stored in the worker's `.env` as `NBS_AI_MODE`, `NBS_LOCAL_MODEL` and `NBS_GEMINI_MODEL`.

## Local only vs Local first

Each curator picks one under **Settings, AI models**.

| Policy | What it means |
| --- | --- |
| **Local first** (default) | Your local model answers. Gemini steps in when it is down, or if you picked it as a model. A server without a local model can host your account. |
| **Local only** | Your chats never reach Gemini. Only a server running a local model (Ollama with at least one model) can host your account, and Gemini routes are switched off for it. |

If a curator uses Local only and no server with Gemma is online, the account waits until one is. Keep at least one Gemma server if anyone uses Local only.

## Pin and Move

Both live in the app. A curator sees the buttons when at least two servers are online.

**Curators:** **Settings**, then the **WhatsApp** tab, shows "Running on <server>" and when the login was last backed up.

- **Keep on this server** pins the account. Whenever that server is online, the account stays on it, and if it comes back after an outage the account is pulled back from wherever it went.
- **Stop keeping on this server** unpins it.
- **Move to...** hands the account to another online server. Expect WhatsApp to reconnect in about a minute.

**Admins:** **Account, Server, Fleet** lists every server (load, local model, online) and every approved account. The menu next to an account has **Move to**, **Pin to this server** and **Unpin**.

A move is refused, with a message, if the target is offline, full, draining, or has no local model for an account set to Local only. The account stays where it is.

## What you will see

**Notices** appear as dismissible cards in the app:

- "Your WhatsApp moved from X to Y." After a crash: "...because X stopped responding."
- A warning if an old server is blocking the new ones (see below).

**Push notifications** go to every browser or phone where you turned on **Settings, App, Notifications on this device**. On iPhone and iPad, add the app to your home screen first.

| Push | When |
| --- | --- |
| Your account moved | An account moved to another server. |
| WhatsApp needs a scan | The login could not be restored and you must link again. |
| A server went offline | A server holding your account stopped responding. Another one takes over shortly. |
| New spot request | Defined, but off by default. |

The Server page and the Settings card also show a server as "isn't responding" once its lease is stale.

## Upgrading safely

Stop any server running an older Nothing BOT Curating release before you link a new one.

Servers from before the fleet release heartbeat but ignore leases: they start every approved account themselves. If one stays on next to a fleet server, both would answer the same chats. So fleet servers check for them. While a server without fleet support is online, every fleet server:

- claims and starts nothing (your WhatsApp is paused on the newer servers),
- logs `[fleet] old server "<hostname>" is running`,
- adds a warning notice for each affected curator, once.

They carry on by themselves once the old server is stopped or updated. In **Account, Server, Fleet**, an old server shows "Older version: it doesn't report capacity yet. Update it to join the fleet."

To update a server by hand, run its installer again (see the guide for [Mac](mac-server.md), [Windows](windows-server.md) or [Ubuntu](ubuntu-usb-server.md)). Re-running keeps its key, `.env` and WhatsApp logins. Servers installed from this release on also update themselves, see below.

## Updates

`deploy/build-dist.sh` publishes `dl/nothing-bot-server.json` (`version`, `builtAt`, `sha256` of the tarball, `size`, default `model`) next to `dl/nothing-bot-server.tar.gz`. Each console checks it at start and every 30 minutes.

- **Update now** in the console, or **Update** on a server in **Account, Server** (the app sends an `update_server` command; the worker asks its console to run the updater and the server shows "Updating..." until its new version reports in). The Server page shows each server's version against the latest.
- **Install updates automatically** (on by default, in the console under **Updates**): a few minutes after a release appears, at a stable per-server offset of 0 to 10 minutes so servers in a fleet don't all restart together. After a failed update, automatic ones wait 6 hours.
- What an update does: download, check the sha256 (refuses a mismatch, a bad archive or unsafe paths), put the files in place keeping `.env`, keys and WhatsApp logins, reinstall packages only if the lockfile changed, restart the worker and the console on the new code, and `ollama pull` the model (a no-op when current). WhatsApp reconnects without a QR within a minute.
- Per system: **macOS** `nbsctl update`, run as its own launch agent so it outlives the restarts; **Ubuntu** `nothing-bot-server-task@update.service`, a root-owned oneshot (`/usr/local/sbin/nbsctl`) that the console's user may start through sudoers and that never runs anything from the app folder as root; **Windows** the scheduled task `NothingBotServerUpdate` (SYSTEM, started on demand).
- The checksum guards against corrupt or truncated downloads and a tampered file in transit. It comes from the same host as the download, so it is not a signature.

## If something is off

| Symptom | What to do |
| --- | --- |
| Accounts are paused and a notice mentions an old version | Find the server named in the notice and update or stop it. |
| An admin sees "Waiting for a server" for an account | No server qualifies: all offline, full or draining, or the account is Local only and no Gemma server is online. Start a server. |
| **Move to...** says the server "can't take this account right now" | The target is offline, full, paused, or has no local model. Pick another, or add the model. |
| Account keeps going back to one server | It is pinned there. Unpin it. |
| Asked to scan the QR again | The login copy was missing or corrupt. Check **Settings, WhatsApp** for "Login backed up ...". If it says "not backed up yet", the account never finished one upload. |
| A server shows no capacity bar | It is running an older release. Update it. |
| `new-server-key.sh` says the name is too long | Use a device name of 25 characters or fewer. (Join codes shorten the name for you.) |
| The console says the code isn't valid | Codes work once and last 15 minutes. Make a new one under **Add a server**. After 10 wrong tries from one network, wait 15 minutes. |
| The console can't reach Nothing BOT Curating when joining | The server needs internet, and the functions must be deployed. Use the key scripts as a fallback. |
| A removed or revoked server still seems alive | Its token can last up to an hour. Stop the worker on the device. |
| Two servers answer the same chat | Look for a server on an older release. The lease stops two fleet servers running one account. |
| A cloned laptop disk shows up as a new server | Expected. A cloned disk gets a new server id, so two servers never merge. |

## Google Contacts, kept connected (one-time setup)

`connectGoogleContacts`, `disconnectGoogleContacts`, `planGoogleContacts` and `runGoogleContacts` (callable, any real signed-in curator), the Firestore trigger `queueGoogleContact` and the scheduled `syncGoogleContacts` (every 2 minutes) save comic names to a curator's Google Contacts while the app is closed. They run as `spot-enroller`, need no new keys, and use two secrets and one parameter:

1. APIs: People API (`people.googleapis.com`), Secret Manager, Eventarc and Cloud Scheduler (`deploy/setup-functions-iam.sh` enables them and gives `spot-enroller` `roles/eventarc.eventReceiver`; run it again).
2. Google Cloud Console, APIs & Services, Credentials, open the Web client Firebase created ("Web client (auto created by Google Service)"). Under **Authorized JavaScript origins** add `https://spot-solutions.web.app`, `https://spot-solutions.firebaseapp.com` and `http://localhost:5173`. Copy its **Client secret**.
3. `firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET` (paste the client secret) and `openssl rand -base64 32 | firebase functions:secrets:set GOOGLE_TOKEN_KEY` (the key that encrypts stored tokens; lose it and curators press Keep connected again).
4. The client id is public: `VITE_GOOGLE_OAUTH_CLIENT_ID` in `apps/web/.env` for the web build, and `GOOGLE_OAUTH_CLIENT_ID` for the functions (`functions/.env`, or answer the prompt on first deploy).
5. `firebase deploy --only functions,firestore:rules`, then build and deploy hosting as above.

Tokens live in `users/{uid}/private/google` (AES-256-GCM, uid bound in as authenticated data); `users/{uid}/googleLink/status` (email, since) is what the owner may read; `googleSyncQueue/{uid}` holds edits waiting to be written. All three are closed to clients except that status read. An edit waits for 45 s of quiet (5 min at most), more than 25 comics at once is left for the reviewed "Sync all", failures back off from 2 min to 1 h and stop after 5.
