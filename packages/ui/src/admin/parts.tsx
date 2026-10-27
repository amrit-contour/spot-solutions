import { useState, type ReactNode } from "react";
import { Avatar, Card, Chip, cx } from "../ui";
import type { Activity, AccessRecord } from "./api";

/** "2 days ago", "just now". Dates older than a few months read better as a date. */
export function ago(t: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export const displayName = (r: Pick<AccessRecord, "name" | "email">) => r.name?.trim() || r.email || "Unknown";

export function Photo({ name, photo, size = 40 }: { name: string; photo?: string | null; size?: number }) {
  const [bad, setBad] = useState(false);
  if (!photo || bad) return <Avatar name={name} size={size} />;
  return <img src={photo} alt="" width={size} height={size} referrerPolicy="no-referrer" loading="lazy" onError={() => setBad(true)} className="flex-none rounded-full bg-surface-high object-cover" style={{ width: size, height: size }} />;
}

/** Avatar, then name over email, sharing one left edge. `children` sits on the name line (chips), `meta` under the email. */
export function Person({ name, email, photo, badges, meta }: { name: string; email?: string | null; photo?: string | null; badges?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <Photo name={name} photo={photo} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate type-body-l text-on-surface">{name}</span>
          {badges}
        </div>
        {email && email !== name && <div className="truncate type-body-s text-on-surface-variant">{email}</div>}
        {meta && <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 type-body-s text-on-surface-variant">{meta}</div>}
      </div>
    </div>
  );
}

/** Which apps this person uses, as small chips (nothing while the activity hasn't loaded). */
export function AppChips({ activity }: { activity?: Activity }) {
  if (!activity) return null;
  if (!activity.curating && !activity.comedy) return <span>No activity yet</span>;
  return (
    <>
      {activity.curating && <Chip tone="primary" className="h-6 px-2">Curating</Chip>}
      {activity.comedy && <Chip tone="tertiary" className="h-6 px-2">Comedy</Chip>}
    </>
  );
}

/** A titled group: heading on the card's left edge with a count, rows inside a rounded card that clips them, hairlines between rows. */
export function Group({ title, count, hint, children, tone = "low", className }: { title: ReactNode; count?: number; hint?: ReactNode; children: ReactNode; tone?: "low" | "attention"; className?: string }) {
  return (
    <section className={cx("flex min-w-0 flex-col gap-2", className)}>
      <header className="flex min-h-8 items-baseline gap-2 px-1">
        <h2 className="type-title-s text-on-surface">{title}</h2>
        {count != null && <span className="type-label-m text-on-surface-variant tabular">{count}</span>}
      </header>
      {hint && <p className="px-1 type-body-s text-on-surface-variant">{hint}</p>}
      <Card tone={tone === "attention" ? "container" : "low"} className={cx("overflow-hidden", tone === "attention" && "ring-1 ring-primary/30")}>
        {children}
      </Card>
    </section>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-outline-variant/40">{children}</ul>;
}

export function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "error" }) {
  return <p role={tone === "error" ? "alert" : undefined} className={cx("rounded-md px-4 py-3 type-body-m", tone === "error" ? "bg-error-container text-on-error-container" : "bg-surface-container text-on-surface-variant")}>{children}</p>;
}
