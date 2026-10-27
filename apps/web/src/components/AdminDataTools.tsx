// Admin-only data tools. The browser can't delete another user's data, so these ask the server (worker) to.
// Every action first asks for a count (dry run), then deletes only after a typed confirmation.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SCOPE_LABEL, type AccessEntry, type AdminDataPayload, type AdminDataResult, type DataScope, type ServerStatus } from "@spot/shared";
import { useApp } from "../lib/app";
import { pickServer, runAdminData } from "../lib/adminData";
import { ConfirmDialog } from "@spot/ui";
import { Button, Field, Select } from "@spot/ui";
import { Collapsible } from "@spot/ui";
import { IconTrash } from "@spot/ui";

type Servers = ServerStatus[] | null;
type Type = "delete_user_data" | "remove_user" | "wipe_demo";

const SCOPES = Object.entries(SCOPE_LABEL).map(([value, label]) => ({ value, label }));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const COLLECTION_LABEL: Record<string, string> = { venues: "venues", shows: "shows", comics: "comics", requests: "requests", lineups: "lineups", actions: "actions", notices: "notices", offers: "offers", polls: "polls", groups: "groups", commands: "commands", session: "session", secrets: "API keys", profile: "profile" };

/** Ask the server what a delete would remove. */
function useCount(open: boolean, servers: Servers, type: Type, payload: AdminDataPayload) {
  const { user } = useApp();
  const [state, setState] = useState<{ result?: AdminDataResult; error?: string }>({});
  const key = JSON.stringify(payload);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setState({});
    const server = pickServer(servers, payload.uid);
    if (!server) return setState({ error: "No server is online right now." });
    runAdminData(server.id, type, { ...payload, dryRun: true }, user.email ?? user.uid, 2 * 60_000)
      .then((result) => live && setState({ result }))
      .catch((e) => live && setState({ error: (e as Error).message }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, type, key]);
  return state;
}

function Counts({ state, none }: { state: { result?: AdminDataResult; error?: string }; none: string }) {
  if (state.error) return <p className="text-error">{state.error}</p>;
  if (!state.result) return <p>Counting…</p>;
  const rows = Object.entries(state.result.counts);
  if (!rows.length) return <p>{none}</p>;
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-surface-container px-4 py-3">
      {rows.map(([k, n]) => (
        <li key={k} className="flex items-baseline justify-between gap-2">
          <span className="text-on-surface">{COLLECTION_LABEL[k] ?? k}</span>
          <span className="tabular">{n}</span>
        </li>
      ))}
    </ul>
  );
}

const who = (e: AccessEntry) => e.name ?? e.email ?? e.uid;

async function run(servers: Servers, user: { email: string | null; uid: string }, type: Type, payload: AdminDataPayload) {
  const server = pickServer(servers, payload.uid);
  if (!server) throw new Error("No server is online right now.");
  return runAdminData(server.id, type, payload, user.email ?? user.uid);
}

export function DeleteDataDialog({ entry, servers, onClose }: { entry: AccessEntry | null; servers: Servers; onClose: () => void }) {
  const { user } = useApp();
  const [scope, setScope] = useState<DataScope>("requests");
  const open = Boolean(entry);
  const payload = { uid: entry?.uid, scope };
  const state = useCount(open, servers, "delete_user_data", payload);
  const last = useLast(entry);
  const e = entry ?? last;
  if (!e) return null;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Delete ${who(e)}'s data?`}
      confirmLabel={state.result?.total ? `Delete ${plural(state.result.total, "doc")}` : "Delete"}
      disabled={!state.result?.total || !e.email}
      typed={e.email ? { expect: e.email, label: "Type their email to confirm" } : undefined}
      onConfirm={async () => {
        const r = await run(servers, user, "delete_user_data", { ...payload, confirmEmail: e.email ?? "" });
        toast.success(`Deleted ${plural(r.total, "doc")} for ${who(e)}`);
      }}
    >
      <Field label="What to delete">
        <Select value={scope} onChange={(v) => setScope(v as DataScope)} options={SCOPES} />
      </Field>
      <Counts state={state} none="Nothing there to delete." />
      <p>This can't be undone. {scope === "everything" ? "Everything also unlinks their WhatsApp on the server; they start fresh next time they sign in. Access stays as it is." : "Their access and WhatsApp link stay as they are."}</p>
    </ConfirmDialog>
  );
}

export function RemoveUserDialog({ entry, servers, onClose }: { entry: AccessEntry | null; servers: Servers; onClose: () => void }) {
  const { user } = useApp();
  const open = Boolean(entry);
  const payload = { uid: entry?.uid };
  const state = useCount(open, servers, "remove_user", payload);
  const last = useLast(entry);
  const e = entry ?? last;
  if (!e) return null;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Remove ${who(e)}?`}
      confirmLabel="Remove and delete"
      disabled={!state.result || !e.email}
      typed={e.email ? { expect: e.email, label: "Type their email to confirm" } : undefined}
      onConfirm={async () => {
        const r = await run(servers, user, "remove_user", { ...payload, confirmEmail: e.email ?? "" });
        toast.success(`${who(e)} removed. Deleted ${plural(r.total, "doc")}.`);
      }}
    >
      <p>This will:</p>
      <ul className="list-disc pl-5">
        <li>log them out of WhatsApp on the server, which unlinks their phone</li>
        <li>revoke their access to Nothing BOT Curating</li>
        <li>delete all their data:</li>
      </ul>
      <Counts state={state} none="They have no data." />
      <p>This can't be undone. Nothing is sent to anyone. Restoring them later gives an empty account.</p>
    </ConfirmDialog>
  );
}

/** Keeps the last non-null entry so the dialog's exit animation still has its text. */
function useLast<T>(v: T | null) {
  const [last, setLast] = useState<T | null>(v);
  useEffect(() => {
    if (v) setLast(v);
  }, [v]);
  return last;
}

export function WipeDemoCard({ servers }: { servers: Servers }) {
  const { user } = useApp();
  const [open, setOpen] = useState(false);
  const state = useCount(open, servers, "wipe_demo", {});
  const n = state.result?.users ?? 0;
  return (
    <>
    <Collapsible id="admin-data" title="Admin data tools" icon={IconTrash} summary="Demo sandboxes">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-60">
          <h4 className="type-label-l">Wipe demo sandboxes</h4>
          <p className="mt-0.5 max-w-prose type-body-s text-on-surface-variant">Deletes the private copies of the sample data that demo visitors get. Never touches real curators or the demo template. They are also cleaned up automatically after 7 days.</p>
        </div>
        <Button size="sm" variant="tonal" icon={IconTrash} className="text-error" onClick={() => setOpen(true)}>
          Wipe sandboxes…
        </Button>
      </div>
    </Collapsible>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Wipe demo sandboxes?"
        confirmLabel={n ? `Wipe ${plural(n, "sandbox")}` : "Wipe"}
        disabled={!n}
        typed={{ expect: "wipe demos", label: "Type “wipe demos” to confirm" }}
        onConfirm={async () => {
          const r = await run(servers, user, "wipe_demo", {});
          toast.success(`Wiped ${plural(r.users, "sandbox")}, ${plural(r.total, "doc")}`);
        }}
      >
        {state.error ? <p className="text-error">{state.error}</p> : !state.result ? <p>Counting…</p> : n ? (
          <>
            <p>
              <span className="text-on-surface">{plural(n, "demo sandbox")}</span> will be deleted, {plural(state.result.total, "document")} in all. Visitors who come back get a fresh copy.
            </p>
            <Counts state={state} none="" />
          </>
        ) : (
          <p>No demo sandboxes to wipe.</p>
        )}
      </ConfirmDialog>
    </>
  );
}
