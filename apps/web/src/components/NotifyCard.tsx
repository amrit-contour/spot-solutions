// Settings → WhatsApp: push notifications on this device.
import { useState } from "react";
import { toast } from "sonner";
import { useApp } from "../lib/app";
import { isDemoUser } from "../lib/demo";
import { disablePush, enablePush, usePushState } from "../lib/push";
import { IconPhone } from "./icons";
import { Switch } from "./ui";

export function NotifyCard() {
  const { uid } = useApp();
  const [state, setState] = usePushState(uid);
  const [busy, setBusy] = useState(false);
  const demo = isDemoUser();

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        await enablePush(uid);
        setState("on");
        toast.success("Notifications are on for this device");
      } else {
        await disablePush(uid);
        setState("off");
      }
    } catch (e) {
      toast.error((e as Error).message);
      if ("Notification" in window && Notification.permission === "denied") setState("denied");
    } finally {
      setBusy(false);
    }
  };

  const note =
    demo ? "Sign in with Google to get notifications."
    : state === "ios-install" ? "On iPhone and iPad, notifications only work once the app is on your home screen. Tap Share, choose Add to Home Screen, then open it from there."
    : state === "unsupported" ? "This browser can't show notifications. Try Chrome, Edge or Firefox, or install the app."
    : state === "denied" ? "Blocked for this site. Allow notifications in your browser's site settings, then reload."
    : "Get a heads-up when your WhatsApp needs a scan or your account moves to another server.";

  return (
    <section className="rounded-xl bg-surface-low p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <IconPhone className="icon size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="type-title-m">Notifications on this device</h2>
          <p className="type-body-s text-on-surface-variant">{note}</p>
        </div>
        <Switch checked={state === "on"} onChange={(v) => void toggle(v)} label="Notifications on this device" disabled={busy || demo || state === "ios-install" || state === "unsupported" || state === "denied"} />
      </div>
    </section>
  );
}
