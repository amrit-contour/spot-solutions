// Settings → Your voice → Choose chats: pick which of your chats "Learn my voice" reads (only your own messages in them).
// The list comes live from your WhatsApp as names only and is never stored; what is saved is the ones you tick (id + name).
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { toggleVoiceChats, type VoiceSourceChat, type VoiceSourceItem } from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand, timeAgo } from "../lib/data";
import { Avatar, Button, Segmented, Sheet, Spinner, cx } from "@spot/ui";
import { IconCheck, IconSearch } from "@spot/ui";

export function VoiceSourcesSheet({ open, onClose, value, onSave }: { open: boolean; onClose: () => void; value: VoiceSourceChat[]; onSave: (chats: VoiceSourceChat[]) => void | Promise<void> }) {
  const { uid } = useApp();
  const [items, setItems] = useState<VoiceSourceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<VoiceSourceChat[]>(value);
  const [tab, setTab] = useState<"groups" | "people">("groups");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPicked(value);
    setError(null);
    setItems(null);
    let live = true;
    runCommand<{ chats: VoiceSourceItem[] }>(uid, "list_voice_sources", {}, 120_000, { ephemeral: true })
      .then((r) => live && setItems(r.chats))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, uid]);

  const ids = useMemo(() => new Set(picked.map((c) => c.id)), [picked]);
  const needle = q.trim().toLowerCase();
  const inView = useMemo(() => (items ?? []).filter((c) => c.isGroup === (tab === "groups") && (!needle || c.name.toLowerCase().includes(needle) || c.id.split("@")[0].includes(needle.replace(/\D/g, "") || "\u0000"))), [items, tab, needle]);
  const allIn = inView.length > 0 && inView.every((c) => ids.has(c.id));
  const count = (g: boolean) => (items ?? []).filter((c) => c.isGroup === g).length;
  const toggle = (c: VoiceSourceItem) => setPicked((p) => toggleVoiceChats(p, [c], !ids.has(c.id)));

  const save = async () => {
    setSaving(true);
    try {
      await onSave(picked);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Choose chats to learn from"
      footer={
        <>
          <span className="mr-auto type-body-m text-on-surface-variant tabular">{picked.length} chosen</span>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button loading={saving} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <p className="mb-4 type-body-m text-on-surface-variant">Only messages <b>you</b> sent in these chats are read, to learn how you write. Other people's messages are never read, and nothing from the chats is stored.</p>
      {error ? (
        <p role="alert" className="rounded-lg bg-error-container px-4 py-3 type-body-m text-on-error-container">{error}</p>
      ) : !items ? (
        <div className="grid place-items-center py-16 text-primary"><Spinner className="size-7" /></div>
      ) : (
        <>
          <div className="sticky top-0 z-10 -mx-4 flex flex-col gap-2 bg-surface px-4 pb-3 sm:-mx-8 sm:px-8">
            <label className="relative block">
              <IconSearch className="icon pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-on-surface-variant" />
              <input value={q} onChange={(e) => setQ(e.target.value)} type="search" aria-label="Search chats" placeholder="Search name or number" className="h-11 w-full rounded-full border border-outline-variant bg-surface-low pr-3 pl-10 text-base outline-none focus:border-primary" />
            </label>
            <Segmented full value={tab} onChange={setTab} options={[{ value: "groups", label: `Groups · ${count(true)}` }, { value: "people", label: `People · ${count(false)}` }]} />
            <button
              disabled={!inView.length}
              onClick={() => setPicked((p) => toggleVoiceChats(p, inView, !allIn))}
              className="state-layer self-start rounded-full px-3 py-1.5 type-label-l text-primary disabled:opacity-40"
            >
              {allIn ? "Clear" : "Select all"} {needle ? "shown" : tab === "groups" ? "groups" : "people"} ({inView.length})
            </button>
          </div>
          {inView.length === 0 ? (
            <p className="py-10 text-center type-body-m text-on-surface-variant">{needle ? `No ${tab} match “${q.trim()}”.` : `No ${tab} found.`}</p>
          ) : (
            <ul className="flex flex-col">
              {inView.map((c) => {
                const on = ids.has(c.id);
                return (
                  <li key={c.id}>
                    <button role="checkbox" aria-checked={on} onClick={() => toggle(c)} className="state-layer flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-2 text-left">
                      <span className={cx("grid size-6 flex-none place-items-center rounded-xs border-2", on ? "border-primary bg-primary text-on-primary" : "border-outline")}>{on && <IconCheck className="icon size-4" />}</span>
                      <Avatar name={c.name} size={36} tone={c.isGroup ? "tertiary" : "primary"} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate type-title-s">{c.name}</span>
                        <span className="block type-body-s text-on-surface-variant">{c.lastAt ? `Last active ${timeAgo(c.lastAt)}` : "No recent activity"}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Sheet>
  );
}
