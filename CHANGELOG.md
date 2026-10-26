# Changelog

## 27 October 2026 (Nothing BOT Server)

### Servers
- **One name: Nothing BOT Server.** The Mac app, Windows folder and tasks, Linux services and paths, downloads and settings (`SPOT_*` is now `NBS_*`, old names still work) all use the new name, with one documented scheme: see docs/migrate-to-nothing-bot-server.md. `spotctl` and `spot-task` are now `nbsctl`.
- **New servers update from nothingbotcurating.web.app** (`dl/nothing-bot-server.json`, `dl/nothing-bot-server.tar.gz`). Servers installed before the rename are frozen on their last release: `deploy/build-dist.sh` keeps serving their old files (from the gitignored `deploy/legacy-dl/`) and fails if they are missing. The old install addresses serve the new installers.
- **Safe move for your own server.** `deploy/migrate/migrate-mac.sh` checks the account lease, stops the server cleanly so the login is uploaded to the vault, verifies the upload, and makes a local backup; `restore-backup.sh` puts the backup back on the new install if the vault restore ever fails. A new server that joins the same account restores the login from the vault with no QR code.
- **Uninstallers remove both old and new.** `uninstall.sh` (Ubuntu), `uninstall.ps1` / `Uninstall.cmd` (Windows) and `nbsctl uninstall` (Mac) keep your data unless you pass an explicit flag, and say what they kept. The new installers stop an old server on the same machine first.

## 27 October 2026 (rename)

- **Renamed to Nothing BOT Curating; servers are Nothing BOT Server.** New names across the app, installers, the server console and notices. Nothing under the hood changed: addresses, data folders, services and commands keep their old ids, so installed servers update as normal. The Windows installer is now "Install Nothing BOT Server.cmd" and replaces the old shortcuts. A comic-side app, Nothing BOT Comedy, is planned.

## 27 October 2026 (ad hoc offers)

### Ad hoc spots
- **Offer to several at once.** Pick one comic or several in Offer a spot, and how many spots to fill. One comic: a yes books them (as before). Several: the first yeses fill it automatically, or (switch off) everyone who says yes comes to Updates → Ad hoc yeses, you tick who gets it, and the rest are told it's filled. With the agent number linked, it asks you there too ("yes" adds them).
- A "no" to a one-person offer shows in Updates so you can offer the spot to someone else.
- **Ad hoc slots** (booked through an offer, or added after the lineup was confirmed) show an "Ad hoc" pill, stay in the comic's history, and never count against them. They join the group exactly as before.

### Request rules
- "Skip last week's comics" is now **Hold recent comics** with a cooldown of 1 to 8 weeks. Ad hoc spots don't count.
- "Tell held comics why" can **send it** or **draft it for review** in Updates. The Performed recently message says when they were last up and when to ask again.
- Settings → Around the show: "Offers to several: add the first yeses" (on by default).

## 27 October 2026 (group ops)

### Show groups
- **POCs.** Pick the people who run each mic in the show's settings. They always stay in the group, show in the group chat header, and `{{pocs}}` tags them for real (they get notified) in scheduled posts and in messages you send from the group chat.
- **More group templates:** Who the POCs are, Reach on time, Busking notice, Share the poster, After the show. All schedulable like the lineup and reminder.
- **Clear the group after the show.** The day after (at a time you pick), the after-show message goes out and everyone leaves except POCs, regulars, co-hosts, admins and anyone already on next week's lineup. If the mic happened it clears on its own (or asks, if you prefer). If it didn't happen, it asks first, in Updates and on your agent number: yes clears it, no keeps everyone for a repeat week, and your scheduled posts carry on. Runs on your server; gives up after 3 days.

### Server console
- Typing a folder path no longer loses focus after each key (Windows and everywhere). Drive bars are gone; free space shows as text. A new folder in the path is created when you move, with a plain message if it can't be.

### Fixes
- Shows: the group settings fit on phones.

## 26 October 2026 (show groups)

### Messages
- **Show groups.** A Groups tab lists the WhatsApp groups linked to your shows (no other groups are ever read). Open one to read it with who said what, and post text, polls or the venue pin. Shows has a Group chat button on each card and in the show editor.
- **Templates in every chat.** The Templates menu now has your messages from Settings (confirmation, "Am I up?", where and when, and more) filled in for that comic, next to your saved templates. Groups get the group templates.

### Scheduled group posts
- Schedule posts per show: the lineup, the venue and pin, a reminder, or your own message (start from a saved template), on the show day or up to 6 days before, at a time you pick. Optional "Write it in my voice". Edit them from the group chat or the show's settings.
- New templates in Settings → Messages → Show groups: Lineup post, Venue and location, Show reminder. The show-day lineup post uses the Lineup post template too.
- Your server sends them from its own scheduler (no cloud scheduler). Each goes once per show date; a lineup post waits for a confirmed lineup and tells you if it couldn't go; a cancelled show posts nothing.

### Google Contacts
- No more polling: an edit schedules one Cloud Task that writes the batch after a quiet minute, and re-arms only if work is left. The every-2-minutes `syncGoogleContacts` is now a 6-hourly safety sweep. New function `flushGoogleContacts`; run `deploy/setup-functions-iam.sh` once for the Cloud Tasks role.

### Fixes
- Requests: the card's bottom buttons fit on phones.

## 26 October 2026 (Google Contacts)

### Google Contacts
- **Keep connected.** Approve once in Google's popup and names are saved to your Google Contacts even when the app is closed. Settings shows "Connected as you@gmail.com · always on" with Disconnect. The old one-hour browser connection stays as "Connect for this visit only".
- The long-lived Google access is stored encrypted (AES-256-GCM, key in Secret Manager) in a server-only document and never returned to the browser. Disconnect revokes it at Google and deletes it. If access is removed at Google, Spot Solutions marks it disconnected and adds a notice to Updates.
- Adding or renaming a comic is saved to Google in the background after a minute of quiet, in batches. A big import is left for the reviewed "Sync all comics now", which now runs through the server when connected.
- New Cloud Functions `connectGoogleContacts`, `disconnectGoogleContacts`, `planGoogleContacts`, `runGoogleContacts`, `queueGoogleContact` (Firestore trigger) and `syncGoogleContacts` (every 2 minutes). New secrets `GOOGLE_OAUTH_CLIENT_SECRET` and `GOOGLE_TOKEN_KEY`; see docs/multi-server.md. Privacy policy updated.

## 26 October 2026 (servers)

### Servers
- **Connect with your account.** A fresh server console now starts with sign-in: it shows a one-time link and QR, you sign in with Google on the same computer or your phone, check a 4-character code and approve. The server makes its own key; your email becomes one of its admins. Join codes still work; a key file is only for the very first server of a new project. New Cloud Functions `startDeviceLink`, `pollDeviceLink`, `getDeviceLink`, `approveDeviceLink`; new `/connect-server` page.
- **Automatic updates.** Servers check `dl/version.json` every 30 minutes and update themselves a few minutes after a release (switchable), or on **Update now** in the console or the Update button on the Server page. Downloads are checked against a published sha256. The worker and console really restart on the new code, the local model is refreshed, and Server shows each server's version against the latest and "Updating...".
- **AI models in the console.** Server Gemini key, fetch and test models, pull local models, choose a default local model and routing for curators who haven't set their own, and turn the local model on or off. Same console on macOS, Windows and Ubuntu.
- **One install.** `install.sh` now serves Mac and Ubuntu; `/install` is a download page that picks the OS. Local model or Gemini only is decided in the console (the installer picks by memory). Old install URLs still work.
- Console: Services and Machine cards share one height.

## 26 October 2026

### Messages
- **Your voice** (opt-in, Settings → Messages). Learns how you write from messages you sent (recent DMs and show groups), then writes each message to a comic in that style. Every draft is checked against your template: if a date, time, venue, link or number changes, or the draft runs too long, the template goes out instead. "Write 3 versions" previews it first.
- Every message the app sends is now editable: drop-out replies, "am I up?", "where and when", last spot, spot offers, offer taken, group invite note, and two new held-request replies.
- Saved replies: your own templates, inserted from a Templates button on reply, new-face and offer boxes.
- `{{name}}` resolves at send time: the name you typed in the app, else the name saved in your phone, else their WhatsApp name, else "there". Emoji, honorifics and initials are skipped.
- Optional "Tell held comics why" for the request window and last-week rule. Banned, ignored and hosts never get a reply.

### Triage
- A spot request must mention a spot, a day or one of your venues. Chats without one (rent, money, family, other languages) are capped at Maybe instead of scoring 95%.
- "Spot available at Bloom 9 pm today?" is a spot request, not a where/when question.
- Only clear spot asks add someone to Comics. A Maybe joins Comics when you place it on a lineup.

### App
- NBC brand theme (black, white, green) is the default; Classic marigold stays as an option in Settings → Appearance.
- Dropdowns and time pickers match the app, with keyboard support.
- Comics: select many and remove them in one go, with Undo.
- Google Contacts shows when access expires and why it's one hour.
- Server page: spacing fixed under the Local models header. Server console: Machine card spacing fixed and memory reports what's really available.

### Privacy
- Privacy policy: new "Your voice" section.
