# Plan: rooms roster, community rosters, agent v2

Status: decisions captured, data model not drafted yet (waiting on Amrit's example sheets). 27 October 2026.
Builds on [asking-rooms.md](asking-rooms.md) (asking other rooms for spots) and [../agent.md](../agent.md) (the agent today).

## Phases

1. **My rooms.** A full page to see, edit and verify every room: venue, shows, curator per day, ask window, cadence, limits, notes.
   Anything can go in: text, CSV/Excel, PDF, HTML, a URL, screenshots, a forwarded message, either on the page or sent to the
   agent. The AI parses it into the data model and shows the changes; nothing is saved until the curator approves.
2. **Asks.** Morning list of open windows, reminders, drafts in the curator's voice, send (auto or review per room), curator replies
   read as confirmed / declined / unclear, confirmed spots into My spots on the calendar, clash warning. Scheduling runs on the
   curator's server (no cloud scheduler).
3. **Community rosters.** See below.
4. **Agent v2.** See below.

## Community rosters (decided 27 Oct)

- **Rooms only.** A published roster holds venues, mics, days, times, ask windows, how to ask, and the curator's booking contact.
  A comics list is never published.
- Published under a title and city ("Bangalore Scene", "Delhi Scene"); browsable by city; shows last updated.
- **Import = merge with review.** New, changed and missing rooms are listed; the importer ticks what to take. Replace-all is an
  option on the same screen. Importers can follow a roster and get "update available".
- **Contributions.** Anyone can suggest a change to a published roster (a new room, a changed window, a curator who moved).
  The owner approves or rejects each suggestion; approved ones show up in the published roster. The owner can also push their own
  roster's changes to the published one (sync).
- Private fields never publish: the owner's notes, limits, ask history, and anything about their own spots.
- Owner can unpublish; anyone can report.

## Agent v2 (decided 27 Oct)

- **Model:** local Gemma by default. A curator can switch to the Gemini API for better answers.
- **Tools for every feature:** lineups, requests, comics, shows, venues, messages, group posts, rooms, asks, rosters (import,
  publish, suggest), settings. The agent calls them on its own.
- **Autonomy:** by default reads are free and anything that writes or sends needs the curator's yes. A setting makes it fully
  autonomous (act, then report).
- **Context:** knows the curator (shows, stats, voice profile, rosters) and reads chats only when a question needs them.
- **General questions** are answered too, using that context where it helps.
- Facts come from tools, not from the model's memory. Every action is logged.
- Same assistant on the agent number and in a chat panel in the app. A test set of real questions guards against regressions.

## Waiting on

- Example sheets of how rooms are kept today (fields for the data model). We'll go through the fields together before building.
- 5 to 10 real curator replies (including 👍, "maybe", voice notes).
- About 20 questions Amrit would ask the agent.
