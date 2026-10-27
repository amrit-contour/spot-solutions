// Scheduled posts for a show's WhatsApp group: what goes out (a template from Settings → Messages or your own message),
// on which day (the show day or up to 6 days before) and at what time. Your server sends them; nothing runs in the cloud.
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  DAY_SHORT,
  GROUP_POST_KEYS,
  GROUP_POST_MAX_DAYS, GROUP_POST_MAX_AFTER,
  usesVar,
  formatDate,
  formatTime,
  groupPostMessage,
  groupPostVars,
  localNow,
  messageType,
  needsLineup,
  newGroupPost,
  nextRun,
  normalizeMessage,
  storeMessage,
  whenLabel,
  type GroupPost,
  type RichMessage,
  type Show,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { useNow } from "../lib/data";
import { Menu, MenuItem } from "@spot/ui";
import { SnippetMenu } from "./SnippetMenu";
import { MessageComposer, MessagePreview, messageSummary } from "@spot/ui";
import { Button, Chip, IconButton, Segmented, Select, Switch, TimePicker, cx } from "@spot/ui";
import { IconAdd, IconArrowDown, IconClock, IconSparkle, IconTrash } from "@spot/ui";

const TEMPLATE_OPTIONS: { value: GroupPost["template"]; label: string }[] = [
  { value: "groupLineup", label: messageType("groupLineup").label },
  { value: "groupVenue", label: messageType("groupVenue").label },
  { value: "groupReminder", label: messageType("groupReminder").label },
  { value: "groupReachEarly", label: messageType("groupReachEarly").label },
  { value: "groupBusking", label: messageType("groupBusking").label },
  { value: "groupPoster", label: messageType("groupPoster").label },
  { value: "groupPocs", label: messageType("groupPocs").label },
  { value: "groupCleanup", label: messageType("groupCleanup").label },
  { value: "custom", label: "My own message" },
];
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
  { key: "pocs", label: "POCs (tagged)" },
];

// Furthest before first, then the show day, then after it (for after-show posts, e.g. once the group is cleared).
const DAY_OPTIONS = Array.from({ length: GROUP_POST_MAX_DAYS + GROUP_POST_MAX_AFTER + 1 }, (_, i) => GROUP_POST_MAX_DAYS - i).map((d) => ({ value: String(d), label: whenLabel(d) }));

type PostShow = Pick<Show, "name" | "weekday" | "startTime" | "venueId" | "groupPostsSent" | "pocs">;

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

  return (
    <div className="flex flex-col gap-2">
      {!posts.length && (
        <p className="type-body-m text-on-surface-variant">
          Nothing scheduled. Add the lineup, the venue pin, a reminder, or your own message, and your server posts it in the group at the time you pick.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {sorted.map((p) => (
          <PostRow key={p.id} show={show} post={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} onChange={(patch) => update(p.id, patch)} onRemove={() => remove(p.id)} />
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
                <span className="block type-body-s text-on-surface-variant">{o.value === "custom" ? "Write it, or start from a saved template" : messageSummary(groupPostMessage(settings, { ...newGroupPost(o.value, show) }))}</span>
              </MenuItem>
            ))
          }
        </Menu>
        <Link to="/settings?msg=groupLineup#messages" className="state-layer inline-flex h-9 items-center rounded-full px-3 type-label-l text-primary">
          Edit group templates
        </Link>
      </div>
    </div>
  );
}

function PostRow({ show, post, open, onToggle, onChange, onRemove }: { show: PostShow; post: GroupPost; open: boolean; onToggle: () => void; onChange: (p: Partial<GroupPost>) => void; onRemove: () => void }) {
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
  const nextLabel = `${DAY_SHORT[new Date(`${next.date}T00:00:00Z`).getUTCDay()]} ${formatDate(next.date)}, ${formatTime(next.time)}`;

  return (
    <li className={cx("rounded-lg border border-outline-variant", !post.enabled && "opacity-70")}>
      <div className="flex items-center gap-2 py-2 pr-2 pl-3">
        <button type="button" onClick={onToggle} aria-expanded={open} className="state-layer -my-1 -ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left">
          <IconClock className="icon size-5 flex-none text-primary" />
          <span className="min-w-0 flex-1">
            <span className="block truncate type-title-s">{labelOf(post.template)}</span>
            <span className="block truncate type-body-s text-on-surface-variant">
              {whenLabel(post.daysBefore)}, {formatTime(post.time)}
              {post.enabled ? ` · next ${nextLabel}` : " · paused"}
            </span>
          </span>
          <IconArrowDown className={cx("icon size-4 flex-none text-on-surface-variant transition-transform duration-200", open && "rotate-180")} />
        </button>
        <Switch checked={post.enabled} onChange={(v) => onChange({ enabled: v })} label={`Send the ${labelOf(post.template).toLowerCase()}`} />
      </div>
      {open && (
        <div className="flex flex-col gap-4 border-t border-outline-variant/60 px-3 pt-3 pb-3">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-3">
            <Select label="What" value={post.template} onChange={(v) => onChange({ template: v as GroupPost["template"], ...(v === "custom" && !own ? { message: storeMessage(msg) } : {}) })} options={TEMPLATE_OPTIONS} />
            <Select label="Day" value={String(post.daysBefore)} onChange={(v) => onChange({ daysBefore: Number(v) })} options={DAY_OPTIONS} />
            <TimePicker label="Time" value={post.time} onChange={(v) => onChange({ time: v })} />
          </div>

          {post.template !== "custom" && (
            <Segmented
              size="sm"
              value={own ? "own" : "template"}
              onChange={(v) => setMessage(v === "own" ? msg : null)}
              options={[
                { value: "template", label: "Use the template" },
                { value: "own", label: "Change it for this show" },
              ]}
            />
          )}
          {own ? (
            <div className="flex flex-col gap-2">
              <div className="flex justify-end">
                <SnippetMenu vars={groupPostVars(show, venue, showDate, null, pocNames)} messages={[...GROUP_POST_KEYS]} onPick={(m) => setMessage(m)} />
              </div>
              <MessageComposer value={normalizeMessage(post.message, msg)} onChange={setMessage} variables={VARIABLES} extraVars={groupPostVars(show, venue, showDate, ["Rohan", "Priya", "Karthik"], pocNames || "@POC")} idPrefix={`post-${post.id}`} attachLabel="Also send the venue pin" />
            </div>
          ) : (
            <div className="rounded-md bg-surface-container p-3">
              <MessagePreview value={msg} vars={{ ...groupPostVars(show, venue, showDate, ["Rohan", "Priya", "Karthik"], pocNames || "@POC") }} />
            </div>
          )}
          {usesVar(msg, "pocs") && !show.pocs?.length && <p className="type-body-s text-error">This tags the POCs, but none are set for this show yet. Add them in the show's settings.</p>}
          {needsLineup(msg) && <p className="type-body-s text-on-surface-variant">Uses the running order, so it waits for a confirmed lineup. If the lineup isn't confirmed by then, you get a notice instead.</p>}

          {msg.kind === "text" && (
            <label className="flex items-center gap-3">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 type-title-s">
                  <IconSparkle className="icon size-4 text-primary" /> Write it in my voice
                </span>
                <span className="block type-body-s text-on-surface-variant">
                  {voiceReady ? "Reworded by your AI when it goes out. If a fact changes (a time, a name), your own words go instead." : "Set up Your voice in Settings → Messages first."}
                </span>
              </span>
              <Switch checked={Boolean(post.voice)} onChange={(v) => onChange({ voice: v })} label="Write it in my voice" disabled={!voiceReady} />
            </label>
          )}

          <div className="flex items-center gap-2">
            {show.groupPostsSent?.[post.id] && <Chip>Last sent for {formatDate(show.groupPostsSent[post.id])}</Chip>}
            <span className="flex-1" />
            <IconButton icon={IconTrash} label="Delete this post" onClick={onRemove} className="text-error" />
          </div>
        </div>
      )}
    </li>
  );
}
