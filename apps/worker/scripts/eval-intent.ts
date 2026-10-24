// Runs the intent prompt against local Gemma on a fixture set. `pnpm eval`
import { classify } from "../src/gemma.ts";
import { DEFAULT_SETTINGS, type Show } from "@spot/shared";

const shows = [
  { name: "Monday Mic", weekday: 1, startTime: "20:00" },
  { name: "Tuesday Trial", weekday: 2, startTime: "20:30" },
] as Show[];

const cases: [string[], boolean, number[]][] = [
  [["hey bro", "any spot this monday?"], true, [1]],
  [["bhai tuesday ka mic hai kya", "naya 5 min hai"], true, [2]],
  [["can i come up next week? either day works"], true, [1, 2]],
  [["put me down pls"], true, []],
  [["haha that set was insane last night"], false, []],
  [["how much are tickets for monday show? want to bring friends"], false, []],
  [["thanks man!"], false, []],
  [["yo", "kab free hai", "need to try some new bits before my special, mon chalega"], true, [1]],
  [["paid the ₹200 for last week"], false, []],
  [["guru monday spot sigutta?"], true, [1]],
  [["Dear User,\nYour bill has been generated. Turn on AutoPay to never miss a due date. Amount ₹499 due 12 Oct."], false, []],
  [["NOTICE: Account Inactivity Notification\nYour payments bank account will be marked inactive. Please transact to keep it active."], false, []],
  [["Property: 2BHK apartment, furnished\nRent: 30,000\nLocation: HSR Layout\nContact for visit"], false, []],
  [["https://example.com/share/v/abc123"], false, []],
  [["Your payment of ₹1,250.00 at a restaurant was successful"], false, []],
  [["Can i get a spot for Tue?"], true, [2]],
  [["Hi! I'm new to the Bangalore scene and would love to get on one of your mics sometime"], true, []],
];

// [messages, expected kind]
const kindCases: [string[], string][] = [
  [["bro can't make it monday, something came up. please cancel my spot"], "cancel_spot"],
  [["hey did I get a spot this week?"], "status_query"],
  [["when was the last time I performed at your mic?"], "last_spot_query"],
  [["any spot this tuesday?"], "spot_request"],
  [["thanks for the set yesterday!"], "other"],
];

// usage: eval-intent.ts [model] [ollama|gemini]
const model = { primary: { provider: (process.argv[3] ?? "ollama") as "ollama" | "gemini", model: process.argv[2] ?? "gemma3:4b" }, fallback: null };
let ok = 0;
for (const [msgs, want, days] of cases) {
  const t = Date.now();
  const r = await classify(null, msgs, shows, model);
  const pass = r.isSpotRequest === want && (!want || days.every((d) => r.preferredDays.includes(d as never)));
  ok += pass ? 1 : 0;
  console.log(`${pass ? "PASS" : "FAIL"} ${Date.now() - t}ms conf=${r.confidence} days=${r.preferredDays} | ${msgs.join(" / ")} | ${r.note}`);
}
console.log(`\n${ok}/${cases.length} correct with ${model.primary.model}`);
let kOk = 0;
for (const [msgs, want] of kindCases) {
  const r = await classify(null, msgs, shows, model);
  kOk += r.kind === want ? 1 : 0;
  console.log(`${r.kind === want ? "PASS" : "FAIL"} kind=${r.kind} (want ${want}) | ${msgs.join(" / ")}`);
}
console.log(`${kOk}/${kindCases.length} kinds correct`);
