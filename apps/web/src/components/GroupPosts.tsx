// Scheduled posts for a show's WhatsApp group: what goes out (a template from Settings → Messages or your own message),
// on which day (the show day or up to 6 days before) and at what time. Your server sends them; nothing runs in the cloud.
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  DAY_SHORT,
  GROUP_POST_KEYS,
  GROUP_POST_MAX_DAYS, GROUP_POST_MAX_AFTER,
  DEFAULT_WAIT_HOURS,
  DEFAULT_RULE_LINE,
  SHOW_STATUS_OPTIONS,
  TEMPLATE_CRITERIA,
  cleanCriteria,
  cleanupTriggerPost,
  criteriaOn,
  criteriaSummary,
  toggleCriteria,
  postStatusToShow,
  usesVar,
  formatDate,
  formatTime,
  groupPostMessage,
  groupPostVars,
  localNow,
  messageType,
  needsLineup,
  planCopyAll,
  suggestPosts,
  newGroupPost,
  nextRun,
  normalizeMessage,
  storeMessage,
  whenLabel,
  type GroupCleanup,
  type GroupPost,
  type PostCriteria,
  type PostSource,
  type PostSuggestion,
  type RichMessage,
  type Show,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { useNow } from "../lib/data";
import { Menu, MenuItem } from "@spot/ui";
import { SnippetMenu } from "./SnippetMenu";
import { useMessageImage } from "./ImageAttach";
import { MessageComposer, MessagePreview, messageSummary } from "@spot/ui";
import { Button, Chip, IconButton, Segmented, Select, Switch, TimePicker, cx } from "@spot/ui";
import { IconAdd, IconArrowDown, IconCheck, IconClock, IconSparkle, IconTrash } from "@spot/ui";

const TEMPLATE_OPTIONS: { value: GroupPost["template"]; label: string }[] = [
  { value: "groupLineup", label: messageType("groupLineup").label },
  { value: "groupVenue", label: messageType("groupVenue").label },
  { value: "groupReminder", label: messageType("groupReminder").label },
  { value: "groupReachEarly", label: messageType("groupReachEarly").label },
  { value: "groupBusking", label: messageType("groupBusking").label },
  { value: "groupPoster", label: messageType("groupPoster").label },
  { value: "groupPocs", label: messageType("groupPocs").label },
  { value: "groupCleanup", label: messageType("groupCleanup").label },
  { value: "groupThanks", label: messageType("groupThanks").label },
  { value: "groupDidntHappen", label: messageType("groupDidntHappen").label },
  { value: "groupCancelled", label: messageType("groupCancelled").label },
  { value: "groupRepeat", label: messageType("groupRepeat").label },
  { value: "groupSignups", label: messageType("groupSignups").label },
  { value: "groupLatecomers", label: messageType("groupLatecomers").label },
  { value: "custom", label: "My own message" },
];
/** Ready-made posts that come with "Send only if…" already set: offered next to the suggestions. */
const CONDITIONAL_TEMPLATES = Object.keys(TEMPLATE_CRITERIA) as GroupPost["template"][];
const labelOf = (t: GroupPost["template"]) => TEMPLATE_OPTIONS.find((o) => o.value === t)?.label ?? "Post";

const VARIABLES = [
  { key: "show", label: "Show" },
  { key: "venue", label: "Venue" },
  { key: "day", label: "Day" },
  { key: "date", label: "Date" },
  { key: "time", label: "Start time" },
  { key: "mapsLink", label: "Maps link" },
  { key: "lineup", label: "Running order" },
  { key: "count", label: "Number of comics" },
  { key: "nextDate", label: "Date next week" },
  { key: "pocs", label: "POCs (tagged)" },
];

// Furthest before first, then the show day, then after it (for after-show posts, e.g. once the group is cleared).
const DAY_OPTIONS = Array.from({ length: GROUP_POST_MAX_DAYS + GROUP_POST_MAX_AFTER + 1 }, (_, i) => GROUP_POST_MAX_DAYS - i).map((d) => ({ value: String(d), label: whenLabel(d) }));

type PostShow = Pick<Show, "name" | "weekday" | "startTime" | "venueId" | "groupPostsSent" | "groupPostStatus" | "pocs"> & { id?: string; /** The show's group clean-up setting: a post it follows says so. */ cleanup?: GroupCleanup | null };

/** What a post is called in lists and menus. */
export const postLabel = (t: GroupPost["template"]) => labelOf(t);


export function GroupPostsEditor({ show, posts, onChange, compact }: { show: PostShow; posts: GroupPost[]; onChange: (posts: GroupPost[]) => void; compact?: boolean }) {
  const { settings } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const add = (t: GroupPost["template"]) => {
    const p = newGroupPost(t, show);
    onChange([...posts, p]);
    setOpen(p.id);
  };
  const update = (id: string, patch: Partial<GroupPost>) => onChange(posts.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const remove = (id: string) => onChange(posts.filter((p) => p.id !== id));
  const sorted = [...posts].sort((a, b) => b.daysBefore - a.daysBefore || a.time.localeCompare(b.time));
  const addMany = (added: GroupPost[]) => onChange([...posts, ...added]);
  const triggerId = cleanupTriggerPost({ cleanup: show.cleanup, groupPosts: posts })?.id;

  return (
    <div className="flex flex-col gap-3">
      {!posts.length && (
        <p className="type-body-m text-on-surface-variant">
          Nothing scheduled. Add the lineup, the venue pin, a reminder, or your own message, and your server posts it in the group at the time you pick.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {sorted.map((p) => (
          <PostRow key={p.id} show={show} post={p} triggersCleanup={p.id === triggerId} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} onChange={(patch) => update(p.id, patch)} onRemove={() => remove(p.id)} />
        ))}
      </ul>
      <div className={cx("flex flex-wrap items-center gap-2", compact && "justify-between")}>
        <Menu
          trigger={(toggle) => (
            <Button size="sm" variant="tonal" icon={IconAdd} onClick={toggle}>
              Schedule a post
            </Button>
          )}
        >
          {(close) =>
            TEMPLATE_OPTIONS.map((o) => (
              <MenuItem key={o.value} onClick={() => (close(), add(o.value))}>
                {o.label}
                <span className="block type-body-s text-on-surface-variant">
                  {o.value === "custom" ? "Write it, or start from a saved template" : messageSummary(groupPostMessage(settings, { ...newGroupPost(o.value, show) }))}
                </span>
                {TEMPLATE_CRITERIA[o.value] && <span className="block type-label-m text-primary">{criteriaSummary(TEMPLATE_CRITERIA[o.value])}</span>}
              </MenuItem>
            ))
          }
        </Menu>
        <Link to="/settings?msg=groupLineup#messages" className="state-layer inline-flex h-9 items-center rounded-full px-3 type-label-l text-primary">
          Edit group templates
        </Link>
      </div>
      <AddPostArea show={show} posts={posts} onAddMany={addMany} onAddTemplate={add} />
    </div>
  );
}

/** A small round + for a compact row. */
function AddRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <IconButton icon={IconAdd} label={label} onClick={onClick} className="size-9 flex-none text-primary" />;
}

/**
 * "Add a post": suggestions from the show's other groups and the ready-made posts (each with its "Only send when…" set) in one
 * collapsible area, two tabs. Open when the group has no posts yet, collapsed otherwise. Rows are compact; a small + adds one.
 */
function AddPostArea({ show, posts, onAddMany, onAddTemplate }: { show: PostShow; posts: GroupPost[]; onAddMany: (added: GroupPost[]) => void; onAddTemplate: (t: GroupPost["template"]) => void }) {
  const { settings, shows, venues } = useApp();
  const venueName = (id?: string) => venues.find((v) => v.id === id)?.name ?? null;
  const target = { id: show.id, name: show.name, venueName: venueName(show.venueId) };
  // Every enabled post of every other active show, template-based ones included.
  const sources: PostSource[] = shows.filter((s) => s.id !== show.id && s.active !== false && s.groupPosts?.some((p) => p.enabled)).map((s) => ({ id: s.id, name: s.name, venueName: venueName(s.venueId), posts: s.groupPosts ?? [] }));
  const suggestions = suggestPosts(settings, target, posts, sources);
  const have = new Set(posts.map((p) => p.template));
  const ready = CONDITIONAL_TEMPLATES.filter((t) => !have.has(t));
  const empty = posts.length === 0;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"groups" | "ready" | null>(null);
  const [review, setReview] = useState<string | null>(null);
  if (!suggestions.length && !ready.length) return null;
  const expanded = empty || open;
  const current = tab ?? (suggestions.length ? "groups" : "ready");
  const bySource = sources.map((s) => ({ source: s, count: planCopyAll(settings, target, posts, s).add.length })).filter((x) => x.count > 0);
  const plan = review ? planCopyAll(settings, target, posts, sources.find((s) => s.id === review)!) : null;
  const add = (list: PostSuggestion[]) => {
    onAddMany(list.map((x) => x.post));
    setReview(null);
  };

  return (
    <section aria-label="Add a post" className="rounded-lg border border-outline-variant">
      {empty ? (
        <div className="flex min-h-11 items-center gap-2 px-3 pt-2">
          <IconSparkle className="icon size-5 flex-none text-primary" />
          <h4 className="min-w-0 flex-1 type-title-s">Add a post</h4>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="state-layer flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left">
          <IconSparkle className="icon size-5 flex-none text-primary" />
          <span className="min-w-0 flex-1 truncate type-title-s">Add a post</span>
          <Chip tone="primary">{suggestions.length + ready.length}</Chip>
          <IconArrowDown className={cx("icon size-4 flex-none text-on-surface-variant transition-transform duration-200", open && "rotate-180")} />
        </button>
      )}
      {expanded && (
        <div className="flex flex-col gap-3 px-3 pb-3 pt-2">
          <Segmented
            size="sm"
            full
            value={current}
            onChange={(v) => setTab(v)}
            options={[
              { value: "groups" as const, label: `From your groups (${suggestions.length})` },
              { value: "ready" as const, label: `Ready-made (${ready.length})` },
            ]}
          />
          {current === "groups" && (
            <>
              {suggestions.length === 0 && <p className="type-body-s text-on-surface-variant">Nothing new in your other groups. Everything they post, this one already does.</p>}
              {bySource.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {bySource.map(({ source, count }) => (
                    <Button key={source.id} size="sm" variant={review === source.id ? "filled" : "outlined"} onClick={() => setReview(review === source.id ? null : source.id)} aria-pressed={review === source.id}>
                      Copy all from {source.name} ({count})
                    </Button>
                  ))}
                </div>
              )}
              {plan && review && (
                <div className="flex flex-col gap-2 rounded-md bg-surface-container p-3" role="group" aria-label={`Copy all from ${sources.find((s) => s.id === review)?.name}`}>
                  <p className="type-title-s">
                    Add {plan.add.length} {plan.add.length === 1 ? "post" : "posts"} from {sources.find((s) => s.id === review)?.name}?
                  </p>
                  <ul className="flex flex-col gap-1">
                    {plan.add.map((x) => (
                      <li key={x.post.id} className="flex items-start gap-2 type-body-s">
                        <IconCheck className="icon mt-0.5 size-4 flex-none text-primary" />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{x.timing}</span> · {x.kind}
                          <span className="line-clamp-1 text-on-surface-variant">{x.snippet || "(no text)"}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {plan.skipped > 0 && <p className="type-body-s text-on-surface-variant">{plan.skipped} already here or a repeat, skipped.</p>}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="text" onClick={() => setReview(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" icon={IconAdd} onClick={() => add(plan.add)}>
                      Add {plan.add.length}
                    </Button>
                  </div>
                </div>
              )}
              <ul className="flex flex-col gap-1.5">
                {suggestions.map((x) => (
                  <li key={x.key} className="flex items-center gap-2 rounded-md bg-surface-container py-1.5 pl-3 pr-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate type-title-s">{x.kind}</span>
                      <span className="block truncate type-body-s text-on-surface-variant">
                        {x.timing}
                        {hasSummary(x.post) && ` · ${criteriaSummary(x.post.criteria)}`} · from {x.sourceName}
                        {x.alsoIn.length > 0 && ` +${x.alsoIn.length}`}
                      </span>
                      {x.snippet && <span className="block truncate type-body-s text-on-surface-variant/80">{x.snippet}</span>}
                    </span>
                    <AddRowButton label={`Add ${x.kind}, ${x.timing}, from ${x.sourceName}`} onClick={() => add([x])} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {current === "ready" && (
            <>
              <p className="type-body-s text-on-surface-variant">Each goes out only when its condition holds, so a thank-you never follows a show that didn't happen.</p>
              {ready.length === 0 && <p className="type-body-s text-on-surface-variant">All of them are already scheduled.</p>}
              <ul className="flex flex-col gap-1.5">
                {ready.map((t) => {
                  const p = newGroupPost(t, show);
                  return (
                    <li key={t} className="flex items-center gap-2 rounded-md bg-surface-container py-1.5 pl-3 pr-1.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate type-title-s">{labelOf(t)}</span>
                        <span className="block truncate type-body-s text-on-surface-variant">
                          {whenLabel(p.daysBefore)}, {formatTime(p.time)} · {criteriaSummary(p.criteria)}
                        </span>
                      </span>
                      <AddRowButton label={`Add ${labelOf(t)}`} onClick={() => onAddTemplate(t)} />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

const hasSummary = (p: GroupPost) => Boolean(criteriaSummary(p.criteria));

/** The scroll target for "Group clean-up runs after this post (show setting)": the clean-up card in the show's editor. */
function jumpToCleanup() {
  const el = document.getElementById("show-cleanup");
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
  el?.classList.add("ring-2", "ring-primary");
  window.setTimeout(() => el?.classList.remove("ring-2", "ring-primary"), 1600);
}

/** The editable message of a post: the composer (kind switch, text with its toolbar, poll, pin), with the photo and the templates menu in the field's toolbar. */
function PostMessageEditor({ show, post, msg, showDate, pocNames, onChange }: { show: PostShow; post: GroupPost; msg: RichMessage; showDate: string; pocNames: string; onChange: (m: RichMessage) => void }) {
  const { venues } = useApp();
  const venue = venues.find((v) => v.id === show.venueId);
  const value = normalizeMessage(post.message, msg);
  const photo = useMessageImage({ scope: "attachments", value: value.image, onChange: (image) => onChange({ ...value, image }) });
  return (
    <MessageComposer
      value={value}
      onChange={onChange}
      variables={VARIABLES}
      extraVars={groupPostVars(show, venue, showDate, ["Rohan", "Priya", "Karthik"], pocNames || "@POC")}
      idPrefix={`post-${post.id}`}
      attachLabel="Also send the venue pin"
      photo={photo}
      templates={<SnippetMenu toolbar vars={groupPostVars(show, venue, showDate, null, pocNames)} messages={[...GROUP_POST_KEYS]} onPick={onChange} />}
    />
  );
}

function PostRow({ show, post, open, triggersCleanup, onToggle, onChange, onRemove }: { show: PostShow; post: GroupPost; open: boolean; triggersCleanup: boolean; onToggle: () => void; onChange: (p: Partial<GroupPost>) => void; onRemove: () => void }) {
  const { settings, venues, comicsById } = useApp();
  const now = useNow(60_000);
  // In the preview, POCs show as names; WhatsApp shows each tag as the person's name too.
  const pocNames = (show.pocs ?? []).map((id) => `@${comicsById.get(id)?.name.split(/\s+/)[0] ?? "POC"}`).join(", ");
  const today = localNow(new Date(now), settings.timezone).date;
  const venue = venues.find((v) => v.id === show.venueId);
  const msg = groupPostMessage(settings, post);
  const own = post.template === "custom" || (post.message != null && post.message !== "");
  const next = nextRun(show, post, today);
  const showDate = next.date;
  const voiceReady = Boolean(settings.voice?.enabled && settings.voice.profile?.summary);
  const setMessage = (m: RichMessage | null) => onChange({ message: m ? storeMessage(m) : null });
  const status = postStatusToShow(show.groupPostStatus?.[post.id], show.groupPostsSent?.[post.id]);
  const nextLabel = `${DAY_SHORT[new Date(`${next.date}T00:00:00Z`).getUTCDay()]} ${formatDate(next.date)}, ${formatTime(next.time)}`;

  return (
    <li className={cx("rounded-lg border border-outline-variant", !post.enabled && "opacity-70")}>
      <div className="flex items-center gap-2 py-2 pr-2 pl-3">
        <button type="button" onClick={onToggle} aria-expanded={open} className="state-layer -my-1 -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left">
          <IconClock className="icon size-5 flex-none text-primary" />
          <span className="min-w-0 flex-1">
            <span className="block truncate type-title-s">{labelOf(post.template)}</span>
            <span className="block type-body-s text-on-surface-variant">
              {whenLabel(post.daysBefore)}, {formatTime(post.time)}
              {criteriaOn(post) && ` · ${criteriaSummary(post.criteria)}`}
              {post.enabled ? ` · next ${nextLabel}` : " · paused"}
            </span>
            {status && <span className={cx("block type-label-m", status.state === "waiting" ? "text-primary" : "text-on-surface-variant")}>{status.text} · for {formatDate(status.showDate)}</span>}
          </span>
          <IconArrowDown className={cx("icon size-4 flex-none text-on-surface-variant transition-transform duration-200", open && "rotate-180")} />
        </button>
        <Switch checked={post.enabled} onChange={(v) => onChange({ enabled: v })} label={`Send the ${labelOf(post.template).toLowerCase()}`} />
      </div>
      {open && (
        <div className="flex flex-col gap-4 border-t border-outline-variant/60 px-3 pt-3 pb-3">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 min-[560px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <Select label="What" value={post.template} onChange={(v) => onChange({ template: v as GroupPost["template"], ...(v === "custom" && !own ? { message: storeMessage(msg) } : {}) })} options={TEMPLATE_OPTIONS} />
            <Select label="Day" value={String(post.daysBefore)} onChange={(v) => onChange({ daysBefore: Number(v) })} options={DAY_OPTIONS} />
            <TimePicker label="Time" value={post.time} onChange={(v) => onChange({ time: v })} />
          </div>

          {post.template !== "custom" && (
            <div>
            <Segmented
              size="sm"
              compact
              value={own ? "own" : "template"}
              onChange={(v) => setMessage(v === "own" ? msg : null)}
              options={[
                { value: "template", label: "Use the template" },
                { value: "own", label: "Change for this show" },
              ]}
            />
            </div>
          )}
          {own ? (
            <PostMessageEditor show={show} post={post} msg={msg} showDate={showDate} pocNames={pocNames} onChange={setMessage} />
          ) : (
            <div className="rounded-xl border border-outline-variant bg-surface-container p-3">
              <MessagePreview value={msg} vars={{ ...groupPostVars(show, venue, showDate, ["Rohan", "Priya", "Karthik"], pocNames || "@POC") }} />
            </div>
          )}
          {usesVar(msg, "pocs") && !show.pocs?.length && <p className="-mt-2 type-body-s text-error">This tags the POCs, but none are set for this show yet. Add them in the show's settings.</p>}
          {needsLineup(msg) && <p className="-mt-2 type-body-s text-on-surface-variant">Uses the running order, so it waits for a confirmed lineup. If the lineup isn't confirmed by then, you get a notice instead.</p>}
          {triggersCleanup && (
            <p className="-mt-2 type-body-s text-on-surface-variant">
              Group clean-up runs after this post (<button type="button" onClick={jumpToCleanup} className="touch-manipulation text-primary underline-offset-2 hover:underline">
                show setting
              </button>
              ).
            </p>
          )}

          <OnlyWhen post={post} onChange={onChange} />

          {msg.kind === "text" && (
            <div className="flex items-center gap-3 border-t border-outline-variant/60 pt-3">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 type-title-s">
                  <IconSparkle className="icon size-4 flex-none text-primary" /> Write it in my voice
                </span>
                <span className="block type-body-s text-on-surface-variant">
                  {voiceReady ? "Reworded by your AI when it goes out. If a fact changes (a time, a name), your own words go instead." : "Set up Your voice in Settings → Messages first."}
                </span>
              </span>
              <Switch checked={Boolean(post.voice)} onChange={(v) => onChange({ voice: v })} label="Write it in my voice" disabled={!voiceReady} />
            </div>
          )}

          <div className="flex min-h-10 items-center gap-2">
            {show.groupPostsSent?.[post.id] ? <Chip>Last sent for {formatDate(show.groupPostsSent[post.id])}</Chip> : <span className="type-body-s text-on-surface-variant">Not sent yet</span>}
            <span className="flex-1" />
            <IconButton icon={IconTrash} label="Delete this post" onClick={onRemove} className="text-error" />
          </div>
        </div>
      )}
    </li>
  );
}

const MIN_OPTIONS = [{ value: "0", label: "Any number" }, ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `At least ${i + 1}` }))];
const REPEAT_OPTIONS = [
  { value: "", label: "Doesn't matter" },
  { value: "yes", label: "Repeats next week" },
  { value: "no", label: "Doesn't repeat" },
];
const WAIT_OPTIONS = [1, 2, 3, 4, 6, 8, 12, 20].map((h) => ({ value: String(h), label: `${h} ${h === 1 ? "hour" : "hours"}` }));

/**
 * "Only send when…": off by default (the post skips a called-off or didn't-happen show, one muted line). On, the post goes out only
 * when everything chosen holds at send time; if an answer isn't in yet it waits, then skips (and says so). A post that already has
 * criteria opens with the switch on; one with none is off.
 */
function OnlyWhen({ post, onChange }: { post: GroupPost; onChange: (p: Partial<GroupPost>) => void }) {
  const on = criteriaOn(post);
  // Turning it off and on again brings back what was chosen.
  const kept = useRef<PostCriteria | null>(null);
  const c = post.criteria ?? {};
  const set = (patch: Partial<PostCriteria>) => onChange({ criteria: cleanCriteria({ ...c, ...patch }) ?? toggleCriteria(post, true, null) });
  const flip = (v: boolean) => {
    if (!v) kept.current = post.criteria ?? null;
    onChange({ criteria: toggleCriteria(post, v, kept.current) });
  };
  const needsAnswer = c.show === "happened" || c.show === "didnt_happen" || c.show === "confirmed" || c.repeats !== undefined;
  // "Any show that's on" only appears for a post that already has criteria without a show status (older posts).
  const statusOptions = [...(c.show ? [] : [{ value: "", label: "Any show that's on" }]), ...SHOW_STATUS_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))];
  return (
    <div className="flex flex-col gap-3 border-t border-outline-variant/60 pt-3">
      <label className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block type-title-s">Only send when…</span>
          <span className="block type-body-s text-on-surface-variant">{on ? "It goes out only when everything below holds." : DEFAULT_RULE_LINE}</span>
        </span>
        <Switch checked={on} onChange={flip} label="Only send when conditions hold" />
      </label>
      {on && (
        <div className="flex flex-col gap-3 rounded-md bg-surface-container p-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="px-1 type-label-m text-on-surface-variant">The show</span>
            <Select label="Show status" value={c.show ?? ""} onChange={(v) => set({ show: (v || undefined) as PostCriteria["show"] })} options={statusOptions} />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="px-1 type-label-m text-on-surface-variant">Comics on the lineup</span>
              <Select label="Comics on the lineup" value={String(c.minComics ?? 0)} onChange={(v) => set({ minComics: Number(v) || undefined })} options={MIN_OPTIONS} />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="px-1 type-label-m text-on-surface-variant">Lineup repeats next week</span>
              <Select label="Lineup repeats next week" value={c.repeats === undefined ? "" : c.repeats ? "yes" : "no"} onChange={(v) => set({ repeats: v === "" ? undefined : v === "yes" })} options={REPEAT_OPTIONS} />
            </div>
          </div>
          <label className="flex items-center gap-3">
            <span className="min-w-0 flex-1 type-body-m">The lineup is full</span>
            <Switch checked={Boolean(c.full)} onChange={(v) => set({ full: v || undefined })} label="Only if the lineup is full" />
          </label>
          {needsAnswer && (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-end sm:gap-3">
              <p className="type-body-s text-on-surface-variant">If an answer isn't in yet ("did it happen?", "repeating?"), the post waits, then skips and says why. It never waits past the end of its day.</p>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="px-1 type-label-m text-on-surface-variant">Wait up to</span>
                <Select label="Wait up to" value={String(c.waitHours ?? DEFAULT_WAIT_HOURS)} onChange={(v) => set({ waitHours: Number(v) })} options={WAIT_OPTIONS} />
              </div>
            </div>
          )}
          <p className="type-body-s text-on-surface-variant">Goes out {criteriaSummary(c)}. Skipped posts show why on the show's Activity.</p>
        </div>
      )}
    </div>
  );
}
