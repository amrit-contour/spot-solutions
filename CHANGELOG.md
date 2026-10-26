# Changelog

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
