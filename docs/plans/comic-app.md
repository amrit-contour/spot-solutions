# Plan: Nothing BOT Comedy (the comic-side app)

Status: built (27 October 2026) as Nothing BOT Comedy in `apps/comic`: shell and shared UI, Rooms, community rosters, Today with calendar, Asks, My spots, regular spots, group spot alerts with editable rules, and comic commands on the agent number. What it does today is in [apps/comic/README.md](../../apps/comic/README.md) and the root README; this file keeps the context and the decisions behind it. Still open: anything under "Later" below.
Supersedes the room parts of [asking-rooms.md](asking-rooms.md); decisions in [rosters-and-agent.md](rosters-and-agent.md) still hold.
Reference data Amrit shared: "Bangalore Open Mics.xlsx", "Mic Venues @ BLR.xlsx" (Mic List v1/v2, a weekly "Spots" log),
a pasted curator list per venue, and screenshots of the Bangalore Comics WhatsApp group.

## Two apps, one platform

- **Nothing BOT Curating**: today's app (requests, lineups, groups) for curators.
- **Nothing BOT Comedy**: new, for comics asking rooms for spots.
- Same Firebase project, same servers, same WhatsApp link, one account (many people are both). Two Hosting sites, each with its
  own home-screen name and icon. Shared UI (calendar, cards, composer, sheets, theme) moves into a shared package first.

## What a room is (from Amrit)

- A **room is a venue** (Bloom Indiranagar). It runs several **shows**: mic, show, or both; daily, weekly or monthly; one or more
  time slots a day; some venues have two stages at the same time.
- **Curator per show per day**, usually one; sometimes co-curators, or a stand-in when one is out of town. Some days say
  "they'll reach out" (TAG weekends, UGC Fri–Sun). Asks go by WhatsApp DM.
- **Anything that isn't a WhatsApp DM is a note**, never an action: Instagram (Humble Pie → @comedybandar), a website and its
  password (Ministry of Comedy), walk-in / registration (Jagriti), "check BMS", "English acts only".
- **When to ask** varies per curator: same day (often "morning"), the day before, a weekday ("ping Mondays", "Mon morning"),
  start of week, start of month, they reach out. Mostly a day, rarely a time.
- **Limits** are the only enforced rule: 1 a month at a venue, 2 a week, max 2 in a day at a multi-show venue, unlimited.
  Everything else is a tag/pill: new comics only, experienced only, bringer, paid entry, English only.
- **Regular / curator**: in a roster a comic can mark "I'm a regular at this show" or "I curate this one".

## Day to day

- Asks go out per the room's rule (auto or reviewed per room, decided earlier), curator replies are read into got it / declined /
  no reply, and the spot lands in My spots.
- **Ad hoc spots** happen; add them by hand or from a group alert.
- **On the mic day** the agent checks "do you have a spot tonight?"; **after**, a poll of which mics you actually did. Stats
  come from that (spots per week/month, per room; Amrit's sheet keeps a weekly "spots counter" and an asks log).
- **Notes per spot**: room, crowd, was it a good show, own rating, what worked / didn't, set list. Later: audio upload or
  recording with cloud transcription; set list notes tied to what worked.
- **Seasonal breaks**: a room or show can be paused.

## Groups (comic side)

- The comic picks **which groups to watch** (only those are read; nothing else).
- Every new message there is read for:
  - **Spot offers** ("Spots at 7 and 9 today at Banter, DM", "busking at 6 at Comedy Theatre, reach by 5:40", "PM @someone"):
    urgent push to every installed device with an **Ask for it** button that DMs the right person: the sender when it says DM,
    or the tagged/named person.
  - **Closures** ("Closed", "Over, thanks", "Wed–Sat spots are over this week at Comedy Square", "Spots full Square Sunday"):
    mark that show full for the period, so it isn't asked or suggested.
  - **Roster changes** ("Comedy Square curation schedule: Mon Vishal, Tue Varun, Wed–Sat Akhil, Sun Varun", "ministry spots open
    by 3:15", "website is open"): update the roster.
- Auto-apply on: changes are applied and logged. Off: they become Updates items to review and clear. The prompt always has
  the comic's current roster for context. The agent can also be told to do it ("update TAG Monday to Dhruv").

## Draft data model (to correct together)

- **Room**: name, area, city, pin, aliases, tags, how-to-ask note (Instagram / website / walk-in / they reach out), limits
  (room or show; per day / week / month), paused until.
- **Show** (in a room): type (mic / show / both), days, times[], cadence, curator per day (+ co-curators), ask rule (kind + day or
  morning) with per-day overrides, full until / closed for this week, my role (regular / curator).
- **Curator**: name, number, Instagram, notes; same person as a Comics entry when the number matches.
- **Ask**: room, show, date, curator, message, status (planned / sent / got it / declined / no reply), the reply it was read from.
- **My spot**: date, time, room, show, source (ask / ad hoc / group offer / regular), happened or not, notes (room, crowd, rating,
  what worked, set list); audio later.
- **Spot alert**: from whom, room, time, reach-by, who to DM (sender or tagged), expires.
- **Published roster**: title, city, owner, version, last updated, rooms (shared fields only), followers, suggestions to approve.

## Decided (Round 2, 27 Oct)

- **Map pin**: search a place (free OpenStreetMap search) or paste a Google Maps link; the pin is read from it.
- **Tags**: a set of suggested tags (English only, new comics, experienced only, bringer, paid entry, walk-in, check BMS) to tap,
  plus custom tags.
- **Sharing beyond publishing**: share a roster with one user (in-app), and export / import as a file (Excel/CSV/JSON).
- **Everything stays inside the app**: published rosters, curator numbers and suggestions are only visible to signed-in,
  allowed users. Nothing public on the web.
- **Publishers are restricted**: an admin-edited list of publishers; the admin is a publisher by default. A publisher pushes
  their current roster to their published one; followers get "update available" and pick what to take (merge with review).
- **Suggestions**: anyone signed in can suggest a change; owners can add co-maintainers who approve suggestions.
- **Group-driven changes** update only the comic's own roster. Publishing stays a deliberate push by the publisher.
- **Spot alerts**: push as fast as possible with **Ask for it**. The only filter: skip (or flag) a spot that clashes in time with
  a spot already booked. No cooldown or limit checks: a spot offered in a group is ad hoc and the comic decides.
- **The co-comic's sheet** ("Spots - Arjun") was made by another comic for themselves: a weekly calendar of their spots, a
  spots counter and an asks log. That is what My spots should replace.
- **Domains**: nothingbotcurating.web.app, nothingbotcomedy.web.app, and hyphenated nothing-bot-curating.web.app,
  nothing-bot-comedy.web.app (plus nothingbut* and nothing-but-* mirrors). spot-solutions.web.app was kept for a while for installed servers, then retired on 27 October 2026: it only forwards to nothingbotcurating.web.app.
- **Logo**: minimal first; built from the NBC mark (outlined "n", solid "bc", lime dot) and the current logo; may use the
  NBC wording. Files: Amrit's zip (four PNGs: nbc and "Nothing but comedy." on black and on white).
- **Order** (my call): split first (shared UI package + comic app shell + the new sites), then the rooms page in the comic
  app. Building rooms inside the curator app and moving it later would be double work.

## Data model (built)

Code: `packages/shared/src/rooms.ts` (types, ask/limit/clash/curator/closure rules, `shareable`), `rosterMerge.ts` (`diffRosters`,
`applyMerge`), `rosterIO.ts` (JSON and CSV), `fixtures/blrRooms.ts` (Amrit's Bangalore sheets as a test seed), tests in `rooms.test.ts`.
Rules in `firestore.rules`. Dates are ISO strings in the comic's time zone; times are `HH:MM`.

**Storage.** Per user: `rooms/{roomId}` with **shows embedded** (a room has a handful; one read, atomic edits, a published snapshot is
the same shape; closures and per-day curator plans live in the show), `curators/{id}`, `asks`, `mySpots`, `spotAlerts` (the worker writes,
the comic clears), `watchedGroups`, `rosterFollows/{rosterId}` (last version seen, for "update available"). All owner-only. Top level:
`publishedRosters/{id}` (rooms + curators embedded, `version`, `ownerUid`, `coMaintainers[]`) with a `suggestions` subcollection, and
`publishers/{uid}`. Published data is readable by signed-in, approved (or admin), non-anonymous users only; the owner and co-maintainers
write it (only the owner changes `coMaintainers`); only a publisher or the admin can create one; anyone allowed can add a pending
suggestion; maintainers approve or reject; `publishers` is writable by admins only. A very large roster would hit the 1 MiB doc limit
(Bangalore is about 100 KB); split by city then.

**Shapes.**
- *Room*: id (slug of name + area), name, `brand` (shared by locations of a chain: Comedy Theatre, Glen's, Bloom, GoStops are separate rooms), area, city, `pin`, aliases, tags
  (suggested set + custom), `notes[]` (instagram / website / walk_in / check_bms / fcfs / other: never actions), `limits[]`, shows. Private: `myNotes`, `pausedUntil`.
- *Show*: name, type (mic/show/both), cadence (daily/weekly/monthly, `monthlyWeeks` 1..5 or -1 for last), default `times`, `askRule`, tags, and
  `days[]`: weekday, optional `times` and `askRule` overrides, `curatorIds` (first = who to ask, rest = co-curators), `theyReachOut`, `note`. Private: `myRole`, `closures[]`, `pausedUntil`, `myNotes`, `standIn` (on a day).
- *AskRule*: same_day / day_before (+`morning`), weekday X, start_of_week (`day`, Sunday = the Sunday before the week), start_of_month, they_reach_out; fcfs / walk_in / website / instagram are notes (no ping date).
- *Limit*: scope room or show, per day / week / month, or `unlimited`. *Curator*: name, phone, instagram (private: notes, comicId).
- *Ask* (planned / sent / got_it / declined / no_reply / expired, with `evidence`), *MySpot* (source ask / adhoc / group_offer / regular, happened, status, notes, reserved `audio`), *SpotAlert*, *WatchedGroup*.
- *PublishedRoster*, *RosterSuggestion* (target room/show/field, before/after), *Publisher*.

**Rules.** `nextAskWindow(rule, showDate, now, tz)` gives the ping date, a label ("Ping Monday morning") and whether the window is
upcoming / open / passed (open until the show is over, so a missed ping is "overdue"); `asksOpen` is the morning list (skips full, paused,
note-only, they-reach-out and already-asked dates; flags `blocked`). `limitsBlock` enforces only set limits; ad hoc and group-offer
spots are never blocked **and do not count** toward limits. `clashes` is the only spot-alert filter (default buffer 90 minutes between
starts, across midnight; spots without a time never clash); an alert clashes only if every time it offers does. `curatorFor`, `isFull`, `isPaused`.
`shareable*` is a whitelist (never a blacklist) so a new private field can't leak. Limits themselves are shared (they are rules); usage, closures and stand-ins are not.

**Merge with review.** Rooms/shows/curators match by id, then by name (+ area), so independently made rosters line up. `diffRosters`
returns changes with stable ids (`room:<key>`, `show:<room>/<show>#<field>`, `…#days.<weekday>`, `curator:<name>#phone`); `applyMerge(mine,
published, pickedIds)` takes only those, adds missing curators, and never touches my private fields. Picking everything is "replace all". A published curator with no number never wipes mine.

**Files.** `toRosterJson` / `fromRosterJson` (`format: "nbc-roster"`, `version: 1`; a newer version is refused; `full: true` is a private backup).
CSV is one row per show-day (`CSV_COLUMNS`); room and show columns repeat; notes and limits are JSON cells; headers match by name, so a hand-made sheet works.
Curators that no day uses are not in a CSV.
