# Server fleet

Any number of servers (Mac, Windows, Ubuntu, a cloud VM) run the worker against the same Firebase project.
Each WhatsApp account runs on exactly one server at a time. If that server dies, another takes the account
over with its encrypted login, without a new QR scan. Types and pure rules: `packages/shared/src/fleet.ts`.

## Data

| Where | What | Written by |
| --- | --- | --- |
| `servers/{id}` | heartbeat + `fleet: FleetCapacity` (installedAt, maxAccounts, hosting, localModel, draining) | each server |
| `users/{uid}/fleet/lease` | `Lease`: who runs the account, `epoch`, `state`, `renewedAt`, `moveTo` | servers only |
| `users/{uid}/fleet/prefs` | `FleetPrefs`: `pinned` server | the app (owner or admin) |
| `users/{uid}/fleet/vault` | `VaultMeta`: `gen`, `savedAt`, `server`, `bytes`, `sha256` | servers only |
| `vaultKeys/{uid}` | the account's 32-byte AES key (base64) | servers only; no client access at all |
| Storage `vault/{uid}/login-{gen}-{random}.bin` | encrypted zip of the login (one uniquely named object per upload attempt; `VaultMeta.object` is the exact committed path; others are deleted once older than 10 min) (Chromium `Default/IndexedDB` + `Default/Local Storage`) | servers only; no client access |
| `users/{uid}/devices/{token}` | FCM tokens for push notifications | the app |
| `users/{uid}.settings.ai.policy` | `AiPolicy` | the app |

Servers authenticate with their own service account key (one per device, revocable). Clients never read
leases' internals beyond what the Server page shows, never read `vaultKeys`, and never touch Storage `vault/`.

## Lease

- Every `LEASE_RENEW_MS` the holder renews `renewedAt` in a transaction that also checks `server == me && epoch == myEpoch`.
  If the check fails, someone else owns it now: stop the session immediately, without uploading.
- Fencing: if the holder hasn't renewed successfully for `LEASE_FENCE_MS` (lost internet), it stops its own WhatsApp.
  Takeover is only allowed after `LEASE_EXPIRE_MS`, so two servers never run one account.
- Claim: a server considers accounts that are approved and `waEnabled`, whose lease is `leaseClaimable`. It computes
  `rankCandidates(...)`; if it is rank N it waits `N × CLAIM_STAGGER_MS`, re-reads, and claims in a transaction
  (`epoch + 1`, `state: "running"`, `reason`). Only then does it start the session.
- A server counts only leases it holds towards `hosting`, and stops claiming at `maxAccounts`.

## Moving an account (planned)

1. The app (or a server shedding load, or a newly online pinned server) sets `lease.moveTo = target`.
2. The holder sets `state: "handing_off"`, stops the session (Chromium closed = clean copy), uploads the vault
   (`gen + 1`), then sets `state: "released", server: null`.
3. The target sees a released lease with `moveTo == me` and claims it immediately (no stagger), restores from the
   vault, starts. Other servers ignore a released lease with `moveTo` set to someone else for `LEASE_EXPIRE_MS`.
4. A push notification and an in-app notice say where the account went.

No automatic moves of healthy accounts, except: a pinned server that comes online pulls its accounts back, and an
over-capacity server sheds its most recently claimed accounts.

## Login vault (newest copy wins)

- Local profile: `${DATA_DIR}/session-{uid}` (LocalAuth, unchanged). Next to it, `${DATA_DIR}/vault-{uid}.json`
  records `{ gen }`: the vault gen this local copy was last uploaded as or downloaded from.
- Before starting a session: `pickLoginSource(localGen, cloudMeta)`.
  - `cloud`: download, decrypt, verify sha256, replace the local profile, write the marker.
  - `local`: keep it; upload within a minute of `ready` so the cloud catches up.
  - `fresh`: no login anywhere, show a QR.
- Upload: every `VAULT_UPLOAD_EVERY_MS` (60 minutes; the login is about 63 MB, so this is the main upload cost) while ready, on clean stop and before every handoff. A periodic upload is skipped when the login folders (file count, total size, newest mtime of `Default/IndexedDB` and `Default/Local Storage`) are unchanged since this server's last upload of the same gen; stops and handoffs always upload. Only the lease holder
  uploads, and the meta commit transaction re-checks `lease.server == me && lease.epoch == myEpoch`, so a holder that
  was fenced and replaced mid-upload cannot commit; gens are strictly increasing per account.
- Encryption: AES-256-GCM, random 12-byte IV per upload, key from `vaultKeys/{uid}` (created on first upload).
- Migration: on the first fleet start, a server with an existing local login and no cloud copy treats it as
  `local` and uploads it, so nobody has to scan again.
- Cleanup: superseded login objects are deleted 10 minutes after a newer commit (`VAULT_OBJECT_MIN_AGE_MS`). Cloud Storage
  soft delete must be OFF on the default bucket, or every deleted object is still kept and billed for 7 more days
  (the default soft-delete window). `deploy/setup-cost-controls.sh` turns it off; the REST equivalent is
  `PATCH https://storage.googleapis.com/storage/v1/b/<bucket>` with `{"softDeletePolicy":{"retentionDurationSeconds":"0"}}`.
- Logout: delete the local profile, marker, cloud object, vault meta and key.

## The agent number rides on the lease

An account may have a second WhatsApp login, its **agent number** ([agent.md](agent.md)). It is not a second account in the fleet: it has
no lease of its own and runs in the same worker, on whichever server holds the account's lease.

- **Start:** only while this server holds the lease (`agentSessions.hooks.canRun = holds(uid)`), and after the account's own WhatsApp
  (20 s later, so two Chromiums don't start at the same instant). Linking is `connect_agent`, run by the holder.
- **Stop:** every path that stops the account stops the agent with it: lost or fenced lease (`drop`), planned stop (`finishRelease`),
  logout of the account's own WhatsApp, shutdown, and the "not ours, stop it" sweep in `evaluate`. A hung stop kills both browsers.
- **Vault:** the agent's login is a second vault entry under the id `{uid}_agent`: profile `session-{uid}_agent`, marker
  `vault-{uid}_agent.json`, meta `users/{uid}/fleet/vault_agent`, key `vaultKeys/{uid}_agent`, objects `vault/{uid}_agent/`. The
  upload commit still checks the account's one lease (`server`, `epoch`), so a fenced holder can't overwrite it either. Uploads run on the same schedule
  (first upload 60 s after ready, hourly, on stop and on every handoff). Another server restores both logins when it claims the account.
- **Failover:** the new holder starts the account's WhatsApp, then the agent from its vault copy: no QR. Both can fail independently
  (a deterministic restore failure shows the agent's QR in Settings; the account's own login is unaffected).
- **Capacity:** the agent is a second Chromium (about 450 MB), so it counts as one more unit of `hosting` against `maxAccounts` (now
  "WhatsApp sessions"). A server at capacity stops claiming; shedding counts an account with an agent as two.
- **Admin wipe / remove user** also logs out and tombstones the agent's vault entry.

**Leasing the agent separately later:** give it its own `users/{uid}/fleet/lease_agent` (same `Lease` type), claimed with the same rules but
ranked by free memory only, and let the two leases land on different servers. Everything keyed by `{uid}_agent` (profile, marker, vault
meta, key, objects) already exists, so what changes is: `commitMeta` checks `lease_agent` for the agent id, `canRun` asks for that lease,
and `finishRelease` is split in two. The agent only needs Firestore (not the main session) to answer, except "confirm", which
needs the main session's server: it would hand that one request to the account's holder (a command) instead of calling the handler
directly.

## AI policy

- `local_only`: only servers with `localModel` may host the account, and Gemini is never called for it.
- `local_first` (default): prefer servers with a local model; a Gemini-only server may host it; Gemini answers when
  the local model is down.

## Push notifications

Worker `notify(uid, kind, text)` sends to every token in `users/{uid}/devices` and prunes dead tokens:
`account_moved`, `scan_needed`, `server_offline` (sent by a peer that sees a server go silent while holding
leases), `new_request` (optional, off by default).

## Commands (`users/{uid}/commands`)

- Only the lease holder executes an account's commands. Servers without the lease leave them `pending` (no error).
  Whoever acquires the account replays what is pending once its session is ready.
- With no live holder, two commands may create one: `connect` runs on the best-ranked server, `move_account` on its target.
- `move_account` with `{ to: serverId }`: run by the holder, which validates that `to` is online, not draining, has room
  and satisfies the AI policy, then sets `lease.moveTo`; the handoff in "Moving an account" follows. Errors come back
  on the command doc. Clients never write leases.

## Implementation notes

- Lease also carries `from` (last holder, kept on release) so the next holder can write "moved from X to Y".
- Expiry is judged on the claimer's own clock as well: a lease must have been seen unchanged for `LEASE_EXPIRE_MS`
  locally, so a skewed clock (renewedAt is written with the holder's `Date.now()`) cannot steal a live lease.
- A restarted server may reclaim its own stale lease after `LEASE_RENEW_MS + 5 s`.
- Servers publish `fleetServers/{id}` (curator-readable summary) and `servers/{id}.fleet`; placement reads `fleetServers`.

## Safety guards (added after review)

- **Old servers:** a `servers/*` doc that is online (lastSeen < 75 s) but has no `fleet` field is a pre-fleet worker,
  which ignores leases. While one is online, fleet servers claim and start nothing, log
  `[fleet] old server "<hostname>" is running`, and notify affected curators. They resume on their own once it is gone.
- **Vault epoch:** `VaultMeta.epoch` records the lease epoch of the upload. A holder whose marker lags a meta it wrote
  itself (same server and epoch) adopts that gen instead of stalling.
- **Server identity:** `server.json` holds `id`, `installedAt`, a machine fingerprint and its source. A changed
  fingerprint from a real machine id means a cloned disk (new id). Hostname/MAC fallbacks never trigger that.
- **Transient errors never become a QR:** downloads retry with backoff; only deterministic failures (bad hash, failed
  decrypt, object missing twice, no key) fall back to a fresh link.
