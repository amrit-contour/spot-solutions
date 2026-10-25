// Settings → AI models: may chats ever leave the server? (AiPolicy in packages/shared/src/fleet.ts)
import { DEFAULT_AI_POLICY, type AiPolicy } from "@spot/shared";
import { useApp } from "../lib/app";
import { serverOnline, useAllServers } from "../lib/fleet";
import { useNow } from "../lib/data";
import { cx } from "./ui";
import { IconCheck, IconWarn } from "./icons";

const OPTIONS: { value: AiPolicy; title: string; body: string }[] = [
  { value: "local_only", title: "Local only — chats never leave your server", body: "Only a server with a local model runs your account." },
  { value: "local_first", title: "Local first, Gemini as backup", body: "Your local model answers; Gemini steps in when it's down. A server without a local model can host you." },
];

export function AiPolicyPicker() {
  const { settings, saveSettings } = useApp();
  const now = useNow(15_000);
  const servers = useAllServers();
  const policy = settings.ai.policy ?? DEFAULT_AI_POLICY;
  const usesGemini = settings.ai.primary.provider === "gemini" || settings.ai.fallback?.provider === "gemini";
  const noLocal = servers !== null && servers.length > 0 && !servers.some((s) => serverOnline(s, now) && s.localModel);

  return (
    <div className="rounded-lg bg-surface-container p-4">
      <div className="mb-3 type-title-s">Where chats may go</div>
      <div role="radiogroup" aria-label="Where chats may go" className="grid gap-3 md:grid-cols-2">
        {OPTIONS.map((o) => {
          const on = policy === o.value;
          return (
            <button
              key={o.value}
              role="radio"
              aria-checked={on}
              onClick={() => !on && void saveSettings({ ai: { ...settings.ai, policy: o.value } })}
              className={cx("state-layer pressable flex items-start gap-3 rounded-lg border p-4 text-left", on ? "border-primary bg-primary-container/40" : "border-outline-variant")}
            >
              <span className={cx("mt-0.5 grid size-5 flex-none place-items-center rounded-full border", on ? "border-primary bg-primary text-on-primary" : "border-outline")}>{on && <IconCheck className="size-4" />}</span>
              <span>
                <span className="block type-label-l">{o.title}</span>
                <span className="mt-1 block type-body-s text-on-surface-variant">{o.body}</span>
              </span>
            </button>
          );
        })}
      </div>
      {policy === "local_only" && usesGemini && (
        <p className="mt-3 flex items-start gap-2 type-body-s text-on-surface-variant">
          <IconWarn className="icon mt-px size-4 flex-none text-tertiary" />
          Your {settings.ai.primary.provider === "gemini" ? "primary" : "fallback"} model uses Gemini. With Local only on, Gemini routes are switched off for this account. Pick a local model below, or switch back to Local first.
        </p>
      )}
      {policy === "local_only" && noLocal && (
        <p className="mt-3 flex items-start gap-2 type-body-s text-on-surface-variant">
          <IconWarn className="icon mt-px size-4 flex-none text-tertiary" />
          No online server has a local model right now, so your WhatsApp waits until one does.
        </p>
      )}
    </div>
  );
}
