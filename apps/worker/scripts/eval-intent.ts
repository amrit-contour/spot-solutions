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
];

const model = { ...DEFAULT_SETTINGS.model, name: process.argv[2] ?? DEFAULT_SETTINGS.model.name, fallback: false };
let ok = 0;
for (const [msgs, want, days] of cases) {
  const t = Date.now();
  const r = await classify(msgs, shows, model);
  const pass = r.isSpotRequest === want && (!want || days.every((d) => r.preferredDays.includes(d as never)));
  ok += pass ? 1 : 0;
  console.log(`${pass ? "PASS" : "FAIL"} ${Date.now() - t}ms conf=${r.confidence} days=${r.preferredDays} | ${msgs.join(" / ")} | ${r.note}`);
}
console.log(`\n${ok}/${cases.length} correct with ${model.name}`);
