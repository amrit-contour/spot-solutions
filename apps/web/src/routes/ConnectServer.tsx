// /connect-server?c=<code>: an admin approves a server console that asked to join (functions/src/link.ts).
// Works signed out (offers Google sign-in) and for non-admins (tells them to ask an admin). The key never passes
// through this page: the console collects it by itself once approved.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { signInWithPopup, signOut, type User } from "firebase/auth";
import { motion } from "motion/react";
import { toast } from "sonner";
import { auth, google } from "@spot/ui/firebase";
import { useNow } from "../lib/data";
import { approveDeviceLink, getDeviceLink, joinError, type DeviceLink } from "../lib/joinServer";
import { CuratingLogo } from "../components/CuratingLogo";
import { Button, Card, Chip, Spinner, buttonClass } from "@spot/ui";
import { IconCheck, IconLogout, IconServer, IconShield } from "@spot/ui";

const fmtLeft = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

type Load = { state: "loading" } | { state: "ready"; link: DeviceLink } | { state: "error"; message: string };

export function ConnectServer({ user }: { user: User | null | undefined }) {
  const code = new URLSearchParams(location.search).get("c")?.trim() ?? "";
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [busy, setBusy] = useState<"google" | "approve" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const now = useNow(1_000);
  const uid = user?.uid;

  const refresh = useCallback(async () => {
    if (!code || !uid) return;
    try {
      setLoad({ state: "ready", link: await getDeviceLink(code) });
    } catch (e) {
      setLoad({ state: "error", message: joinError(e) });
    }
  }, [code, uid]);
  useEffect(() => {
    setLoad({ state: "loading" });
    void refresh();
  }, [refresh]);

  const signIn = async () => {
    setBusy("google");
    try {
      await signInWithPopup(auth, google);
    } catch (e) {
      toast.error((e as Error).message.replace("Firebase: ", ""));
    } finally {
      setBusy(null);
    }
  };
  const approve = async () => {
    setBusy("approve");
    try {
      const r = await approveDeviceLink(code);
      setDone(r.deviceName);
    } catch (e) {
      toast.error(joinError(e));
      void refresh();
    } finally {
      setBusy(null);
    }
  };

  const link = load.state === "ready" ? load.link : null;
  const left = link ? link.expiresAt - now : 0;

  let body: React.ReactNode;
  if (!code) {
    body = <Notice title="This link is missing its code">Start again from the server console: click Connect with Nothing BOT Curating there.</Notice>;
  } else if (user === undefined) {
    body = <Spinner className="mx-auto size-8 text-primary" />;
  } else if (user === null || user.isAnonymous) {
    body = (
      <>
        <h1 className="type-headline-m text-balance">Connect your server</h1>
        <p className="mt-3 type-body-l text-on-surface-variant">Sign in with the Google account you use for Nothing BOT Curating. Only admins can connect a server.</p>
        <div className="mt-6">
          <Button size="lg" loading={busy === "google"} onClick={() => void signIn()}>
            Continue with Google
          </Button>
        </div>
      </>
    );
  } else if (done) {
    body = (
      <>
        <span className="mx-auto grid size-16 place-items-center rounded-xl-plus bg-secondary-container text-on-secondary-container">
          <IconCheck className="icon size-8" />
        </span>
        <h1 className="mt-5 type-headline-m text-balance">{done} is connecting</h1>
        <p className="mt-3 type-body-l text-on-surface-variant">The server is picking up its own key and starting the worker. It shows under Account, Server in about a minute. You can close this page.</p>
        <div className="mt-6">
          <Link to="/server" className={buttonClass({ variant: "tonal" })}>
            Open the Server page
          </Link>
        </div>
      </>
    );
  } else if (load.state === "loading") {
    body = <Spinner className="mx-auto size-8 text-primary" />;
  } else if (load.state === "error") {
    body = <Notice title="This link isn't valid any more">{load.message} Start again from the server console.</Notice>;
  } else if (link && link.status !== "pending") {
    body = <Notice title="This server was already approved">Nothing more to do here. It shows under Account, Server in a minute.</Notice>;
  } else if (link && left <= 0) {
    body = <Notice title="This link expired">Links last 15 minutes. Start again from the server console.</Notice>;
  } else if (link && !link.canApprove) {
    body = (
      <>
        <span className="mx-auto grid size-16 place-items-center rounded-xl-plus bg-surface-high text-primary">
          <IconShield className="icon size-8" />
        </span>
        <h1 className="mt-5 type-headline-m text-balance">Ask an admin</h1>
        <p className="mt-3 type-body-l text-on-surface-variant">
          Only admins can connect a server. You're signed in as {user.email}. Ask an admin to open this link, or sign in with an admin account.
        </p>
      </>
    );
  } else if (link) {
    body = (
      <>
        <span className="mx-auto grid size-16 place-items-center rounded-xl-plus bg-secondary-container text-on-secondary-container">
          <IconServer className="icon size-8" />
        </span>
        <h1 className="mt-5 type-headline-m text-balance">
          Connect server <span className="break-all">{link.deviceName}</span>?
        </h1>
        <p className="mt-3 type-body-l text-on-surface-variant">It will get its own key to run WhatsApp and read your lineup data. Check that the server's console shows this code:</p>
        <div className="mx-auto mt-4 w-fit rounded-md bg-surface-container px-6 py-3 font-mono text-4xl font-semibold tracking-widest" aria-label={`Check code ${link.verify.split("").join(" ")}`}>
          {link.verify}
        </div>
        <p className="mt-4 type-body-s text-on-surface-variant">Only approve a computer you set up yourself, and only if the code matches. You'll be added as one of its admins.</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button size="lg" loading={busy === "approve"} onClick={() => void approve()}>
            Connect server
          </Button>
          <Link to="/" className={buttonClass({ variant: "text", size: "lg" })}>
            Cancel
          </Link>
        </div>
        <div className="mt-4">
          <Chip tone="neutral">Expires in {fmtLeft(left)}</Chip>
        </div>
      </>
    );
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-surface px-4 py-10">
      <motion.div
        initial={{ opacity: 0, transform: "translateY(8px)" }}
        animate={{ opacity: 1, transform: "translateY(0px)" }}
        transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
        className="w-full max-w-md text-center"
      >
        <CuratingLogo className="mx-auto mb-8 size-14" />
        <Card className="p-6 sm:p-8">{body}</Card>
        {user && !user.isAnonymous && (
          <p className="mt-6 inline-flex items-center gap-2 type-label-l text-on-surface-variant">
            {user.email}
            <Button variant="text" size="sm" icon={IconLogout} onClick={() => void signOut(auth)}>
              Use a different account
            </Button>
          </p>
        )}
      </motion.div>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h1 className="type-headline-m text-balance">{title}</h1>
      <p className="mt-3 type-body-l text-on-surface-variant">{children}</p>
    </>
  );
}
