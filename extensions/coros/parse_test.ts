/**
 * Parsers against fixtures in the official server's real format.
 *
 * The fixtures copy the layout of captured responses with the numbers changed:
 * this repository is public, and the shape is what is under test, not anyone's
 * sleep.
 *
 * Run with: ~/.swamp/deno/deno test --allow-read
 */
import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  minutes,
  num,
  pairs,
  parseCreateResult,
  parseDailyHealth,
  parseFitness,
  parseRecovery,
  parseRestingHr,
  parseSleepHrv,
  parseSleepOverview,
  parseStress,
  parseTrainingLoad,
} from "./_lib/parse.ts";
import { mergeDays } from "./official.ts";

const fx = (name: string) =>
  Deno.readTextFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url));

Deno.test("num ignores thousands separators and units", () => {
  assertEquals(num("17,849"), 17849);
  assertEquals(num("1,072 kcal"), 1072);
  assertEquals(num("1.18"), 1.18);
  assertEquals(num("No data"), null);
  assertEquals(num(undefined), null);
});

Deno.test("minutes reads every duration spelling COROS uses", () => {
  assertEquals(minutes("8h 7min (incl. naps)"), 487);
  assertEquals(minutes("10 min"), 10);
  assertEquals(minutes("1h 12min"), 72);
  assertEquals(minutes("49:34"), 50);
  assertEquals(minutes("No data"), null);
});

Deno.test("pairs splits pipe-separated runs and lower-cases keys", () => {
  assertEquals(pairs("Steps: 6,215 | Calories: 786 kcal"), [
    ["steps", "6,215"],
    ["calories", "786 kcal"],
  ]);
  // A value with its own colons keeps them: the key ends at the first.
  assertEquals(pairs("Main Sleep Window: 2026-01-09 23:02 - 2026-01-10 06:43"), [
    ["main sleep window", "2026-01-09 23:02 - 2026-01-10 06:43"],
  ]);
});

Deno.test("sleep overview: every field, and the nap line in both spellings", () => {
  const s = parseSleepOverview(fx("sleep_overview"));
  assertEquals([...s.keys()], ["2026-01-10", "2026-01-11"]);
  assertEquals(s.get("2026-01-10"), {
    score: 84,
    dailyMinutes: 487,
    mainAsleepMinutes: 452,
    mainPeriodMinutes: 461,
    deepPct: 11,
    lightPct: 53,
    remPct: 34,
    awakePct: 2,
    awakeMinutes: 9,
    awakeCount: 0,
    mainStart: "2026-01-09 23:02",
    mainEnd: "2026-01-10 06:43",
    napMinutes: 35,
  });
  assertEquals(s.get("2026-01-11")?.napMinutes, 0);
  assertEquals(s.get("2026-01-11")?.awakeCount, 1);
});

Deno.test("daily health: per-day values, and the header kept off any one day", () => {
  const h = parseDailyHealth(fx("daily_health"));
  assertEquals(h.restingHr, 50);
  assertEquals(h.hrvBaseline, 44);
  const d = h.days.get("2026-01-10")!;
  assertEquals(d.activity, { steps: 17849, calories: 1072, exerciseMinutes: 72, stressAvg: 30 });
  assertEquals(d.stages, {
    totalMinutes: 461,
    deepMinutes: 51,
    lightMinutes: 243,
    remMinutes: 158,
    awakeMinutes: 9,
    avgHr: 48,
    minHr: 40,
    maxHr: 69,
  });
  assertEquals(h.days.get("2026-01-11")?.activity.exerciseMinutes, 50);
});

Deno.test("sleep HRV: assessment parsed, time series ignored", () => {
  const h = parseSleepHrv(fx("sleep_hrv"));
  assertEquals([...h.keys()].sort(), ["2026-01-10", "2026-01-11"]);
  assertEquals(h.get("2026-01-11"), {
    avg: 55,
    status: "Below normal",
    rangeLow: 61,
    rangeHigh: 83,
    baseline: 72,
  });
});

Deno.test("resting HR, stress and training load per day", () => {
  assertEquals([...parseRestingHr(fx("resting_hr"))], [["2026-01-11", 52], ["2026-01-10", 49]]);
  assertEquals(parseStress(fx("stress")).get("2026-01-10"), 31);
  assertEquals(parseTrainingLoad(fx("training_load")).get("2026-01-10"), {
    comment: "Optimized",
    shortTerm: 72,
    longTerm: 61,
    ratio: 1.18,
  });
});

Deno.test("recovery and fitness snapshots", () => {
  assertEquals(parseRecovery(fx("recovery")), { percent: 98, level: "Fresh", fullRecoveryIn: "4h" });
  const f = parseFitness(fx("fitness"));
  assertEquals(f.vo2max, 50);
  assertEquals(f.thresholdPaceSecPerKm, 270);
  assertEquals(f.predictions["half marathon"], "1:39:00");
});

Deno.test("a reworded label loses one field, not the record", () => {
  const text = fx("sleep_overview").replace("Sleep Score:", "Sleep Quality Score:");
  const s = parseSleepOverview(text).get("2026-01-10")!;
  assertEquals(s.score, null);
  assertEquals(s.deepPct, 11);
});

Deno.test("mergeDays joins every source on the wake-up date", () => {
  const days = mergeDays({
    sleep: parseSleepOverview(fx("sleep_overview")),
    health: parseDailyHealth(fx("daily_health")).days,
    hrv: parseSleepHrv(fx("sleep_hrv")),
    rhr: parseRestingHr(fx("resting_hr")),
    stress: parseStress(fx("stress")),
    load: parseTrainingLoad(fx("training_load")),
  }, "2026-01-11T12:00:00Z");
  assertEquals(days.map((d) => d.date), ["2026-01-10", "2026-01-11"]);
  const d = days[1];
  assertEquals(d.sleep?.score, 69);
  assertEquals(d.stages?.deepMinutes, 83);
  assertEquals(d.hrv?.status, "Below normal");
  assertEquals(d.restingHr, 52);
  assertEquals(d.stressAvg, 27);
  assertEquals(d.load?.ratio, 1.01);
});

Deno.test("mergeDays leaves a source's fields null when it failed", () => {
  const days = mergeDays({
    sleep: parseSleepOverview(fx("sleep_overview")),
    health: new Map(),
    hrv: new Map(),
    rhr: new Map(),
    stress: new Map(),
    load: new Map(),
  }, "t");
  assertEquals(days[0].hrv, null);
  assertEquals(days[0].sleep?.score, 84);
});

Deno.test("create results yield the ids needed to change the workout later", () => {
  assertEquals(
    parseCreateResult("Workout created on 2026-01-12.\nidInPlan: 7\nOther workouts that day: none"),
    { idInPlan: "7", workoutId: null },
  );
  assertEquals(
    parseCreateResult("Saved to library. Workout ID: 123456789012345678"),
    { idInPlan: null, workoutId: "123456789012345678" },
  );
});
