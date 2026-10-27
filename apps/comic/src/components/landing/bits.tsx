// Small building blocks shared by the signed-out landing page.
import { useRef, useState, type ReactNode } from "react";
import { signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { motion, useInView } from "motion/react";
import { toast } from "sonner";
import { auth, google } from "@spot/ui/firebase";
import { Button, cx } from "@spot/ui";
import { useInstall } from "../../lib/install";

export const EASE = [0.23, 1, 0.32, 1] as const;

export function useSignIn() {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await signInWithPopup(auth, google);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") toast.error("Couldn't sign in. Allow popups and try again.");
      setBusy(false);
    }
  };
  // Emulator mode only (pnpm dev:emulator): a throwaway local user, so signed-in pages can be tried without Google.
  const emulatorUser = () => {
    const email = "tester@example.test";
    const password = "emulator-only";
    void signInWithEmailAndPassword(auth, email, password).catch(() => createUserWithEmailAndPassword(auth, email, password));
  };
  return { busy, run, emulatorUser };
}

export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  return (
    <motion.div ref={ref} className={className} initial={{ opacity: 0, y: 24 }} animate={inView ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.6, delay, ease: EASE }}>
      {children}
    </motion.div>
  );
}

export function SectionHead({ kicker, title, children, className }: { kicker: string; title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <Reveal className={cx("max-w-2xl", className)}>
      <h2 className="type-display-s text-balance" data-section={kicker}>{title}</h2>
      {children && <p className="mt-4 type-body-l text-on-surface-variant">{children}</p>}
    </Reveal>
  );
}

const GoogleG = () => (
  <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
    <path fill="currentColor" d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.66 4.1-5.35 4.1-3.22 0-5.85-2.67-5.85-5.96S8.78 6.26 12 6.26c1.83 0 3.06.78 3.76 1.45l2.56-2.47C16.68 3.7 14.55 2.75 12 2.75 6.9 2.75 2.75 6.9 2.75 12S6.9 21.25 12 21.25c6.92 0 9.2-4.86 9.2-7.36 0-.5-.05-.88-.12-1.27z" />
  </svg>
);

/** Sign in with Google, plus "Install the app" when the browser can (or a one-line hint on iPhone). */
export function Ctas({ center = false, onDark = false }: { center?: boolean; onDark?: boolean }) {
  const { busy, run, emulatorUser } = useSignIn();
  const { installed, canPrompt, ios, install } = useInstall();
  return (
    <div className={cx("flex flex-col gap-3", center && "items-center")}>
      <div className={cx("flex flex-wrap gap-3", center && "justify-center")}>
        <Button size="lg" onClick={() => void run()} loading={busy} className={cx(onDark && "bg-on-primary-container text-primary-container")}>
          <GoogleG />
          Sign in with Google
        </Button>
        {!installed && canPrompt && (
          <Button size="lg" variant="outlined" onClick={() => void install()} className={cx(onDark && "border-current text-on-primary-container")}>
            Install the app
          </Button>
        )}
      </div>
      {!installed && !canPrompt && ios && <p className="type-body-s opacity-80">On iPhone: tap Share, then Add to Home Screen, to install.</p>}
      {import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === "1" && (
        <Button variant="outlined" size="sm" onClick={emulatorUser}>
          Sign in as the emulator test user
        </Button>
      )}
    </div>
  );
}
