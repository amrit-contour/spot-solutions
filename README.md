# Spot Solutions

Open-mic lineup curation on autopilot. Comics DM you for spots on WhatsApp; a **local Gemma model** works out who's actually asking, acknowledges them, and drops them into a dashboard where you drag names into shows and hit send. Everyone who didn't make it gets a polite regret, and each show's WhatsApp group is updated to match the lineup.

Built for the DEV Hacktoberfest 2026 Open-Source AI Challenge (Week 3: *Slow and Steady*).

## How it works

```
Web app (React, Firebase Hosting) ──▶ Firestore ◀── Worker on your laptop
  Google sign-in, lineup board         realtime      whatsapp-web.js (1 session / curator)
  writes commands + config             uid-scoped    Ollama · gemma3:4b  (Gemini API fallback)
```

The worker only makes outbound connections. No ports, no tunnel. The web app drops `commands` into Firestore and the worker executes them.

- **Intake:** inbound DMs are debounced per chat (45s), so "hey" … "monday?" … "got a new 5" is classified as one request. Chats that aren't spot requests are never stored.
- **Gemma:** evidence-first JSON prompt (English, Hinglish, Kannada slang). It runs locally via Ollama, and falls back to Gemma on the Gemini API only if the local model fails.
- **Messages:** acknowledgement, confirmation and regret templates use `{{name}}`, `{{show}}`, `{{venue}}`, `{{day}}`, `{{date}}`, `{{time}}`, `{{minutes}}` and `{{mapsLink}}`, plus optional sections such as `{{#minutes}}…{{/minutes}}`.
- **Fairness helpers:** a "performed last week" flag, experience tiers, Gemma's day-preference chips, and "repeat last week's lineup" for weeks after a cancelled mic.
- **Request rules (from V1):** a weekly request window (e.g. Sat 3 PM–Mon 10 AM), skipping last week's performers, and host/ignore/ban lists. Rule-breakers land in a *Held* tab.
- **Spot history:** every comic carries "last spot N days ago" and a cancellation count, and "mic didn't happen" stops a canned show from counting.
- **Comic self-service:** "can't make it Monday", "am I up this week?" and "when was my last spot?" are understood and drafted as replies. A cancellation frees the slot once you send.
- **Group sync:** after confirming, you review who gets added to and removed from the show group. Admins, regulars and protected members always stay. Or set a show to update its group automatically on the day and post the lineup there.

## Run it

Requirements: Node 22, pnpm 9, [Ollama](https://ollama.com), and a Firebase project with Firestore and Google sign-in enabled.

```bash
pnpm install
ollama pull gemma3:4b

# worker
cp apps/worker/.env.example apps/worker/.env      # add a service-account key path
pnpm dev:worker

# web
cp apps/web/.env.example apps/web/.env            # Firebase web config
pnpm dev:web
```

Open the app, sign in, go to **Settings → Show QR code**, and scan it from WhatsApp (Linked devices).

`pnpm --filter @spot/worker exec tsx scripts/eval-intent.ts gemma3:4b` runs the intent fixtures against your local model.

## Run it 24/7 on an old laptop

See **[docs/ubuntu-usb-server.md](docs/ubuntu-usb-server.md)**: install Ubuntu Server onto a pen drive, then run one command:

```bash
curl -fsSL https://raw.githubusercontent.com/amrit-dash/spot-solutions/main/deploy/install.sh | sudo bash
```

Or use Docker: `docker compose -f deploy/docker-compose.yml up -d`.

**On Windows**, open PowerShell as Administrator:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
irm https://raw.githubusercontent.com/amrit-dash/spot-solutions/main/deploy/install-windows.ps1 | iex
```

It installs Node, Git, Ollama and Gemma with winget, runs the worker as a startup task that restarts on crash, and keeps the laptop awake while plugged in.

## Safety

Nothing is sent from your WhatsApp unless you choose it:
- Confirmations and regrets go out only when you press send.
- Auto-acknowledge is **off by default**. When on, it replies only when Gemma quotes a real ask from the message (verified against the text) at 85%+ confidence, in a message under 10 minutes old, from a non-business account.
- Chats from before you linked are never read.

## A note on WhatsApp

This uses [whatsapp-web.js](https://wwebjs.dev), an unofficial WhatsApp Web client. It isn't affiliated with WhatsApp, and automated use can get a number restricted. Spot Solutions keeps volume human: every send is queued with a 3–8s gap and a typing indicator. Use it at your own risk.

## Credits

- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) (Apache-2.0)
- [Gemma](https://ai.google.dev/gemma) by Google, served by [Ollama](https://ollama.com)
- [Solar icons](https://www.figma.com/community/file/1166831539721848736) by 480 Design (CC BY 4.0)
- [Material Color Utilities](https://github.com/material-foundation/material-color-utilities) (Apache-2.0)

MIT © Amrit Dash
