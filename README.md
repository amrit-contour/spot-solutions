<p align="center">
  <img src="apps/web/public/press/cover.gif" alt="Spot Solutions: WhatsApp spot requests, sorted by Gemma on an old laptop" width="100%" />
</p>

<p align="center">
  <a href="https://spot-solutions.web.app"><img alt="Live demo" src="https://img.shields.io/badge/live%20demo-spot--solutions.web.app-E8A33D?style=for-the-badge&labelColor=1f1812" /></a>
  <img alt="Gemma 3 on Ollama" src="https://img.shields.io/badge/Gemma%203-on%20Ollama-E8A33D?style=for-the-badge&labelColor=1f1812" />
  <img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-E8A33D?style=for-the-badge&labelColor=1f1812" />
</p>

<p align="center">
  <b>Your open-mic lineup, sorted while you sleep.</b><br/>
  Comics ask for spots in your WhatsApp DMs, however they like. A Gemma model running on your own laptop picks out the real requests.<br/>
  You drag names into shows and press send. Confirmations, polite regrets and show groups take care of themselves.
</p>

<p align="center">
  <a href="https://spot-solutions.web.app"><b>Try the live demo</b></a> ·
  <a href="https://dev.to/amrit-dash/my-whatsapp-was-my-open-mic-booking-system-so-i-gave-it-to-gemma-5274">The write-up on DEV</a> ·
  <a href="#run-a-server">Run a server</a> ·
  <a href="docs/README.md">Docs</a>
</p>

---

## Why this exists

I'm a stand-up comic in Bangalore and I curate the Monday and Tuesday open-mic lineups at a club. Spot requests arrive in WhatsApp between family groups, comic gossip, bank alerts and memes. Every new message buries the older ones, so being fair to whoever asked first meant scrolling back through every chat, checking who performed last week, messaging everyone and fixing each show's group by hand.

**That was about 3 hours a week. Now it's about 15 minutes.**

Version 1 ran for 7 months across 2024 and 2025 on Google Apps Script, Sheets and Twilio (2,200+ requests from 150+ comics). Spot Solutions keeps every rule V1 learned and hands the messy human part to an open-weight model that runs on hardware you already own.

<p align="center">
  <img src="apps/web/public/press/hero.gif" alt="Gemma tagging DMs and filling the Monday and Tuesday lineups" width="720" />
</p>

## See it

<p align="center">
  <img src="apps/web/public/press/demo.gif" alt="Walkthrough: start the demo, see the triaged requests, drag a comic into a show" width="100%" />
  <br/><sub><a href="apps/web/public/press/demo.mp4">Watch as video (25 s)</a> · or <a href="https://spot-solutions.web.app">open your own demo sandbox</a>, no sign-up</sub>
</p>

<table>
  <tr>
    <td width="50%"><img src="apps/web/public/press/requests.jpg" alt="Requests inbox" /><br/><sub><b>Requests.</b> Gemma's triage, with replies drafted and waiting for your OK.</sub></td>
    <td width="50%"><img src="apps/web/public/press/lineup-after.jpg" alt="Lineup board" /><br/><sub><b>Lineup.</b> Drag from Waiting into shows. Last week's performers sink to the bottom.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="apps/web/public/press/ai-policy.jpg" alt="AI policy setting" /><br/><sub><b>Your call.</b> "Local only" keeps every chat on a server running Gemma.</sub></td>
    <td width="50%" align="center"><img src="apps/web/public/press/phone-lineup.jpg" alt="Lineup on a phone" width="46%" /> <img src="apps/web/public/press/phone-requests.jpg" alt="Requests on a phone" width="46%" /><br/><sub><b>Built for the phone.</b> Installs as an app.</sub></td>
  </tr>
</table>

## How it works

```mermaid
flowchart LR
  C([Comics]) -- DMs --> WA[WhatsApp]
  WA <--> W

  subgraph laptop [Your laptop · the server]
    W[Worker<br/>whatsapp-web.js]
    G[Gemma 3<br/>via Ollama]
    W -- "a quiet chat's whole burst" --> G
    G -- "spot request · cancel · question · noise<br/>+ the exact quote" --> W
  end

  W <-- "outbound only" --> F[(Firestore)]
  F <--> A[Web app<br/>phone or desktop]
  A --> You([You: drag, review, send])
```

1. **Comics DM you like they always have.** Nothing changes for them.
2. **The worker waits until a chat goes quiet** (45 s), then hands the whole burst to Gemma, so "hey" … "monday?" … "got a new 5" is one request, not three.
3. **Gemma classifies it and has to quote the ask.** The worker checks the quote is really in the messages. If it isn't, it's noise. That one rule is what stops a 4B model from turning an OTP into a spot request.
4. **Requests land on the board.** You drag comics into shows and hit **Confirm & send**.
5. **Confirmations, regrets and group changes go out**, spaced like a human would send them, and only after you review them.

The laptop never opens a port. The web app writes commands to Firestore and the worker picks them up, so it works on home Wi-Fi while you're on mobile data across town. More detail in [docs/architecture.md](docs/architecture.md).

## What it does

<details open>
<summary><b>Triage</b></summary>

- Understands English, Hinglish and Kannada ("bhai monday ka spot milega?", "guru tuesday sigutta?").
- Sorts every conversation into spot request (with preferred days), cancellation, "am I up this week?", "when was my last spot?", venue and timing questions, or noise.
- Chats that aren't spot requests are never stored. A "spot request" has to mention a spot, a day or one of your venues, so a chat about rent or lunch can only ever reach **Maybe**.
- Rules from V1: request windows, skip-last-week, host, ban and ignore lists. Rule-breakers wait in a **Held** tab instead of your inbox.
</details>

<details>
<summary><b>Curation</b></summary>

- Lineup board with drag and drop on desktop and a tap-to-add flow on phones.
- Two looks: **NBC** (black, white and green, the default) or **Classic** marigold, in Settings → Appearance.
- "Performed last week" tags, experience tiers, preferred-day chips and spot history ("last spot 12 days ago").
- **Repeat last week** for weeks after a cancelled mic. **Reset a lineup or the whole week** when plans change.
- "Did the mic happen?" the next morning. "No" undoes the night in everyone's history.
- Spot offers: offer an open slot to one comic. Yes books it, no or silence frees it.
- Hosts poll: a WhatsApp poll of the week's shows, with votes shown on each show.
</details>

<details>
<summary><b>Messages and groups</b></summary>

- **Your voice** (opt-in): Gemma learns how you write from messages *you* sent, then writes each message to a comic that way, a little different for everyone. Your template is the guide and the safety net: a draft that changes a date, time, venue or link is thrown out and the template goes out instead.
- Every message is editable in Settings → Messages: acknowledgements, confirmations, regrets, cancellations, spot offers, "am I up?", "where and when", held-request replies and more.
- Saved replies: your own templates, one tap away on any reply box, with `{{name}}` filled in.
- `{{name}}` is the name you saved them under in your phone, else their WhatsApp name, else "there".
- Templates for acknowledgements, confirmations and regrets with `{{name}}`, `{{show}}`, `{{venue}}`, `{{day}}`, `{{date}}`, `{{time}}`, `{{minutes}}`, `{{mapsLink}}`, and optional sections such as `{{#minutes}}…{{/minutes}}`.
- Group sync: after confirming, review who gets added to and removed from each show's group. Admins, regulars and co-hosts always stay. Or let a show update its group automatically on the day.
- New faces: someone you haven't saved gets a friendly "who are you?" and their answer fills in their profile.
</details>

<details>
<summary><b>Your people</b></summary>

- Import comics from your saved WhatsApp contacts, from a CSV or vCard file (Google Contacts exports work), or from every member of a show's group.
- Search by keyword (commas match any: `comic, open mic`), select all matches, import.
- Mark regulars and co-hosts straight from the group's member list.
- Only clear spot asks join Comics on their own. A Maybe joins when you place it on a lineup.
- Select many comics and remove them in one go, with Undo.
</details>

<details>
<summary><b>Running it</b></summary>

- One installer each for Ubuntu (even from a USB stick), Windows and macOS, plus Docker.
- Survives restarts, power cuts and closed lids, and catches up on DMs that arrived while it was down (without auto-replying to any of them).
- Restart the worker, restart Ollama, read logs and approve curators from the app's **Server** page.
- Invite-only: other curators sign in, an admin approves them, and they link their own WhatsApp.
- Push notifications for the things you'd want to know: an account moved servers, WhatsApp needs a rescan, a server went quiet.
- Admin tools for cleaning up: delete a curator's data by scope, remove a user, wipe demo sandboxes.
</details>

## Several laptops, one lineup

Run as many servers as you like against the same project: a Mac, a Windows laptop, an Ubuntu box in a cupboard. Each WhatsApp account runs on exactly one of them at a time.

```mermaid
sequenceDiagram
  participant A as Server A (holds the account)
  participant F as Firestore + Cloud Storage
  participant B as Server B (standing by)
  loop every 30 s
    A->>F: renew lease
  end
  A->>F: encrypted login copy (versioned)
  Note over A: power cut, closed lid, no internet
  A--xA: can't renew for 90 s, stops its own WhatsApp
  B->>F: lease silent for 150 s, claim it
  F-->>B: newest encrypted login copy
  Note over B: back online, no QR scan
```

- **No double replies.** A server that can't renew its lease shuts its own WhatsApp off before anyone else is allowed to take over.
- **No QR scans on failover.** The login is encrypted on the server (AES-256-GCM, one key per account) before it goes to Cloud Storage, and the newest version always wins.
- **Least busy server wins**, and a curator can pin themselves to one. "Local only" accounts only ever land on servers running Gemma. Gemini-only servers handle the rest.
- **One key per device.** Lose a laptop, revoke its key, the others keep going.

The user guide is in [docs/multi-server.md](docs/multi-server.md) and the protocol in [docs/fleet.md](docs/fleet.md).

## Run a server

| Platform | How |
| --- | --- |
| **Ubuntu** (laptop, mini PC, or a USB stick) | `curl -fsSL https://spot-solutions.web.app/install.sh \| sudo bash` · [guide](docs/ubuntu-usb-server.md) |
| **Windows 10/11** | Download [SpotSolutions-Windows.zip](https://spot-solutions.web.app/dl/SpotSolutions-Windows.zip), unzip, double-click **Install Spot Solutions.cmd** · [guide](docs/windows-server.md) |
| **macOS** | `curl -fsSL https://spot-solutions.web.app/install-mac.sh \| bash` (installs the Spot Server menu-bar app) · [guide](docs/mac-server.md) |
| **Docker** | `docker compose -f deploy/docker-compose.yml up -d` |

Every installer can skip the local model for a **Gemini-only** server. After installing, paste the server's own service-account key into the Server Console (create one per device with `deploy/new-server-key.sh <device>`), then open the app, go to **Settings → Show QR code**, and scan it from WhatsApp → Linked devices.

> [!IMPORTANT]
> Upgrading from an older release? Stop the old server before the new one links. Servers from before multi-server support don't know about leases, so new servers pause and show a notice while one is online.

## Develop

Requirements: Node 22, pnpm 9, [Ollama](https://ollama.com), and a Firebase project with Firestore and Google sign-in.

```bash
pnpm install
ollama pull gemma3:4b

cp apps/worker/.env.example apps/worker/.env   # service-account key path, admin emails
cp apps/web/.env.example apps/web/.env         # Firebase web config
pnpm dev:worker
pnpm dev:web
```

```bash
pnpm test                       # shared + worker tests
cd apps/web && npx tsc -b       # strict build check
pnpm --filter @spot/worker exec tsx scripts/eval-intent.ts gemma3:4b   # intent fixtures against your local model
```

```
apps/web         React + Vite app (Material 3, PWA) on Firebase Hosting
apps/worker      Node worker: WhatsApp sessions, Gemma intake, commands, fleet, login vault
packages/shared  Types and pure logic shared by both (templates, weeks, rules, fleet)
deploy           Installers for Ubuntu, Windows, macOS, Docker, and per-device key scripts
docs             Guides and the fleet protocol
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Safety and privacy

- **Nothing is sent without your OK.** Confirmations and regrets go out only when you press send.
- **Auto-acknowledge is off by default.** When on, it replies only to a quoted ask at 85%+ confidence, in a message under 10 minutes old, from a real person (never a business account).
- **Your voice reads only what you sent**, keeps a short description and up to 15 examples, and never stores the chats. Off until you turn it on.
- **No cloud model reads your chats** unless you allow Gemini as a backup. "Local only" turns it off entirely.
- Chats from before you linked are only read when you run **Scan past messages** yourself (Requests, ⋯ menu). It runs on your own server, sends nothing to anyone, and saves only the spot requests it finds.
- Security details and how to report a problem: [SECURITY.md](SECURITY.md).

> [!NOTE]
> Spot Solutions uses [whatsapp-web.js](https://wwebjs.dev), an unofficial WhatsApp Web client. It isn't affiliated with WhatsApp, and automated use can get a number restricted. Every send is queued with a 3 to 8 second gap and a typing indicator to keep volume human. Use it at your own risk.

## Credits

- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) (Apache-2.0)
- [Gemma](https://ai.google.dev/gemma) by Google, served by [Ollama](https://ollama.com)
- [Solar icons](https://www.figma.com/community/file/1166831539721848736) by 480 Design (CC BY 4.0)
- [Material Color Utilities](https://github.com/material-foundation/material-color-utilities) (Apache-2.0)

Built for the [DEV Hacktoberfest 2026 Open-Source AI Challenge](https://dev.to/challenges/hacktoberfest-week3-2026-10-19) (Week 3: *Slow and Steady*).

MIT © Amrit Dash
