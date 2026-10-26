# Plan: asking other rooms for spots

Status: planned, not built. Captured 26 October 2026 from Amrit's description.

## The problem

Spot Solutions handles one side of open mics: comics asking *me* for spots. The other side is me asking *other rooms* for spots, and that's still manual. Every room has its own rules:

- One curator for the whole room, or different curators for different days.
- Different ask windows: ping at the start of the week, the day before, the morning of, a fixed day.
- Different cadence: weekly, monthly, daily, several shows a week.
- Limits, like "2 spots a week at this venue" or "once a month".

Missing a window means missing the spot. Remembering all of it in my head is the chore.

## What it should do

1. **A list of rooms**, sorted by venue, day, time and curator. Each room has:
   - venue and area, maps link;
   - shows (day, time, cadence: weekly / monthly on the nth weekday / daily / ad hoc);
   - curator per show or per day (a WhatsApp contact), and how to ask (DM, group, form link);
   - the ask window ("Monday 10 AM to Tuesday 6 PM for Thursday's show");
   - limits (max spots per week or month, gap between spots);
   - my own notes and a message template for asking.
2. **Morning view (a "Today" lane on the Calendar):** the asks that are open right now, each saying which show it's for ("Thursday spot at X, ask Y, window closes in 6 h"). Asks I've already used up (limits) don't show.
3. **Reminders:** a push and a WhatsApp note to myself when a window opens and again before it closes. Times shift as the week goes on.
4. **Pick and send:** I tick the asks I want, review the drafted messages (in my voice, from the Your voice profile), and send. Sent with the usual human pacing (3 to 8 s gaps, typing indicator).
5. **Triage of replies:** every ask I send is tracked until its show date.
   - Curator confirms: the spot goes on my own calendar ("My spots"), with time and venue.
   - Curator declines: I get a notification.
   - No reply: it drops off after the show date (or the ask window closes, configurable).
   - Reading replies reuses the follow-up reader: the model reads the curator's reply against my ask and suggests "confirmed / declined / unclear"; unclear ones come to Updates.
6. **My schedule:** confirmed spots show on the Calendar next to the shows I curate, so I don't double-book myself. A clash warning if two land on the same night.

## Data model (sketch)

- `users/{uid}/rooms/{id}`: venue, area, mapsLink, notes, limits `{perWeek?, perMonth?, minGapDays?}`.
- `users/{uid}/rooms/{id}/shows/{id}`: weekday or cadence rule, time, curatorContactId, askWindow `{opensDayOffset, opensAt, closesDayOffset, closesAt}` relative to the show date, askTemplate.
- `users/{uid}/asks/{id}`: roomId, showId, showDate, sentAt, messageId, status (`planned` | `sent` | `confirmed` | `declined` | `expired`), replyEvidence.
- `users/{uid}/mySpots/{id}`: date, time, venue, source askId.

## Reuse

- Calendar page for the Today lane and My spots.
- Voice drafting (`inVoice`) and its fact check (the show day and date must survive).
- Follow-up reader (`readDecision`-style prompt) for curator replies, scoped to chats with room curators only.
- Send queue and notices; push (FCM) for window reminders, via the worker scheduler.

## Decided (26 Oct)

- **DMs first.** Some rooms take asks in a group; that comes later.
- **Sending is per room:** each room is set to "send automatically when the window opens" or "draft for my review". The morning list shows both; review ones need a tap.

## Still open

- When a curator confirms in a voice note or with an emoji only, is a "👍" a yes? (Default: yes, but shown for review.)
