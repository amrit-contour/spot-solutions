// The post-show review, one sheet: how the show went overall (rating, crowd, notes), then each comic (rating and a short note).
// Opened from a happened show's card (calendar, Lineup page) and from Requests > Updates after "yes, it happened". The show's review
// lives on the lineup; each comic's rating and note live on their slot and in their spot history (see lib/ratings.ts reviewSpots).
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ATTENDANCE, COMIC_NOTE_MAX, CROWD_LEVELS, DAY_NAMES, RATING_WORDS, SHOW_NOTES_MAX, allTags, cleanNote, cleanTag, cleanTags, dateInWeek, formatDate, formatTime, isRating, lineupId, performed, type Attendance, type CrowdLevel, type Lineup, type Show, type SpotReview } from "@spot/shared";
import { Button, Field, Select, Sheet, TextArea, TextInput, cx } from "@spot/ui";
import { IconArrowDown } from "@spot/ui";
import { useApp } from "../lib/app";
import { useDocument } from "../lib/data";
import { reviewSpots } from "../lib/ratings";
import { ComicAvatar } from "../lib/photos";
import { RatingPicker } from "./RatingPicker";

interface ComicDraft {
  rating: number | null;
  note: string;
  attendance: Attendance;
  tags: string[];
}

interface Draft {
  rating: number | null;
  crowd: CrowdLevel | null;
  notes: string;
  comics: Record<string, ComicDraft>;
}

const fromLineup = (l: Lineup): Draft => ({
  rating: isRating(l.review?.rating) ? l.review!.rating! : null,
  crowd: l.review?.crowd ?? null,
  notes: l.review?.notes ?? "",
  comics: Object.fromEntries(l.slots.map((s) => [s.comicId, { rating: isRating(s.rating) ? s.rating : null, note: s.note ?? "", attendance: s.attendance ?? "showed", tags: cleanTags(s.tags) }])),
});

export function ReviewSheet({ open, onClose, show, week }: { open: boolean; onClose: () => void; show: Show; /** The week the show is in (its Monday). */ week: string }) {
  const { uid, comicsById, settings, saveSettings } = useApp();
  const lineup = useDocument<Lineup>(open ? ["users", uid, "lineups", lineupId(week, show.id)] : null).data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [more, setMore] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Record<string, string>>({});
  // Start from what is saved, once per opening (later changes from the agent don't overwrite what is being typed).
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      setDraft(null);
    } else if (lineup && !seeded.current) {
      seeded.current = true;
      const d = fromLineup(lineup);
      setDraft(d);
      setMore(new Set(Object.entries(d.comics).filter(([, c]) => c.note || c.tags.length).map(([id]) => id)));
    }
  }, [open, lineup]);

  const date = dateInWeek(week, show.weekday);
  const nameOf = (id: string) => comicsById.get(id)?.name ?? `+${id.split("@")[0]}`;
  const setComic = (id: string, patch: Partial<ComicDraft>) => setDraft((d) => (d ? { ...d, comics: { ...d.comics, [id]: { ...d.comics[id]!, ...patch } } } : d));

  const customTags = settings.reviewTags ?? [];
  const offered = allTags(customTags);
  const addTag = (id: string) => {
    const t = cleanTag(adding[id] ?? "");
    setAdding((a) => ({ ...a, [id]: "" }));
    if (!t) return;
    const known = offered.find((o) => o.toLowerCase() === t.toLowerCase());
    const tag = known ?? t;
    if (!known) void saveSettings({ reviewTags: [...customTags, t] });
    const cur = draft?.comics[id]?.tags ?? [];
    if (!cur.some((x) => x.toLowerCase() === tag.toLowerCase())) setComic(id, { tags: cleanTags([...cur, tag]) });
  };
  const toggleMore = (id: string) => setMore((m) => { const n = new Set(m); if (!n.delete(id)) n.add(id); return n; });

  const save = async () => {
    if (!lineup || !draft) return;
    const base = fromLineup(lineup);
    const spots: Record<string, SpotReview> = {};
    // Only what changed is written, so a quiet save never clobbers a rating the agent just took.
    for (const s of lineup.slots) {
      const was = base.comics[s.comicId]!;
      const now = draft.comics[s.comicId];
      if (!now) continue;
      const r: SpotReview = {};
      if (now.rating !== was.rating) r.rating = now.rating;
      if (now.attendance !== was.attendance) r.attendance = now.attendance;
      if (now.tags.join("|") !== was.tags.join("|")) r.tags = now.tags;
      if (cleanNote(now.note, COMIC_NOTE_MAX) !== cleanNote(was.note, COMIC_NOTE_MAX)) r.note = cleanNote(now.note, COMIC_NOTE_MAX);
      if (Object.keys(r).length) spots[s.comicId] = r;
    }
    const showChanged = draft.rating !== base.rating || draft.crowd !== base.crowd || cleanNote(draft.notes, SHOW_NOTES_MAX) !== cleanNote(base.notes, SHOW_NOTES_MAX);
    if (!showChanged && !Object.keys(spots).length) return void onClose();
    setSaving(true);
    try {
      await reviewSpots(uid, { showId: show.id, date: lineup.date, lineupId: lineup.id }, showChanged ? { rating: draft.rating, crowd: draft.crowd, notes: draft.notes } : undefined, spots);
      toast.success("Review saved");
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Review the show" footer={<Button onClick={() => void save()} loading={saving} disabled={!draft}>Save review</Button>}>
      <h2 className="type-title-l">{show.name}</h2>
      <p className="type-body-m text-on-surface-variant">
        {DAY_NAMES[show.weekday]} {formatDate(date)} · {formatTime(show.startTime)}
      </p>

      {!draft ? (
        <div className="mt-5 h-48 animate-pulse rounded-lg bg-surface-container" />
      ) : (
        <>
          <section aria-labelledby="rv-show" className="mt-5 flex flex-col gap-5 rounded-lg bg-surface-container p-4">
            <div>
              <h3 id="rv-show" className="type-label-l text-on-surface-variant">How was the show?</h3>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <RatingPicker large label="Show rating" value={draft.rating} onChange={(v) => setDraft({ ...draft, rating: v })} />
                <span className="type-label-l text-primary" aria-live="polite">{draft.rating ? RATING_WORDS[draft.rating] : ""}</span>
              </div>
            </div>
            <div>
              <h3 className="type-label-l text-on-surface-variant">The crowd <span className="text-on-surface-variant/70">(optional)</span></h3>
              <div role="radiogroup" aria-label="Crowd" className="mt-2 flex gap-2">
                {CROWD_LEVELS.map((c) => {
                  const on = draft.crowd === c.value;
                  return (
                    <button
                      key={c.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setDraft({ ...draft, crowd: on ? null : c.value })}
                      className={cx("h-10 min-w-0 flex-1 rounded-full type-label-l transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary", on ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface-variant hover:bg-surface-highest")}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <Field label="Notes" hint={`${draft.notes.length}/${SHOW_NOTES_MAX}`}>
              <TextArea value={draft.notes} maxLength={SHOW_NOTES_MAX} rows={3} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Crowd, sound, anything to remember…" className="min-h-24 text-base" />
            </Field>
          </section>

          {lineup && lineup.slots.length > 0 && (
            <section aria-labelledby="rv-comics" className="mt-6">
              <h3 id="rv-comics" className="mb-2 px-1 type-label-l text-on-surface-variant">The comics</h3>
              <ul className="flex flex-col gap-2">
                {lineup.slots.map((s) => {
                  const c = draft.comics[s.comicId];
                  if (!c) return null;
                  const name = nameOf(s.comicId);
                  const on = performed(c.attendance);
                  const isOpen = more.has(s.comicId);
                  const extra = (c.note ? 1 : 0) + c.tags.length;
                  return (
                    <li key={s.comicId} className="rounded-lg bg-surface-container p-3">
                      <div className="flex items-center gap-2.5">
                        <ComicAvatar id={s.comicId} name={name} size={32} />
                        <span className="min-w-0 flex-1 truncate type-title-s">{name}</span>
                        <Select
                          label={`${name} attendance`}
                          value={c.attendance}
                          onChange={(v) => setComic(s.comicId, { attendance: v as Attendance })}
                          options={ATTENDANCE.map((a) => ({ value: a.value, label: a.label }))}
                          wrapperClassName="w-40 flex-none"
                          className={cx("h-10 text-sm", !on && "text-error")}
                        />
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        {on ? <RatingPicker label={`How ${name} did`} value={c.rating} onChange={(v) => setComic(s.comicId, { rating: v })} /> : <span className="type-body-s text-on-surface-variant">No rating needed</span>}
                        <button
                          type="button"
                          onClick={() => toggleMore(s.comicId)}
                          aria-expanded={isOpen}
                          className="inline-flex min-h-9 flex-none items-center gap-1 rounded-full px-2.5 type-label-l text-primary hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-primary"
                        >
                          {on ? "Tags & note" : "Note"}
                          {extra > 0 && !isOpen && <span className="rounded-full bg-primary-container px-1.5 type-label-s tabular text-on-primary-container">{extra}</span>}
                          <IconArrowDown className={cx("icon size-4 transition-transform", isOpen && "rotate-180")} />
                        </button>
                      </div>
                      {isOpen && (
                        <div className="mt-2 flex flex-col gap-2">
                          {on && (
                            <>
                              <div role="group" aria-label={`Tags for ${name}`} className="flex flex-wrap gap-1.5">
                                {[...offered, ...c.tags.filter((t) => !offered.some((o) => o.toLowerCase() === t.toLowerCase()))].map((t) => {
                                  const sel = c.tags.some((x) => x.toLowerCase() === t.toLowerCase());
                                  return (
                                    <button
                                      key={t}
                                      type="button"
                                      aria-pressed={sel}
                                      onClick={() => setComic(s.comicId, { tags: sel ? c.tags.filter((x) => x.toLowerCase() !== t.toLowerCase()) : cleanTags([...c.tags, t]) })}
                                      className={cx("h-8 rounded-full px-3 type-label-m transition-colors focus-visible:outline-2 focus-visible:outline-primary", sel ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface-variant hover:bg-surface-highest")}
                                    >
                                      {t}
                                    </button>
                                  );
                                })}
                              </div>
                              <div className="flex gap-2">
                                <TextInput
                                  aria-label={`Add a tag for ${name}`}
                                  value={adding[s.comicId] ?? ""}
                                  maxLength={24}
                                  onChange={(e) => setAdding((a) => ({ ...a, [s.comicId]: e.target.value }))}
                                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTag(s.comicId))}
                                  placeholder="Add your own tag"
                                  enterKeyHint="done"
                                  className="h-10 min-w-0 flex-1 text-base"
                                />
                                <Button variant="tonal" onClick={() => addTag(s.comicId)} disabled={!cleanTag(adding[s.comicId] ?? "")}>Add</Button>
                              </div>
                            </>
                          )}
                          <TextInput
                            aria-label={`Note on ${name}`}
                            value={c.note}
                            maxLength={COMIC_NOTE_MAX}
                            onChange={(e) => setComic(s.comicId, { note: e.target.value })}
                            placeholder="Note (optional)"
                            enterKeyHint="done"
                            className="h-11 text-base"
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </Sheet>
  );
}
