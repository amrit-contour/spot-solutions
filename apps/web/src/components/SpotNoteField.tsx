// A short note on how a comic did on one night. Saved when you leave the field (or press done); kept with the rating.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { COMIC_NOTE_MAX, cleanNote } from "@spot/shared";
import { TextInput } from "@spot/ui";
import { useApp } from "../lib/app";
import { noteSpot } from "../lib/ratings";

export function SpotNoteField({ comicId, name, showId, date, note }: { comicId: string; name: string; showId: string; date: string; note: string | null | undefined }) {
  const { uid } = useApp();
  const [text, setText] = useState(note ?? "");
  useEffect(() => setText(note ?? ""), [note]);
  const save = () => {
    if (cleanNote(text, COMIC_NOTE_MAX) === cleanNote(note, COMIC_NOTE_MAX)) return;
    void noteSpot(uid, { comicId, showId, date }, text).catch((e: Error) => toast.error(e.message));
  };
  return (
    <TextInput
      aria-label={`Note on ${name} for ${date}`}
      value={text}
      maxLength={COMIC_NOTE_MAX}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      enterKeyHint="done"
      placeholder="Note (optional)"
      className="h-11 text-base"
    />
  );
}
