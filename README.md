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
- **Group sync:** after confirming, you review who gets added to and removed from the show group. Admins, regulars and protected members always stay.

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

## A note on WhatsApp

This uses [whatsapp-web.js](https://wwebjs.dev), an unofficial WhatsApp Web client. It isn't affiliated with WhatsApp, and automated use can get a number restricted. Spot Solutions keeps volume human: every send is queued with a 3–8s gap and a typing indicator. Use it at your own risk.

## Credits

- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) (Apache-2.0)
- [Gemma](https://ai.google.dev/gemma) by Google, served by [Ollama](https://ollama.com)
- [Solar icons](https://www.figma.com/community/file/1166831539721848736) by 480 Design (CC BY 4.0)
- [Material Color Utilities](https://github.com/material-foundation/material-color-utilities) (Apache-2.0)

MIT © Amrit Dash
