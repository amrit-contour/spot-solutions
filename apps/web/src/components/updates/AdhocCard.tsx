// An ad hoc offer to several comics, with auto-add off: everyone who said yes waits here. Tick who gets the spot(s); they're
// booked and confirmed, and the rest are told it's filled.
import { useState } from "react";
import { toast } from "sonner";
import type { SpotOffer } from "@spot/shared";
import { useApp } from "../../lib/app";
import { runCommand } from "../../lib/data";
import { Button } from "@spot/ui";
import { IconUserPlus } from "@spot/ui";
import { UpdateItem } from "./shared";
import { ComicAvatar } from "../../lib/photos";

export function AdhocCard({ offers }: { offers: SpotOffer[] }) {
  const { uid, shows } = useApp();
  const round = offers[0].round!;
  const show = shows.find((s) => s.id === offers[0].showId);
  const [picked, setPicked] = useState<string[]>(() => offers.slice(0, round.slots).map((o) => o.comicId));
  const [busy, setBusy] = useState<"add" | "none" | null>(null);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= round.slots ? [...p.slice(1), id] : [...p, id]));
  const settle = async (pick: string[]) => {
    setBusy(pick.length ? "add" : "none");
    try {
      const r = await runCommand<{ booked: number }>(uid, "settle_round", { roundId: round.id, pick, close: true }, 10 * 60_000);
      toast.success(pick.length ? `${r?.booked ?? 0} added to ${show?.name ?? "the show"}. The rest were told it's filled.` : "Everyone who said yes was told it's filled.");
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  };
  return (
    <UpdateItem className="bg-surface-container">
      <div className="flex gap-3 px-4 pt-4">
        <IconUserPlus className="icon mt-0.5 size-6 flex-none text-primary" />
        <div className="min-w-0 flex-1">
          <p className="type-body-l">
            {offers.length} said yes to <span className="type-title-s">{show?.name ?? "the show"}</span>. Pick {round.slots === 1 ? "one" : `up to ${round.slots}`}.
          </p>
          <ul className="mt-2 flex flex-col">
            {offers.map((o) => (
              <li key={o.id}>
                <label className="state-layer -mx-2 flex min-h-11 items-center gap-3 rounded-md px-2">
                  <input type="checkbox" checked={picked.includes(o.comicId)} onChange={() => toggle(o.comicId)} aria-label={`Give the spot to ${o.comicName}`} className="size-5 flex-none accent-primary" />
                  <ComicAvatar id={o.comicId} name={o.comicName} size={28} />
                  <span className="min-w-0 flex-1 truncate type-body-m">{o.comicName}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-2 px-3 pb-3">
        <Button variant="text" loading={busy === "none"} disabled={Boolean(busy)} onClick={() => void settle([])}>
          None of them
        </Button>
        <Button loading={busy === "add"} disabled={Boolean(busy) || !picked.length} onClick={() => void settle(picked)} data-primary>
          Add {picked.length > 1 ? `${picked.length}` : "them"}
        </Button>
      </div>
    </UpdateItem>
  );
}
