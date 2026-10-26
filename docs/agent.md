# The agent number (phase 1)

A second WhatsApp number per curator, linked by QR like the first. It talks **only to the curator's own number**, in plain text (no
buttons: whatsapp-web.js can't send them; see [plans/agent-number.md](plans/agent-number.md) for the Cloud API route).

Code: `packages/shared/src/agent.ts` (pure: who it obeys, intents, the yes state machine, texts), `apps/worker/src/agent*.ts`,
`lineupOps.ts`, the `AgentCard` in Settings → WhatsApp.

## What it does

| Part | Setting | How |
| --- | --- | --- |
| Tells you things | `settings.agent.notify` | Mic checks (replaces "Message yourself"), new spot requests (batched), follow-up suggestions, offer outcomes, dropped-out and moved-server notices, warnings. Push notifications are unchanged. |
| Answers questions | `answer` | "Monday lineup?", "who's waiting?", "what's left to confirm?", "who asked for Tuesday?", "when did Rohan last perform?" |
| Does things | `actions` | Add / remove someone, confirm a show, mark it happened or not, change a start time. Repeats what it understood, acts only on **yes** within 10 minutes. |
| Morning digest | `digest`, `digestTime` (default 10:00, the account's timezone) | Today's show and who's on, who's waiting, what needs you, tomorrow's show. Skipped when there is nothing to say, and not sent at all if it is more than 4 hours past the time (late link, restart). |
| Master switch | `enabled` | Off: linked but silent and deaf. |
| Strangers | `politeNote` (default off) | One fixed line, once per sender. Their message is never read; only a hash of who was told is kept. |

## Who it obeys

Only a 1:1 message whose sender is the account's own linked number (`session/state.phone`, i.e. what the primary session reported). A `@lid`
sender counts only when `getContactLidAndPhone` maps it to that number. Groups, broadcasts, status, our own sends, and anyone else are dropped before
anything is read. Messages older than 15 minutes (a backlog after a restart) are never acted on. `senderIsCurator` in `shared/agent.ts`, tested.

## How a message is understood

1. `parseIntentByRules`: the obvious phrasings, no model (instant, works with the AI down).
2. Otherwise `generateJson` with the account's AI policy and a fixed schema (`INTENT_SCHEMA`): the model may only pick one of a small set of intents
   and copy the day, name and time words. `normalizeRawIntent` validates it; anything off becomes "unknown" (a short help message).
3. Words are resolved against data by code, not by the model: `resolveShow` (weekday, today/tomorrow, show or venue name, venue aliases) and
   `matchPeople` (exact, then every word, then prefix, then part of a name; phone digits). Several matches become a numbered list.
4. Answers are built by deterministic formatters from live Firestore reads. The model never writes a sentence the curator sees.

## Doing things

`planAction` (pure) turns an intent into a plan and a sentence, and refuses early (already on it, show full, called off, not confirmed, own WhatsApp
not connected). The sentence is stored as `session/agent.pending` (10 minutes). `stepPending` decides what the next message does: yes runs the plan; a number picks
from a list and then asks for yes; no cancels; late is ignored; anything else drops it and is read as a new request. On yes the world is
re-read (the show may have filled or changed) and the plan runs through the existing paths:

- add / remove: `lineupOps.ts` (`placeOnLineup`, `removeFromLineup`), same rules as the app's `placeComic`: one show a week, a confirmed lineup records what was sent first so
  "changed since confirmed" works, the request moves to assigned. Comics are **not** told; for a confirmed show the agent says to use Send updates.
- confirm: the `send_confirmations` command handler (`runHandler`), sending from the curator's own WhatsApp through its send queue, exactly like the button.
- happened / didn't happen: `recordOutcome` (shared with the mic check).
- start time: updates the show's `startTime`; comics already told are not re-told.

Safety: nothing is written before yes; the agent never sends to anyone but the curator; every send goes through `sendQueued` (typing, jitter);
unprompted messages are capped at 12 an hour and replies at 60 an hour; the agent ignores groups.

## Data

- `users/{uid}/session/agent`: `SessionState` (status, qr, phone, ...) plus `pending`, `lastDigestOn`, `cursor`, `told` (hashes). Owner reads; worker writes.
- `users/{uid}.agentEnabled`: set by `connect_agent`, cleared on logout; clients can't change it (rules).
- `settings.agent`: the switches above.
- Commands `connect_agent`, `logout_agent`, `test_agent`: run by the lease holder.
- `notices` carry an optional `kind` ("offer", "lineup", "server"); the agent forwards those and every warning.

## Where it runs

On the server holding the account's lease, as a second whatsapp-web.js client (`agentSession.ts`), keyed `{uid}_agent`. See
[fleet.md](fleet.md#the-agent-number-rides-on-the-lease) for start/stop, the vault, failover, capacity, and how to lease it separately later.

## Deploy

1. Deploy `firestore.rules` (new commands, `agentEnabled` protected): `firebase deploy --only firestore:rules`.
2. Deploy the web app (Settings card, privacy section): `firebase deploy --only hosting`.
3. Update every server (`update_server`, or pull and restart). **All servers should run this release** before anyone links an agent: a server on the previous release answers `connect_agent` with an error, and if an account fails over to it, the agent stays down (its login stays safe in the vault) until the account lands on an updated server.
4. Nothing to migrate: no data exists until a curator links an agent.
