# Contributing

Thanks for helping. This guide gets you from a fresh clone to a passing check. For how the pieces fit, read [docs/architecture.md](docs/architecture.md) first.

## Prerequisites

- **Node 22**
- **pnpm 9.15.4** (the version in `package.json`; `corepack enable` picks it up)
- **Ollama** with a Gemma model, for worker work: `ollama pull gemma3:4b`
- A **Firebase project of your own** for anything that runs the worker. Don't point a dev worker at the production project: it would act on real accounts.

## Setup

```bash
pnpm install
cp apps/web/.env.example apps/web/.env
cp apps/worker/.env.example apps/worker/.env
```

Fill in `apps/web/.env` with your Firebase web app config (`VITE_FIREBASE_*`). For `apps/worker/.env`, put a service-account key for your project at the path in `FIREBASE_SERVICE_ACCOUNT` and set `FIREBASE_PROJECT_ID`. Set `SPOT_ADMIN_EMAILS` to your own email so you are approved automatically and can see the Server page. The optional settings are commented out and fall back to sensible defaults. If you use your own project, set `SPOT_STORAGE_BUCKET` to its bucket, because the default is the production one. Deploy the rules to your project too: `firebase deploy --only firestore:rules,storage --project <your-project>`.

Then run both apps in two terminals:

```bash
pnpm dev:web      # Vite, http://localhost:5173
pnpm dev:worker   # tsx watch, restarts when you edit the worker
```

`.env` files are git-ignored. Never commit a service-account key or a Gemini key.

## Checks

Run these before you open a pull request.

```bash
pnpm test                     # Vitest in packages/shared and apps/worker
pnpm typecheck                # tsc --noEmit in packages/shared and apps/worker
cd apps/web && npx tsc -b     # strict build check for the web app
```

`pnpm typecheck` does not cover the web app, so the `tsc -b` line matters. It is the same check `pnpm --filter @spot/web build` runs before Vite, and it is what catches a broken deploy. `pnpm --filter @spot/web lint` runs oxlint.

## Try it with demo data

`apps/worker/scripts/seed-demo.ts` writes a demo curator (venue, two shows, comics, requests, a draft lineup, a held request, a drafted reply) and prints a sign-in link for `localhost`.

```bash
pnpm --filter @spot/worker exec tsx --env-file=.env scripts/seed-demo.ts [uid]
```

The default uid is `demo-curator`. In production that is the public demo template, so only run the script against your own project, or pass another uid.

## Intent eval

This runs the intent prompt against a local model on a fixture set. It needs Ollama running with the model pulled, and no Firebase credentials.

```bash
pnpm --filter @spot/worker exec tsx scripts/eval-intent.ts gemma3:4b
```

The optional second argument is the provider (`ollama` or `gemini`). It prints PASS or FAIL per message and a score for spot requests and for the other kinds (cancel, status, last spot, other). If you change the prompt in `apps/worker/src/gemma.ts`, run it before and after and put both scores in the pull request.

## Commit style

Conventional commits, as in `git log`:

```
feat(fleet): server fleet with failover and an encrypted login vault
fix(rules): allow import commands; hide admin list from demo visitors
docs: demo media for the write-up (press/)
```

Use `feat`, `fix` or `docs` (the history also has one `refine`), an optional scope in brackets, and a short lower-case summary. One logical change per commit.

## Deploy

Maintainers only. It publishes the web app, the installers and the Firestore and Storage rules:

```bash
pnpm deploy:web
```

That runs the web build, adds the installers and a source tarball to the build (`deploy/build-dist.sh`), and runs `firebase deploy --only hosting,firestore:rules,storage`. It needs the Firebase CLI signed in to the production project.

## Anything that messages comics must be opt-in

Spot Solutions sends WhatsApp messages on a curator's behalf. A wrong message goes to a real person, from the curator's own number. So:

- New automatic messaging is **off by default**, behind a setting the curator turns on. Auto-acknowledge (`ack.enabled`) and auto-send of drafted replies (`selfService.autoSend`) both start off.
- Keep the existing guards: no replies to backlog messages, none to business accounts, none for low-confidence requests, none for messages older than 10 minutes.
- Drafts first. If a feature can write to a comic, it should draft the message and let the curator send it, unless they opted into automatic sending.
- Send through the queue (`apps/worker/src/sendQueue.ts`) so messages keep their delay.
- Read-only by default on a fresh link: only messages that arrive after linking are read.

A pull request that sends a message the curator did not opt into needs to change before it can be merged.
