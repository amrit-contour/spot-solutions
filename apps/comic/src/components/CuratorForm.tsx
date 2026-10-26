import { useState } from "react";
import { newCuratorId, validateCurator, type Curator } from "../lib/rooms";
import { Button, Field, TextArea, TextInput } from "@spot/ui";

/** Add or edit one curator. Validates with plain messages, then hands back the curator (the caller saves it). */
export function CuratorForm({ initial, existingIds, onSave, onCancel, saving }: { initial?: Curator; existingIds: string[]; onSave: (c: Curator) => void; onCancel: () => void; saving?: boolean }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [instagram, setInstagram] = useState(initial?.instagram ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const c: Curator = { ...(initial ?? { id: newCuratorId(name, existingIds) }), name: name.trim(), phone: phone.trim() || undefined, instagram: instagram.trim().replace(/^@/, "") || undefined, notes: notes.trim() || undefined };
    const problem = validateCurator(c);
    if (problem) return setError(problem);
    setError(null);
    onSave(c);
  };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Field label="Name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Akhil" autoFocus />
      </Field>
      <Field label="WhatsApp number (optional)" hint="With the country code if it isn't India, like +44 7700 900123.">
        <TextInput value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" inputMode="tel" autoComplete="off" />
      </Field>
      <Field label="Instagram (optional)">
        <TextInput value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="comedybandar" autoCapitalize="none" autoCorrect="off" />
      </Field>
      <Field label="Notes (only you see these)">
        <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-20" placeholder="Replies fast on weekdays" />
      </Field>
      {error && (
        <p role="alert" className="type-body-s text-error">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="text" onClick={onCancel}>Cancel</Button>
        <Button onClick={submit} loading={saving}>{initial ? "Save curator" : "Add curator"}</Button>
      </div>
    </div>
  );
}
