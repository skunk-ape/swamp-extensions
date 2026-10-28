/**
 * The report page, from records shaped like the ones the behaviors write.
 *
 * Run with: ~/.swamp/deno/deno test
 */
import { assert, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { render } from "./recent_report.ts";

const day = {
  date: "2026-01-11",
  sleep: { score: 69, mainAsleepMinutes: 375, deepPct: 22, remPct: 20 },
  stages: null,
  hrv: { avg: 55, status: "Below normal", rangeLow: 61, rangeHigh: 83, baseline: 72 },
  restingHr: 52,
  activity: { steps: 6215 },
  stressAvg: 27,
  load: { comment: "Optimized", shortTerm: 61, longTerm: 60, ratio: 1.01 },
};

Deno.test("headline leads with recovery, sleep, HRV against its range, RHR and load", () => {
  const md = render({
    units: "imperial",
    days: [day],
    snapshot: { today: "2026-01-11", recovery: { percent: 98, level: "Fresh" }, errors: [], schedule: "" },
    metrics: [],
    activities: [],
    failedSteps: [],
  });
  assertStringIncludes(md, "**Recovery 98%** (Fresh) · sleep 69 (6h15) · HRV 55 ms in 61-83 — Below normal · RHR 52 · load ratio 1.01 (Optimized)");
  assertStringIncludes(md, "| Sun 01-11 | 69 | 6h15 | 22% | 20% | 55 (below normal) | 52 | 27 | 6,215 |");
});

Deno.test("activities show pace in the athlete's unit, and only for runs", () => {
  const md = render({
    units: "imperial",
    days: [],
    snapshot: null,
    metrics: [],
    activities: [
      { startTime: "2026-01-10T15:00:00.000Z", sport: "Trail Run", sportType: 102, name: "Hills", distanceMetres: 6750, durationSeconds: 2974, avgHr: 124, trainingLoad: 60 },
      { startTime: "2026-01-09T15:00:00.000Z", sport: "Road Bike", sportType: 200, name: "Ride", distanceMetres: 30000, durationSeconds: 3600, avgHr: 120, trainingLoad: 40 },
    ],
    failedSteps: [],
  });
  assertStringIncludes(md, "| Sat 01-10 | Trail Run | Hills | 4.19 mi | 49:34 | 11:49/mi | 124 | 60 |");
  assertStringIncludes(md, "| Fri 01-09 | Road Bike | Ride | 18.64 mi | 1:00:00 | – | 120 | 40 |");
});

Deno.test("a failed step and a failed tool are reported as gaps, not hidden", () => {
  const md = render({
    units: "imperial",
    days: [day],
    snapshot: { today: "2026-01-11", errors: [{ tool: "querySleepHrv", error: "timeout" }], schedule: "" },
    metrics: [],
    activities: [],
    failedSteps: ["coros-hub.recent"],
  });
  assertStringIncludes(md, "## Gaps");
  assertStringIncludes(md, "step **coros-hub.recent** failed");
  assertStringIncludes(md, "querySleepHrv: timeout");
});

Deno.test("an empty run still renders a page", () => {
  const md = render({ units: "metric", days: [], snapshot: null, metrics: [], activities: [], failedSteps: [] });
  assert(md.startsWith("# COROS"));
});
