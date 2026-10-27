# Nothing BOT Comedy (apps/comic)

The comic's side of open mics, at nothingbotcomedy.web.app (mirrors: nothing-bot-comedy, nothingbutcomedy, nothing-but-comedy). Same Google account, Firebase project, server and WhatsApp link as Nothing BOT Curate (`apps/web`); shared UI is in `packages/ui`, shared logic in `packages/shared`.

## What is in it

| Page | What it does |
| --- | --- |
| **Today** (`/`) | Today's asks and spots, a swipeable week strip, a month view and a day panel. An offline or unlinked banner reads the same session, agent and fleet data as Curate. |
| **Asks** (`/asks`) | Open ask windows and sent asks, in equal tabs with counts. Skip, Edit or Send per ask; rooms are set to review first or send on time from your own WhatsApp. Replies are read as Got it, Declined or No reply. |
| **My spots** (`/spots`, `/spots/regulars`) | Booked spots with notes, and regular spots (weekly or monthly rules, skip a date, make a regular from a spot, suggestions from your roster). |
| **Rooms** (`/rooms`) | Rooms, shows, curators, ask rules and limits; import and export; the Bangalore starter; community rosters under `/rosters` (browse by city, follow, update available, suggest, publish, co-maintainers, share with one person). |
| **Alerts and Groups** (`/alerts`, `/groups`) | Spot offers and closures read from the WhatsApp groups you watch, with **Ask for it**. Rules come first (instant push, no model call) and only doubtful messages go to the model; the weighted rules and thresholds are editable on Groups. |
| **Settings** | Connection card, push, the agent number ("What you can say", "Do it without asking", what it did). |

Group reading, asks and the agent run on your server (`apps/worker`); the app only shows the results.

## Run it signed in, without touching the real project

Uses the Firebase emulators (Auth + Firestore) with a `demo-nbot` project id. Needs Java and firebase-tools.

```
cd apps/comic
pnpm emulators        # terminal 1: Auth on 9099, Firestore on 8080, loads ../../firestore.rules
pnpm dev:emulator     # terminal 2: http://localhost:5175 (reads .env.emulator, VITE_USE_EMULATORS=1)
```

On the sign-in page tap "Sign in as the emulator test user" (creates a throwaway local user). Rooms > the menu > "Load the
Bangalore starter" > Apply fills it. Emulator data is wiped when the emulators stop. The switch only works in `vite dev`.

Without any sign-in: `pnpm dev`, then open `/dev` (Today), `/dev/rooms`, `/dev/asks` or `/dev/spots` (Bangalore seed, with sample asks and spots) or add `?empty=1`. In memory, nothing is saved.

## Group spot alerts (emulator)

With the emulators and `pnpm dev:emulator` running and the test user signed in once:
`node --experimental-strip-types scripts/seed-alerts.mjs` fills watched groups, spot alerts, review items and the Bangalore rooms
(see /alerts, /groups, /settings). Push and "Ask for it" sending need a real worker, WhatsApp and `VITE_FIREBASE_VAPID_KEY`.
