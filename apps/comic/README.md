# Nothing BOT Comedy (apps/comic)

## Run it signed in, without touching the real project

Uses the Firebase emulators (Auth + Firestore) with a `demo-nbot` project id. Needs Java and firebase-tools.

```
cd apps/comic
pnpm emulators        # terminal 1: Auth on 9099, Firestore on 8080, loads ../../firestore.rules
pnpm dev:emulator     # terminal 2: http://localhost:5175 (reads .env.emulator, VITE_USE_EMULATORS=1)
```

On the sign-in page tap "Sign in as the emulator test user" (creates a throwaway local user). Rooms > the menu > "Load the
Bangalore starter" > Apply fills it. Emulator data is wiped when the emulators stop. The switch only works in `vite dev`.

Without any sign-in: `pnpm dev`, then open `/dev/rooms` (Bangalore seed) or `/dev/rooms?empty=1`. In memory, nothing is saved.
