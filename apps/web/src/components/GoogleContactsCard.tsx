// Settings → WhatsApp: save comic names to Google Contacts so phone, WhatsApp and the server all show them.
import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useApp } from "../lib/app";
import { isDemoUser } from "../lib/demo";
import { connectGoogleContacts, googleTokenExpiry, hasGoogleToken, onGoogleToken } from "../lib/googleContacts";
import { callableMessage, disconnectGoogleServer, keepGoogleConnected, useServerLink, wasCancelled } from "../lib/googleServer";
import { useGoogleSync } from "./GoogleContactsSync";
import { IconUserCheck } from "./icons";
import { Button, Switch, cx } from "./ui";

export function GoogleContactsCard() {
  const { settings, saveSettings, comics, comicsLoaded } = useApp();
  const demo = isDemoUser();
  const connected = useSyncExternalStore(onGoogleToken, hasGoogleToken);
  const until = useSyncExternalStore(onGoogleToken, googleTokenExpiry);
  const [connecting, setConnecting] = useState(false);
  const sync = useGoogleSync();
  const link = useServerLink();
  const [keeping, setKeeping] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const server = link.state === "connected";
  const enabled = settings.googleContacts.enabled;

  const connect = async () => {
    setConnecting(true);
    try {
      await connectGoogleContacts();
      toast.success("Google Contacts is connected");
      return true;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") toast.error((e as Error).message);
      return false;
    } finally {
      setConnecting(false);
    }
  };

  // One consent, then the server keeps access (encrypted) and saves names whether or not this app is open.
  const keep = async () => {
    setKeeping(true);
    try {
      const r = await keepGoogleConnected();
      await saveSettings({ googleContacts: { enabled: true } });
      toast.success(`Google Contacts is connected as ${r.email}`);
    } catch (e) {
      if (!wasCancelled(e)) toast.error(callableMessage(e));
    } finally {
      setKeeping(false);
    }
  };

  const disconnect = async () => {
    setLeaving(true);
    try {
      await disconnectGoogleServer();
      await saveSettings({ googleContacts: { enabled: false } });
      toast.success("Google Contacts disconnected");
    } catch (e) {
      toast.error(callableMessage(e));
    } finally {
      setLeaving(false);
    }
  };

  const toggle = async (on: boolean) => {
    // Turning it on needs access, and this click is the one place a popup is allowed. A kept connection needs neither.
    if (on && !server && !hasGoogleToken() && !(await connect())) return;
    await saveSettings({ googleContacts: { enabled: on } });
  };

  return (
    <section className="rounded-xl bg-surface-low p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <IconUserCheck className="icon size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="type-title-m">Google Contacts</h2>
          <p className="type-body-s text-on-surface-variant">
            {demo ? "Sign in with Google to save names to your contacts." : "Save comic names to your Google Contacts. Your phone and WhatsApp then show them too."}
          </p>
        </div>
      </div>

      <div className={cx("mt-4 flex flex-col gap-4", demo && "pointer-events-none opacity-50")} aria-disabled={demo}>
        <div className="flex flex-col gap-2">
          {server ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="type-label-l text-on-surface">Saving to the contacts of {link.email} · always on</span>
              <Button variant="outlined" onClick={() => void disconnect()} loading={leaving} disabled={demo}>
                Disconnect
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="tonal" onClick={() => void keep()} loading={keeping} disabled={demo || connecting}>
                  Keep connected
                </Button>
                <span className={cx("type-label-m", link.state === "revoked" ? "text-error" : "text-on-surface-variant")}>
                  {link.state === "revoked" ? "Disconnected: access was removed from your Google account" : "Not connected"}
                </span>
              </div>
              <p className="type-body-s text-on-surface-variant">
                Say yes once and names keep saving to your Google Contacts even when this app is closed. Nothing BOT Curating keeps the access encrypted on its server, and you can disconnect here or at myaccount.google.com/permissions any time.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="text" onClick={() => void connect()} loading={connecting} disabled={demo || keeping}>
                  {connected || enabled ? "Reconnect for this visit only" : "Connect for this visit only"}
                </Button>
                <span className={cx("type-label-m", !connected && enabled ? "text-error" : "text-on-surface-variant")}>
                  {connected && until
                    ? `Connected until ${new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                    : enabled
                      ? "Paused: keep connected, or reconnect to keep saving names"
                      : ""}
                </span>
              </div>
              <p className="type-body-s text-on-surface-variant">
                A visit-only connection lasts an hour and is forgotten when you reload the page, and nothing is saved while the app is closed.
              </p>
            </>
          )}
          <p className="type-body-s text-on-surface-variant">The first time, Google may say “Google hasn't verified this app”. Choose Advanced, then continue. Only names and phone numbers are used, and nothing is ever deleted.</p>
        </div>

        <div className="flex min-h-12 items-center gap-4">
          <span className="min-w-0 flex-1 type-title-s">Save names to Google Contacts when I add or rename a comic</span>
          <Switch checked={enabled} onChange={(v) => void toggle(v)} label="Save names to Google Contacts when I add or rename a comic" disabled={demo || connecting || keeping || leaving} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="tonal" onClick={() => void sync.start(comics)} loading={sync.planning} disabled={demo || !comicsLoaded || !comics.length}>
            Sync all comics now
          </Button>
          <span className="type-body-s text-on-surface-variant">You'll see what changes before anything is saved.</span>
        </div>
      </div>
      {sync.dialog}
    </section>
  );
}
