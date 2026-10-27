import { useState } from "react";
import type { User } from "firebase/auth";
import { toast } from "sonner";
import { Button, Field, Sheet, TextArea, TextInput } from "@spot/ui";
import type { MemberEntry } from "../../lib/members";
import { MemberPicker } from "../MemberPicker";
import { useRoster } from "../../lib/roster";
import { sendShare } from "../../lib/rosters";

/** Send a copy of some of my rooms to one other member. They find it in Community, review it and take what they want. */
export function ShareSheet({ open, onClose, user }: { open: boolean; onClose: () => void; user: User }) {
  const store = useRoster();
  const [to, setTo] = useState<MemberEntry | null>(null);
  const [title, setTitle] = useState("My rooms");
  const [note, setNote] = useState("");
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTo(null);
      setNote("");
      setSkip(new Set());
      setError("");
    }
  }

  const picked = store.rooms.filter((r) => !skip.has(r.id));
  const toggle = (id: string) => setSkip((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const send = async () => {
    setError("");
    if (!to) return setError("Pick who to share with.");
    if (!title.trim()) return setError("Give it a short title.");
    if (picked.length === 0) return setError("Pick at least one room.");
    setBusy(true);
    try {
      await sendShare(to, user, { title, note, roster: { rooms: picked, curators: store.curators } });
      toast.success(`Sent to ${to.name}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error && !/permission|insufficient/i.test(e.message) ? e.message : "Couldn't send it. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Share with someone"
      footer={
        <>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void send()} loading={busy}>Send</Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        <p className="type-body-l text-on-surface-variant">
          They get a copy in Community and choose what to take. It is a snapshot: later changes to your rooms aren't sent. Your notes, role and spots stay private.
        </p>
        <MemberPicker label="Share with" hint="Anyone approved in the app. Type a name or email." value={to} onChange={setTo} exclude={[user.uid]} />
        <Field label="Title">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} />
        </Field>
        <Field label="A message (optional)">
          <TextArea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className="min-h-20" placeholder="These are the Sunday mics I know" />
        </Field>
        <section className="min-w-0">
          <div className="mb-2 flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate type-title-m">Rooms to send ({picked.length})</h3>
            <Button size="sm" variant="text" onClick={() => setSkip(skip.size ? new Set() : new Set(store.rooms.map((r) => r.id)))}>{skip.size ? "All" : "None"}</Button>
          </div>
          <ul className="flex min-w-0 flex-col overflow-hidden rounded-md bg-surface-low">
            {store.rooms.map((r) => (
              <li key={r.id} className="min-w-0 border-b border-outline-variant/40 last:border-b-0">
                <label className="state-layer flex min-h-12 min-w-0 cursor-pointer items-center gap-3 px-3 py-2">
                  <input type="checkbox" className="size-5 flex-none accent-[var(--md-sys-color-primary)]" checked={!skip.has(r.id)} onChange={() => toggle(r.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate type-body-l">{r.name}</span>
                    <span className="block truncate type-body-s text-on-surface-variant">{[r.area, r.city].filter(Boolean).join(" · ")}</span>
                  </span>
                </label>
              </li>
            ))}
            {store.rooms.length === 0 && <li className="px-3 py-4 type-body-m text-on-surface-variant">You have no rooms yet.</li>}
          </ul>
        </section>
        {error && <p role="alert" className="rounded-md bg-error-container p-4 type-body-m text-on-error-container">{error}</p>}
      </div>
    </Sheet>
  );
}
