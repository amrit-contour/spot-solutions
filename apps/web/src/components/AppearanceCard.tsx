// Settings → App: pick the look of the app (per user).
import { toast } from "sonner";
import { motion } from "motion/react";
import { useApp } from "../lib/app";
import { NBC_GREEN, useBrand, type Brand } from "@spot/ui";
import { CuratingLogo } from "./CuratingLogo";
import { IconCheck, IconPalette } from "@spot/ui";
import { cx } from "@spot/ui";

// Each option previews itself in its own fixed colours (light face), whatever brand is active now.
const OPTIONS: { id: Brand; name: string; note: string; bg: string; fg: string; swatches: string[] }[] = [
  { id: "nbc", name: "NBC", note: "Black, white and one green", bg: "#FFFFFF", fg: "#0A0A0A", swatches: ["#0A0A0A", "#FFFFFF", NBC_GREEN] },
  { id: "classic", name: "Classic", note: "Warm brown and marigold", bg: "#FFF8F4", fg: "#231A10", swatches: ["#7A5416", "#FFDDB0", "#E8A33D"] },
];

export function AppearanceCard() {
  const { saveSettings } = useApp();
  const current = useBrand();
  const pick = (b: Brand) => {
    if (b === current) return;
    saveSettings({ appearance: { brand: b } }).catch(() => toast.error("Couldn't save that. Try again."));
  };
  return (
    <section className="rounded-xl bg-surface-low p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <IconPalette className="icon size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="type-title-m">Appearance</h2>
          <p className="type-body-s text-on-surface-variant">Choose how the app looks. Just for your account.</p>
        </div>
      </div>
      <div role="radiogroup" aria-label="Appearance" className="mt-4 grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
        {OPTIONS.map((o) => {
          const on = o.id === current;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => pick(o.id)}
              className={cx("state-layer pressable relative flex flex-col gap-3 rounded-lg border-2 bg-surface p-3 text-left transition-colors", on ? "border-primary" : "border-outline-variant")}
            >
              <div className="flex items-center gap-3 rounded-md p-3" style={{ background: o.bg, color: o.fg }}>
                <CuratingLogo brand={o.id} className="size-11 flex-none" />
                <div className="flex gap-1.5" aria-hidden>
                  {o.swatches.map((c) => (
                    <span key={c} className="size-5 rounded-full ring-1 ring-black/15" style={{ background: c }} />
                  ))}
                </div>
              </div>
              <div className="min-w-0">
                <div className="type-label-l">{o.name}</div>
                <div className="type-body-s text-on-surface-variant">{o.note}</div>
              </div>
              {on && (
                <motion.span initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-primary text-on-primary">
                  <IconCheck className="icon size-4" />
                </motion.span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
