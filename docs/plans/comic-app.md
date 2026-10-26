# Plan: Nothing BOT Comedy (the comic-side app)

Status: context gathered from Amrit, 27 October 2026 (Round 1). Round 2 (community rosters, split, names) open. Nothing built.
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

## Open (Round 2)

Who can publish and contribute, co-maintainers, whether group-driven changes also suggest to the published roster, curator
numbers in public, spot-alert urgency and filters, domains, logo files, and build order (split first or rooms page first).
