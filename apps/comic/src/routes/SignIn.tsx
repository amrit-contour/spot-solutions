import { signInWithPopup } from "firebase/auth";
import { toast } from "sonner";
import { Button, Logo } from "@spot/ui";
import { auth, google } from "@spot/ui/firebase";

export function SignIn() {
  const go = () =>
    void signInWithPopup(auth, google).catch((e: { code?: string }) => {
      if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") toast.error("Couldn't sign in. Allow popups and try again.");
    });
  return (
    <main className="grid min-h-dvh place-items-center bg-surface px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <Logo className="size-16" />
        <div>
          <h1 className="type-headline-m">Nothing BOT Comedy</h1>
          <p className="mt-2 type-body-l text-on-surface-variant">Rooms, spot asks and group alerts for comics. Sign in with the same Google account as Nothing BOT Curating.</p>
        </div>
        <Button size="lg" onClick={go}>
          Continue with Google
        </Button>
      </div>
    </main>
  );
}
