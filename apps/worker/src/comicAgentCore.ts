// Nothing BOT Comedy on the agent number: the comic's conversation, with everything outside it (Firestore, the model, WhatsApp)
// handed in. comicAgent.ts wires the real ones; the tests wire fakes. The rules of what a message means and what a plan does are
// in packages/shared/src/comicAgent.ts; this file is the order things happen in:
//   1. something is waiting for a yes or a number: that message answers it,
//   2. else rules read the message, else (when allowed) the model fills the same intent shape,
//   3. the plan is run now (safe things, or the comic's "auto" setting) or repeated back first,
//   4. every change is written as the same documents the app writes, then logged for the app to show.
import {
  COMIC_INTENT_SCHEMA,
  askSentText,
  comicAskText,
  comicIntentPrompt,
  executeComic,
  normalizeComicIntent,
  parseComicIntentByRules,
  planComic,
  stepComicPending,
  strictNo,
  strictYes,
  type ComicIntent,
  type ComicPending,
  type ComicPlan,
  type ComicWorld,
  type ComicWrites,
} from "@spot/shared";

export interface ComicLogEntry {
  at: number;
  kind: string;
  summary: string;
  status: "done" | "failed" | "cancelled";
}

/** What the conversation can read and do. The real one is comicAgent.ts; tests pass fakes. */
export interface ComicDeps {
  /** The agent switches the comic left on, their time zone and the "do it without asking" setting. */
  settings(): Promise<{ answer: boolean; actions: boolean; auto: boolean; tz: string }>;
  /** A fresh read of rooms, curators, asks, spots (with regulars folded in), alerts and the ask template. */
  load(): Promise<Omit<ComicWorld, "auto" | "today" | "nowMs" | "tz">>;
  readPending(): Promise<ComicPending | null>;
  writePending(p: ComicPending | null): Promise<void>;
  /** Writes the documents the app would write (merge: a draft keeps its reminder stamps). */
  apply(w: ComicWrites): Promise<void>;
  /** The existing send_ask logic: send the drafted ask from the comic's own WhatsApp. Throws a sentence when it can't. */
  sendAsk(askId: string): Promise<{ body?: string } | void>;
  /** The existing "Ask for it": DM the contact of a spot alert. */
  askForSpot(alertId: string, body: string): Promise<{ sentTo?: string } | void>;
  /** A JSON answer from the comic's own AI routes. May throw. */
  model(prompt: string, schema: Record<string, unknown>): Promise<string>;
  log(e: ComicLogEntry): Promise<void>;
  say(text: string): Promise<unknown>;
  now(): number;
}

const QUESTIONS = new Set<ComicIntent["name"]>(["spots_on_day", "spot_count", "open_alerts", "open_asks", "help"]);
const dateOf = (ms: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const hhmmOf = (ms: number, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

export function comicAgent(d: ComicDeps) {
  async function world(): Promise<ComicWorld> {
    const [s, data] = await Promise.all([d.settings(), d.load()]);
    const nowMs = d.now();
    return { ...data, today: dateOf(nowMs, s.tz), nowMs, tz: s.tz, auto: s.auto };
  }

  /** The plan runs: writes, sends, a line in the log, one reply. */
  async function run(plan: ComicPlan) {
    const w = await world();
    const r = executeComic(plan, w);
    const at = d.now();
    try {
      await d.apply(r.writes);
      if (r.send?.kind === "ask") {
        try {
          const sent = await d.sendAsk(r.send.askId);
          await d.say(askSentText(r.send.to, (sent && sent.body) || r.writes.asks[0]?.message || ""));
        } catch (e) {
          const why = (e as Error).message;
          await d.log({ at, kind: r.log.kind, summary: `Couldn't send the ask to ${r.send.to}: ${why}`, status: "failed" });
          return void (await d.say(`I couldn't send it: ${why} The draft is waiting in Asks.`));
        }
      } else if (r.send?.kind === "alert") {
        try {
          const sent = await d.askForSpot(r.send.alertId, r.send.body);
          await d.say(`Sent to ${(sent && sent.sentTo) || r.send.to}: "${r.send.body}"\nI'll leave the rest to them.`);
        } catch (e) {
          const why = (e as Error).message;
          await d.log({ at, kind: r.log.kind, summary: `Couldn't ask ${r.send.to}: ${why}`, status: "failed" });
          return void (await d.say(`I couldn't send it: ${why}`));
        }
      } else await d.say(r.reply);
      await d.log({ at, ...r.log });
    } catch (e) {
      await d.log({ at, kind: r.log.kind, summary: (e as Error).message, status: "failed" });
      await d.say(`That didn't work: ${(e as Error).message}`);
    }
  }

  /** Plans what was asked: answers, asks a question, or runs. */
  async function act(intent: ComicIntent): Promise<void> {
    const s = await d.settings();
    const question = QUESTIONS.has(intent.name);
    if (question && intent.name !== "help" && !s.answer) return void (await d.say("Answering questions is switched off in Settings."));
    if (!question && intent.name !== "unknown" && !s.actions) return void (await d.say("Doing things for you is switched off in Settings, so I didn't touch anything."));
    const w = await world();
    const p = planComic(intent, w);
    if (p.pending) {
      await d.writePending(p.pending);
      return void (await d.say(comicAskText(p.pending)));
    }
    if (p.run) return run(p.run);
    await d.say(p.reply ?? "I couldn't work that out.");
  }

  return {
    /** A message while something is waiting for an answer. True when it was that answer (or a late answer to it). */
    async answerPending(text: string): Promise<boolean> {
      const pending = await d.readPending();
      if (!pending) return false;
      const s = await d.settings();
      const step = stepComicPending(pending, text, d.now(), s.auto);
      if (step.type === "none") return false;
      if (step.type === "reprompt") return void (await d.say(step.text)), true;
      if (step.type === "chosen") {
        await d.writePending(step.pending);
        return void (await d.say(comicAskText(step.pending))), true;
      }
      await d.writePending(null);
      if (step.type === "execute") {
        if (!s.actions) return void (await d.say("Actions are switched off in Settings, so I did nothing.")), true;
        await run(step.plan);
        return true;
      }
      if (step.type === "cancel") {
        if (step.plan) await d.log({ at: d.now(), kind: step.plan.type, summary: step.plan.summary.split("\n")[0]!, status: "cancelled" });
        return void (await d.say("Okay, cancelled. Nothing changed.")), true;
      }
      if (step.type === "expired") {
        await d.say("That one timed out after 10 minutes, so nothing was changed. Ask me again if you still want it.");
        return strictYes(text) || strictNo(text);
      }
      // drop: a new request. The old question is gone; say so in a few words so nobody waits on it.
      await d.say(`(Dropped the earlier question: ${(pending.stage === "confirm" ? pending.summary : pending.prompt).split("\n")[0]!.slice(0, 80)}. Say it again if you still want it.)`);
      return false;
    },

    /** Rules only: true when the message was one of the comic's commands (and was handled). */
    async byRules(text: string): Promise<boolean> {
      const nowMs = d.now();
      const s = await d.settings();
      const intent = parseComicIntentByRules(text, { today: dateOf(nowMs, s.tz), nowHHMM: hhmmOf(nowMs, s.tz) });
      if (!intent) return false;
      await act(intent);
      return true;
    },

    /** The model reads the message. True when handled (an unreadable message gets the "what I can do" card). */
    async byModel(text: string, o: { quiet?: boolean } = {}): Promise<boolean> {
      const s = await d.settings();
      if (!s.answer && !s.actions) return false;
      const w = await world();
      let intent: ComicIntent;
      try {
        const out = await d.model(
          comicIntentPrompt(text, { today: w.today, rooms: w.rooms.map((r) => ({ name: r.name, area: r.area, aliases: r.aliases })), curators: w.curators.map((c) => c.name) }),
          COMIC_INTENT_SCHEMA as unknown as Record<string, unknown>,
        );
        intent = normalizeComicIntent(out, text, w.today);
      } catch {
        intent = { name: "unknown", text };
      }
      // quiet: the caller has another side to try, so an unreadable message is not answered here.
      if (o.quiet && intent.name === "unknown") return false;
      await act(intent);
      return true;
    },
  };
}
