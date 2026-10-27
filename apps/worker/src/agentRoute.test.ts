import { describe, expect, it } from "vitest";
import { NOT_USING_COMEDY, NOT_USING_CURATE, SIDE_QUESTION, type AgentScope, type SideAsk } from "@spot/shared";
import { dispatch, type RouteHandlers } from "./agentRoute.ts";

const NOW = Date.parse("2026-10-27T07:00:00Z");

/** Both sides are fakes that record what they were asked, plus waiting questions of either side. */
function rig(scope: AgentScope, o: { curatePending?: boolean; comicPending?: boolean; model?: "curate" | "comic" | "none" } = {}) {
  const calls: string[] = [];
  const said: string[] = [];
  let sideAsk: SideAsk | null = null;
  let curatePending = o.curatePending ?? false;
  let comicPending = o.comicPending ?? false;
  const h: RouteHandlers = {
    say: async (t) => void said.push(t),
    now: () => NOW,
    readSideAsk: async () => sideAsk,
    writeSideAsk: async (a) => {
      sideAsk = a;
      if (a) curatePending = comicPending = false;
    },
    curate: {
      answerPending: async (t) => {
        if (!curatePending || !/^yes$/i.test(t)) return false;
        calls.push("curate:pending");
        curatePending = false;
        return true;
      },
      micAnswer: async () => false,
      run: async (t) => {
        calls.push(`curate:${t}`);
        return o.model === "curate" || /lineup|confirm|add .* to|waiting/i.test(t) ? "done" : "unknown";
      },
    },
    comic: {
      answerPending: async (t) => {
        if (!comicPending || !/^yes$/i.test(t)) return false;
        calls.push("comic:pending");
        comicPending = false;
        return true;
      },
      byRules: async (t) => {
        const ok = /spot|ask|regular|alert|room/i.test(t);
        if (ok) calls.push(`comic:${t}`);
        return ok;
      },
      byModel: async (t, q) => {
        calls.push(`comic-model:${t}`);
        return o.model === "comic" || !q?.quiet;
      },
    },
  };
  return { send: (t: string) => dispatch(scope, t, h), calls, said, get sideAsk() { return sideAsk; } };
}

const CURATE = { curate: true, comedy: false };
const COMEDY = { curate: false, comedy: true };
const BOTH = { curate: true, comedy: true };

describe("curate only", () => {
  it("runs curator work and never parses comic commands", async () => {
    const r = rig(CURATE);
    await r.send("Monday lineup?");
    expect(r.calls).toEqual(["curate:Monday lineup?"]);
  });
  it("points comic phrases at the Comedy app", async () => {
    const r = rig(CURATE);
    await r.send("I got a spot at Banter tonight 9pm");
    expect(r.calls).toEqual([]);
    expect(r.said[0]).toContain(NOT_USING_COMEDY.slice(0, 40));
    expect(r.said[0]).toContain("Monday lineup?");
    expect(r.said[0]).not.toContain("I got a spot");
  });
  it("ignores a waiting comic question", async () => {
    const r = rig(CURATE, { comicPending: true });
    await r.send("yes");
    expect(r.calls).not.toContain("comic:pending");
  });
  it("help lists only Curate", async () => {
    const r = rig(CURATE);
    await r.send("what can you do");
    expect(r.said[0]).toContain("Monday lineup?");
    expect(r.said[0]).not.toContain("Rooms");
  });
});

describe("comedy only", () => {
  it("runs comic work and never the curator flow", async () => {
    const r = rig(COMEDY);
    await r.send("I got a spot at Banter tonight 9pm");
    expect(r.calls).toEqual(["comic:I got a spot at Banter tonight 9pm"]);
  });
  it("points curator phrases at Curate", async () => {
    const r = rig(COMEDY);
    await r.send("confirm Monday");
    expect(r.calls).toEqual([]);
    expect(r.said[0]).toContain(NOT_USING_CURATE.slice(0, 40));
    expect(r.said[0]).toContain("Spots");
    expect(r.said[0]).not.toContain("Monday lineup?");
  });
  it("ignores a waiting curator question", async () => {
    const r = rig(COMEDY, { curatePending: true });
    await r.send("yes");
    expect(r.calls).not.toContain("curate:pending");
  });
  it("help lists only Comedy", async () => {
    const r = rig(COMEDY);
    await r.send("help");
    expect(r.said[0]).toContain("I got a spot");
    expect(r.said[0]).not.toContain("Monday lineup?");
  });
});

describe("both", () => {
  it("clear curate goes to Curate, clear comedy to Comedy, no question", async () => {
    const r = rig(BOTH);
    await r.send("Monday lineup?");
    await r.send("I got a spot at Banter tonight");
    expect(r.calls).toEqual(["curate:Monday lineup?", "comic:I got a spot at Banter tonight"]);
    expect(r.said).toEqual([]);
  });
  it("help lists both", async () => {
    const r = rig(BOTH);
    await r.send("hi");
    expect(r.said[0]).toContain("Monday lineup?");
    expect(r.said[0]).toContain("I got a spot at Banter tonight");
  });
  it("a genuinely ambiguous message is asked once; 1 replays it on Curate, 2 on Comedy; nothing runs before the answer", async () => {
    for (const [answer, expected] of [["1", "curate:set Bloom cancelled"], ["2", "comic:set Bloom cancelled"]] as const) {
      let ask: SideAsk | null = null;
      const calls: string[] = [];
      const said: string[] = [];
      const h: RouteHandlers = {
        say: async (t) => void said.push(t),
        now: () => NOW,
        readSideAsk: async () => ask,
        writeSideAsk: async (a) => void (ask = a),
        curate: { answerPending: async () => false, micAnswer: async () => false, run: async (t) => (calls.push(`curate:${t}`), "done") },
        comic: { answerPending: async () => false, byRules: async (t) => (calls.push(`comic:${t}`), true), byModel: async () => true },
      };
      // Both sides' rules read it (a show called off, or a room closed) and neither side's own words are in it.
      await dispatch(BOTH, "set Bloom cancelled", h);
      expect(said).toEqual([SIDE_QUESTION]);
      expect(calls).toEqual([]);
      await dispatch(BOTH, answer, h);
      expect(calls).toEqual([expected]);
      expect(ask).toBeNull();
    }
  });
  it("no cancels the question; anything else drops it", async () => {
    let ask: SideAsk | null = { text: "x", createdAt: NOW, expiresAt: NOW + 1000 };
    const said: string[] = [];
    const calls: string[] = [];
    const h: RouteHandlers = {
      say: async (t) => void said.push(t),
      now: () => NOW,
      readSideAsk: async () => ask,
      writeSideAsk: async (a) => void (ask = a),
      curate: { answerPending: async () => false, micAnswer: async () => false, run: async (t) => (calls.push(`curate:${t}`), "done") },
      comic: { answerPending: async () => false, byRules: async () => false, byModel: async () => true },
    };
    await dispatch(BOTH, "no", h);
    expect(said).toEqual(["Okay, nothing was changed."]);
    ask = { text: "x", createdAt: NOW, expiresAt: NOW + 1000 };
    await dispatch(BOTH, "Monday lineup?", h);
    expect(calls).toEqual(["curate:Monday lineup?"]);
    expect(ask).toBeNull();
  });
  it("pending answers go to the side that asked", async () => {
    const a = rig(BOTH, { curatePending: true });
    await a.send("yes");
    expect(a.calls).toEqual(["curate:pending"]);
    const b = rig(BOTH, { comicPending: true });
    await b.send("yes");
    expect(b.calls).toEqual(["comic:pending"]);
  });
  it("neither side's rules read it: the model tries Curate, then Comedy", async () => {
    const r = rig(BOTH, { model: "comic" });
    await r.send("gibberish zzz");
    expect(r.calls).toEqual(["curate:gibberish zzz", "comic-model:gibberish zzz"]);
  });
});
