import { useEffect, useState } from "react";
import { doc, onSnapshot, orderBy, limit, setDoc } from "firebase/firestore";
import { db } from "@spot/ui/firebase";
import { useAgentScope } from "@spot/ui/agentScope";
import { OTHER_APP_NOTE } from "@spot/shared";
import { IconChatCheck, SectionTitle, SettingRow, Switch } from "@spot/ui";
import { useCollection } from "../lib/data";
import { ago } from "../lib/time";
import { useClock } from "../lib/alerts";

/** What to say to the agent number, in the comic's own words. Kept in step with COMIC_HELP_TEXT (packages/shared/src/comicAgent.ts). */
const EXAMPLES: { title: string; lines: string[] }[] = [
  { title: "Rooms", lines: ["update TAG Monday to Dhruv", "Comedy Square closed this week", "pause Bloom till Nov 10", "add a 9:30 slot at Banter on Fridays", "Humble Pie asks on Mondays now", "add Dhruv's number 98xxxxxxxx", "I'm a regular at Bloom Monday"] },
  { title: "Spots", lines: ["I got a spot at Banter tonight 9pm", "add regular Monday 9 PM at Bloom", "did I do a mic yesterday?", "how many spots this month?"] },
  { title: "Asks", lines: ["ask TAG for Monday", "what asks are open today?", "skip Banter this week"] },
  { title: "Alerts", lines: ["any open spots now?", "ask for it"] },
];

interface LogRow {
  id: string;
  at: number;
  kind: string;
  summary: string;
  status: "done" | "failed" | "cancelled";
}

/** users/{uid}.comicSettings.agentAuto: do what the agent is asked without repeating it back first. */
function useAgentAuto(uid: string) {
  const [auto, setAuto] = useState(false);
  useEffect(() => onSnapshot(doc(db, "users", uid), (s) => setAuto(Boolean(s.data()?.comicSettings?.agentAuto)), () => undefined), [uid]);
  return [auto, (v: boolean) => setDoc(doc(db, "users", uid), { comicSettings: { agentAuto: v } }, { merge: true })] as const;
}

/** Settings: "What you can say" to the agent number, how it checks with you, and what it did lately (users/{uid}/agentLog). */
export function AgentHelp({ uid }: { uid: string }) {
  const [auto, setAuto] = useAgentAuto(uid);
  const alsoCurate = useAgentScope(uid).curate;
  const log = useCollection<LogRow>(uid, "agentLog", [orderBy("at", "desc"), limit(15)], "log");
  const now = useClock(60_000);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="min-w-0 rounded-lg bg-surface-low p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 flex-none place-items-center rounded-md bg-surface-high text-primary">
            <IconChatCheck aria-hidden className="icon size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="type-title-m">What you can say</h3>
            <p className="mt-1 type-body-m text-on-surface-variant">Message the agent number from your own WhatsApp. It changes your rooms, spots and asks for you, and checks with you first for anything that matters.</p>
          </div>
        </div>
        <div className="mt-3 grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2">
          {EXAMPLES.map((g) => (
            <div key={g.title} className="min-w-0">
              <p className="type-label-l text-on-surface-variant">{g.title}</p>
              <ul className="mt-1 flex flex-col gap-1">
                {g.lines.map((l) => (
                  <li key={l} className="break-words type-body-m">“{l}”</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {alsoCurate && <p className="mt-3 type-body-s text-on-surface-variant">{OTHER_APP_NOTE.comedy}</p>}
      </div>
      <div className="rounded-lg bg-surface-low px-4">
        <SettingRow label="Do it without asking" info="Off (recommended): before it changes a curator, closes or pauses a room, or messages anyone, the agent repeats what it will do and waits for your yes. On: it just does it and tells you.">
          <Switch label="Do it without asking" checked={auto} onChange={(v) => void setAuto(v)} />
        </SettingRow>
      </div>
      <div className="min-w-0">
        <SectionTitle>What the agent did</SectionTitle>
        {log.data.length === 0 ? (
          <p className="rounded-lg bg-surface-low p-4 type-body-m text-on-surface-variant">{log.loading ? "…" : "Nothing yet. Changes the agent makes for you are listed here."}</p>
        ) : (
          <ul className="flex flex-col rounded-lg bg-surface-low px-4">
            {log.data.map((e) => (
              <li key={e.id} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-outline-variant py-2 last:border-b-0">
                <span className="min-w-0 break-words type-body-m">{e.status === "done" ? e.summary : e.status === "cancelled" ? `Cancelled: ${e.summary}` : `Didn't work: ${e.summary}`}</span>
                <span className="flex-none type-body-s text-on-surface-variant">{ago(e.at, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
