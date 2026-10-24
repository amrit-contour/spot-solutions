import { useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import type { Lineup, Show } from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand } from "../lib/data";
import { Avatar, Button, Chip, Sheet, Spinner, cx } from "./ui";
import { IconCheck, IconRefresh, IconShield, IconUserMinus, IconUserPlus } from "./icons";

const RESULT_LABEL = { added: "Added", removed: "Removed", invited: "Invite sent", failed: "Failed" } as const;

export function GroupSyncSheet({ open, onClose, show, lineup }: { open: boolean; onClose: () => void; show: Show; lineup: Lineup }) {
  const { uid, comicsById } = useApp();
  const plan = lineup.groupSync;
  const [exclude, setExclude] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const name = (id: string) => comicsById.get(id)?.name ?? `+${id.split("@")[0]}`;
  const toggle = (id: string) => setExclude((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s.add(id))));

  const recompute = async () => {
    setBusy(true);
    try {
      await runCommand(uid, "plan_group_sync", { lineupId: lineup.id }, 120_000);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      await runCommand(uid, "sync_group", { lineupId: lineup.id, exclude: [...exclude] }, 15 * 60_000);
      toast.success("Group updated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const adds = plan?.toAdd ?? [];
  const removes = plan?.toRemove ?? [];
  const results = plan?.results;
  const done = plan?.status === "done";

  const Row = ({ id, kind }: { id: string; kind: "add" | "remove" }) => {
    const off = exclude.has(id);
    const res = results?.[id];
    return (
      <li>
        <label className={cx("state-layer flex cursor-pointer items-center gap-3 rounded-md px-3 py-2", off && "opacity-50")}>
          <Avatar name={name(id)} size={32} tone={kind === "add" ? "primary" : "secondary"} />
          <span className={cx("flex-1 type-body-l", off && "line-through")}>{name(id)}</span>
          {res ? (
            <Chip tone={res === "failed" ? "error" : "success"}>{RESULT_LABEL[res]}</Chip>
          ) : (
            !done && <input type="checkbox" className="size-5 accent-[var(--md-sys-color-primary)]" checked={!off} onChange={() => toggle(id)} aria-label={`${kind === "add" ? "Add" : "Remove"} ${name(id)}`} />
          )}
        </label>
      </li>
    );
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Update show group"
      footer={
        done ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="text" icon={IconRefresh} onClick={recompute} disabled={busy}>
              Recheck
            </Button>
            <Button onClick={apply} loading={busy || plan?.status === "applying"} disabled={plan?.status !== "pending" || (!adds.length && !removes.length)}>
              Apply changes
            </Button>
          </>
        )
      }
    >
      {!plan || plan.status === "computing" ? (
        <div className="flex flex-col items-center gap-3 py-16 text-on-surface-variant">
          <Spinner className="size-7 text-primary" />
          Reading the group…
          {!plan && (
            <Button variant="tonal" onClick={recompute} loading={busy}>
              Check group now
            </Button>
          )}
        </div>
      ) : (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-6 grid grid-cols-3 gap-2">
            {[
              { n: adds.length - [...exclude].filter((x) => adds.includes(x)).length, l: "to add", c: "text-primary" },
              { n: removes.length - [...exclude].filter((x) => removes.includes(x)).length, l: "to remove", c: "text-error" },
              { n: plan.kept.length, l: "staying", c: "text-on-surface" },
            ].map((s) => (
              <div key={s.l} className="rounded-md bg-surface-container px-3 py-3">
                <div className={cx("type-headline-m tabular", s.c)}>{s.n}</div>
                <div className="type-label-m text-on-surface-variant">{s.l}</div>
              </div>
            ))}
          </motion.div>

          {adds.length > 0 && (
            <section className="mb-6">
              <h3 className="mb-2 flex items-center gap-2 type-title-s text-primary">
                <IconUserPlus className="icon size-5" /> This week's comics
              </h3>
              <ul className="flex flex-col">{adds.map((id) => <Row key={id} id={id} kind="add" />)}</ul>
            </section>
          )}
          {removes.length > 0 && (
            <section className="mb-6">
              <h3 className="mb-2 flex items-center gap-2 type-title-s text-error">
                <IconUserMinus className="icon size-5" /> Not on this week
              </h3>
              <ul className="flex flex-col">{removes.map((id) => <Row key={id} id={id} kind="remove" />)}</ul>
            </section>
          )}
          {!adds.length && !removes.length && (
            <p className="flex items-center gap-2 py-6 type-body-l text-on-surface-variant">
              <IconCheck className="icon size-5 text-primary" /> The group already matches this lineup.
            </p>
          )}
          <p className="flex items-start gap-2 rounded-md bg-surface-container p-3 type-body-s text-on-surface-variant">
            <IconShield className="icon mt-px size-4 flex-none text-primary" />
            Admins, regulars for {show.name}, protected members, and anyone we can't match to a phone number are never removed. Comics whose privacy settings block being added get an invite link instead.
          </p>
        </>
      )}
    </Sheet>
  );
}
