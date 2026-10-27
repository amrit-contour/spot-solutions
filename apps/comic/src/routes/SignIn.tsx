import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signInWithPopup } from "firebase/auth";
import { toast } from "sonner";
import { Button } from "@spot/ui";
import { ComicLogo } from "../components/ComicLogo";
import { auth, google } from "@spot/ui/firebase";

export function SignIn() {
  const go = () =>
    void signInWithPopup(auth, google).catch((e: { code?: string }) => {
      if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") toast.error("Couldn't sign in. Allow popups and try again.");
    });
  // Emulator mode only (pnpm dev:emulator): a throwaway local user, so signed-in pages can be tried without Google.
  const emulatorUser = () => {
    const email = "tester@example.test";
    const password = "emulator-only";
    void signInWithEmailAndPassword(auth, email, password).catch(() => createUserWithEmailAndPassword(auth, email, password));
  };
  return (
    <main className="grid min-h-dvh place-items-center bg-surface px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <ComicLogo className="size-16" />
        <div>
          <h1 className="type-headline-m">Nothing BOT Comedy</h1>
          <p className="mt-2 type-body-l text-on-surface-variant">Rooms, spot asks and group alerts for comics. Sign in with the same Google account as Nothing BOT Curating.</p>
        </div>
        <Button size="lg" onClick={go}>
          Continue with Google
        </Button>
        <p className="type-body-s text-on-surface-variant">
          <a className="underline underline-offset-4" href="/privacy">Privacy</a> · <a className="underline underline-offset-4" href="/terms">Terms</a>
        </p>
        {import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === "1" && (
          <Button variant="outlined" onClick={emulatorUser}>
            Sign in as the emulator test user
          </Button>
        )}
      </div>
    </main>
  );
}
