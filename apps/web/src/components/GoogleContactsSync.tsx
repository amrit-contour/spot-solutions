// Bulk "save names to Google Contacts": plan, confirm with counts, run with progress. Used by Settings and the imports.
import { useRef, useState } from "react";
import { toast } from "sonner";
import type { Comic, ContactPlan } from "@spot/shared";
import { connectGoogleContacts, hasGoogleToken, planGoogleSync, reportGoogleError, runGoogleSync } from "../lib/googleContacts";
import { ConfirmDialog } from "./ConfirmDialog";

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function planSentence(p: ContactPlan) {
  return [p.create.length && `Add ${n(p.create.length, "new contact")}`, p.update.length && `update ${n(p.update.length, "name")}`, p.unchanged.length && `${p.unchanged.length} already match${p.unchanged.length === 1 ? "es" : ""}`]
    .filter(Boolean)
    .join(", ")
    .replace(/^./, (c) => c.toUpperCase());
}

/** `start(comics)` must be called from a click: it may open Google's popup. `dialog` goes anywhere in the tree. */
export function useGoogleSync() {
  const [plan, setPlan] = useState<ContactPlan | null>(null);
  const [open, setOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const running = useRef(false);

  const start = async (comics: Pick<Comic, "id" | "name" | "phone">[]) => {
    if (running.current) return;
    setPlanning(true);
    try {
      if (!hasGoogleToken()) await connectGoogleContacts();
      const p = await planGoogleSync(comics);
      if (!p.create.length && !p.update.length) {
        toast.success(p.unchanged.length ? "Google Contacts already has all these names" : "Nothing to save to Google Contacts");
        return;
      }
      setPlan(p);
      setProgress(null);
      setOpen(true);
    } catch (e) {
      reportGoogleError(e, "Couldn't read Google Contacts");
    } finally {
      setPlanning(false);
    }
  };

  const run = async () => {
    if (!plan) return;
    running.current = true;
    try {
      const r = await runGoogleSync(plan, (done, total) => setProgress({ done, total }));
      const text = [r.created && `${n(r.created, "contact")} added`, r.updated && `${n(r.updated, "name")} updated`].filter(Boolean).join(", ") || "Nothing saved";
      if (r.failed) toast.warning(`${text}. ${n(r.failed, "contact")} failed, try again.`);
      else toast.success(`Google Contacts: ${text}`);
    } catch (e) {
      reportGoogleError(e, "Couldn't finish saving to Google Contacts");
    } finally {
      running.current = false;
    }
  };

  const dialog = (
    <ConfirmDialog open={open} onClose={() => setOpen(false)} tone="primary" title="Save names to Google Contacts" confirmLabel="Save to Google" onConfirm={run}>
      {plan && (
        <>
          <p className="type-title-s text-on-surface">{planSentence(plan)}.</p>
          <p>Only names change. Other phone numbers and details on your contacts stay as they are, and nothing is deleted.</p>
          {plan.skipped.length > 0 && <p>{n(plan.skipped.length, "comic")} skipped: no phone number WhatsApp will tell us.</p>}
          {progress && (
            <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className="flex flex-col gap-1.5">
              <div className="h-2 overflow-hidden rounded-full bg-surface-highest">
                <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
              <span className="type-label-m tabular">
                {progress.done} of {progress.total}
              </span>
            </div>
          )}
        </>
      )}
    </ConfirmDialog>
  );

  return { start, planning, dialog };
}
