# Security

## Report a vulnerability

Use GitHub's private vulnerability reporting: open the [Security tab](https://github.com/amrit-contour/spot-solutions/security/advisories/new) of this repo and choose **Report a vulnerability**. Please don't open a public issue for a security problem.

Include what you found, the steps to reproduce it, and what an attacker could do with it. If you have run something against a live project, say which. The maintainer replies in the advisory thread.

## What is sensitive, and how it is protected

| Asset | Protection |
| --- | --- |
| **Service-account keys** (one per server) | One key per device, made by `deploy/new-server-key.sh` with only what the worker needs: Firestore (`roles/datastore.user`), push (`roles/firebasecloudmessaging.admin`), and Storage objects on the default bucket only (`roles/storage.objectAdmin`). No Firebase Auth role. Revoke one device with `deploy/revoke-server-key.sh` and the others carry on. Keys are git-ignored (`service-account*.json`), and on Windows the data folder is locked to SYSTEM and Administrators. |
| **WhatsApp logins** | Each account's login is stored as an AES-256-GCM encrypted copy in Cloud Storage (`vault/{uid}/...`), with its own random 32-byte key in `vaultKeys/{uid}`. The curator's uid is bound into the encryption, so a copy moved to another account fails to decrypt. No client can read `vaultKeys` (`allow read, write: if false`), and `storage.rules` denies every client read and write. Only servers, through the Admin SDK, can touch either. |
| **Gemini API keys** | Stored in `users/{uid}/secrets/ai`. The curator can set or clear their key but the rules never let a client read it back. The app only shows the last four characters. |
| **Who can use the app** | Invite-only. Anyone can sign in and ask for access, but the worker serves only accounts an admin has set to `approved`, up to a curator limit. Nobody can approve themselves. |
| **Admin actions** | Admin checks in the rules (`isAdmin()`, `isServerAdmin()`) count an email only when `email_verified` is true, so an unverified sign-in provider can't claim an admin's address. |
| **Chat content** | Chats that are not spot requests are never stored. A curator can set the AI policy to **Local only**, so their messages never reach Gemini and only a server running a local model can host the account. |

## Firestore rules in short

`firestore.rules` is the source of truth. In summary:

- A curator reads and writes only their own `users/{uid}` tree, and only the collections for venues, shows, comics, requests, lineups, actions and notices. They cannot change worker-owned fields (`waEnabled`, `selfId`, `demo`).
- `session`, `groups`, `contactsImport`, `offers`, `polls`, `fleet/lease` and `fleet/vault` are written only by servers. The owner (and, for `fleet`, admins) can read them.
- `fleet/prefs` accepts a single key, `pinned`.
- Commands: only an approved owner can create one, only as `pending`, and only of an allowed type. Admins can read and create `move_account` commands only, never message or contact payloads.
- `access/{uid}`: a user can create their own `pending` entry. Only admins change `status`.
- `config/access` (the admin email list) is not readable by anonymous demo visitors. Admins can only change `maxCurators`.
- `servers/{id}` (logs, admin emails) is readable only by the admins that server lists. `fleetServers/{id}` is a public-to-curators summary with no logs or emails.
- `vaultKeys` and all of Cloud Storage: no client access at all.
- The demo template (`users/demo-curator`) is read-only. Demo visitors sign in anonymously and work in their own copy. The worker never serves anonymous users.

## Known limits

- **whatsapp-web.js is unofficial.** It drives WhatsApp Web in a headless browser. WhatsApp can change its web client or enforce its terms against automated accounts, and a linked account can be logged out or restricted. The app sends slowly with a random delay and keeps auto-replies off by default, but this does not remove the risk.
- **A server's service-account key reads the whole project's data.** Whoever holds a server's key can read and write that project's Firestore data, including `vaultKeys` and the encrypted vault objects. That is enough to decrypt a WhatsApp login. The roles are scoped to what the worker needs, not to one curator. Treat each key like a password, keep servers on machines you control, and revoke a lost device's key at once.
- **A revoked key keeps working for a while.** A running worker's access token can last up to an hour after the key is deleted.
- **The server console is plain HTTP on your network.** It listens on port 7420 behind a random access token. Keep that port off the public internet (the Windows installer opens it for private networks only).
- **Gemini sees message text.** If a curator uses Gemini (as primary, fallback, or on a Gemini-only server), the text of the messages it reads goes to Google. Use **Local only** to rule that out.
