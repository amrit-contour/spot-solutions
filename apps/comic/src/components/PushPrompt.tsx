import { useState } from "react";
import { toast } from "sonner";
import { Button, IconBell, IconPhone } from "@spot/ui";
import { disablePush, enablePush, usePushState } from "../lib/push";

/** The card that turns spot alerts on for this device. Hidden once they are on. */
export function PushPrompt({ uid, always }: { uid: string; /** Show the "on" state too (Settings). */ always?: boolean }) {
  const [state, setState] = usePushState(uid);
  const [busy, setBusy] = useState(false);
  if (state === "on" && !always) return null;

  const turnOn = async () => {
    setBusy(true);
    try {
      await enablePush(uid);
      setState("on");
      toast.success("Spot alerts are on for this device");
    } catch (e) {
      toast.error((e as Error).message);
      if (typeof Notification !== "undefined" && Notification.permission === "denied") setState("denied");
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    setBusy(true);
    await disablePush(uid);
    setState("off");
    setBusy(false);
  };

  const text =
    state === "on"
      ? "This device gets a notification the moment a spot is offered in a group you watch."
      : state === "ios-install"
        ? "On iPhone, notifications work once the app is on your Home Screen: tap Share, then Add to Home Screen, and open it from there."
        : state === "denied"
          ? "Notifications are blocked for this site. Allow them in your browser's site settings, then come back."
          : state === "unsupported"
            ? "This browser can't show notifications. Try Chrome, Edge or Safari, or install the app."
            : "Get a notification the moment a spot is offered in a group you watch, with an Ask for it button.";

  return (
    <div className="flex min-w-0 items-start gap-3 rounded-lg bg-surface-low p-4">
      <span className="grid size-10 flex-none place-items-center rounded-md bg-primary-container text-on-primary-container">
        {state === "ios-install" ? <IconPhone className="icon size-5" /> : <IconBell className="icon size-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="type-title-m">{state === "on" ? "Spot alerts are on" : "Turn on spot alerts"}</p>
        <p className="mt-0.5 type-body-m text-on-surface-variant">{text}</p>
        {state === "off" && (
          <Button className="mt-3" size="sm" icon={IconBell} loading={busy} onClick={() => void turnOn()}>
            Turn on
          </Button>
        )}
        {state === "on" && always && (
          <Button className="mt-3" size="sm" variant="outlined" loading={busy} onClick={() => void turnOff()}>
            Turn off on this device
          </Button>
        )}
      </div>
    </div>
  );
}
