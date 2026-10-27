import { signOut, type User } from "firebase/auth";
import { clearChatCache } from "../lib/chatCache";
import { motion } from "motion/react";
import type { AccessEntry } from "@spot/shared";
import { auth } from "@spot/ui/firebase";
import { isAdmin, useAccessConfig } from "../lib/access";
import { Button, sharpPhoto } from "@spot/ui";
import { IconClock, IconLogout, IconShield } from "@spot/ui";

export function Waiting({ user, entry }: { user: User; entry: AccessEntry | null }) {
  const cfg = useAccessConfig();
  const removed = entry?.status === "removed";
  const admin = isAdmin(cfg, user.email);
  return (
    <div className="grid min-h-dvh place-items-center bg-surface px-4 py-10">
      <motion.div
        initial={{ opacity: 0, transform: "translateY(8px)" }}
        animate={{ opacity: 1, transform: "translateY(0px)" }}
        transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
        className="w-full max-w-md text-center"
      >
        <span className={`mx-auto grid size-16 place-items-center rounded-xl-plus ${removed ? "bg-error-container text-on-error-container" : "bg-surface-high text-primary"}`}>
          {removed ? <IconShield className="icon size-8" /> : <IconClock className="icon size-8" />}
        </span>
        <h1 className="mt-5 type-headline-m text-balance">{removed ? "Your access was removed" : "Waiting for approval"}</h1>
        <p className="mt-3 type-body-l text-on-surface-variant">
          {removed
            ? "The person running this Nothing BOT Server has removed your access. Reach out to them if that's a mistake."
            : admin
              ? "You're an admin of this server, so you'll be let in automatically as soon as it's online. If this takes more than a minute, check the server is running."
              : "Nothing BOT Curate is invite-only. The person running this server has been told you asked to join. This page opens by itself once they approve you."}
        </p>
        <p className="mt-6 inline-flex items-center gap-2 rounded-full bg-surface-container px-4 py-2 type-label-l text-on-surface-variant">
          {user.photoURL && <img src={sharpPhoto(user.photoURL)} alt="" referrerPolicy="no-referrer" className="size-6 rounded-full" />}
          <span className="text-on-surface-variant/80">Signed in as</span> <span className="text-on-surface">{user.email}</span>
        </p>
        <div className="mt-8">
          <Button variant="text" icon={IconLogout} onClick={() => void clearChatCache().finally(() => signOut(auth))}>
            Switch account
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
