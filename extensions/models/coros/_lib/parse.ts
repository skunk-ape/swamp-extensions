// Typed records from the official server's prose.
//
// COROS's MCP answers in text written for a model to read: "Sleep Score: 91",
// "Deep: 1h 34min". Swamp data wants fields a CEL query can compare, so this
// file reads the text back into numbers.
//
// That is the fragile part of the extension, and it is written to fail soft in
// one specific way. Each parser works line by line on `Key: value` pairs and
// knows the keys it maps; a key it does not know is ignored, and a key that
// disappears leaves its field null. Rewording a label therefore loses one
// field rather than the record, and the raw text is stored beside the parse so
// nothing is lost outright. What would break it is a change of shape — dates
// no longer heading their blocks — and the tests pin that shape.

import { clockSeconds, isoDate } from "./units.ts";

export type SleepOverview = {
  score: number | null;
  dailyMinutes: number | null;
  mainAsleepMinutes: number | null;
  mainPeriodMinutes: number | null;
  deepPct: number | null;
  lightPct: number | null;
  remPct: number | null;
  awakePct: number | null;
  awakeMinutes: number | null;
  awakeCount: number | null;
  mainStart: string | null;
  mainEnd: string | null;
  napMinutes: number | null;
};

export type SleepStages = {
  totalMinutes: number | null;
  deepMinutes: number | null;
  lightMinutes: number | null;
  remMinutes: number | null;
  awakeMinutes: number | null;
  avgHr: number | null;
  minHr: number | null;
  maxHr: number | null;
};

export type DailyActivity = {
  steps: number | null;
  calories: number | null;
  exerciseMinutes: number | null;
  stressAvg: number | null;
};

export type HrvAssessment = {
  avg: number | null;
  status: string | null;
  rangeLow: number | null;
  rangeHigh: number | null;
  baseline: number | null;
};

export type LoadAssessment = {
  comment: string | null;
  shortTerm: number | null;
  longTerm: number | null;
  ratio: number | null;
};

export type Recovery = {
  percent: number | null;
  level: string | null;
  fullRecoveryIn: string | null;
};

export type Fitness = {
  vo2max: number | null;
  runningLevel: number | null;
  thresholdPaceSecPerKm: number | null;
  predictions: Record<string, string>;
};

// --- primitives ----------------------------------------------------------

/** First number in a string, ignoring thousands separators. */
export function num(s: string | undefined | null): number | null {
  if (s === undefined || s === null) return null;
  const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Minutes from "8h 7min", "10 min", "1h", or a clock "49:34" (m:ss). */
export function minutes(s: string | undefined | null): number | null {
  if (!s) return null;
  const t = s.trim();
  const clock = clockSeconds(t.split(/\s/)[0]);
  if (clock !== null) return Math.round(clock / 60);
  const h = t.match(/(\d+)\s*h/);
  const m = t.match(/(\d+)\s*min/);
  if (!h && !m) return null;
  return Number(h?.[1] ?? 0) * 60 + Number(m?.[1] ?? 0);
}

/**
 * `Key: value` pairs from a line, including pipe-separated runs such as
 * "Steps: 17,849 | Calories: 1,072 kcal". Keys are lower-cased and trimmed so a
 * change of capitalisation is not a change of key.
 */
export function pairs(line: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of line.split(/\s+\|\s+/)) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (key) out.push([key, value]);
  }
  return out;
}

/**
 * Split text into blocks headed by a date line.
 *
 * `header` matches a line that starts a block and captures the date in its
 * first group; everything until the next header belongs to that date. Text
 * before the first header is returned under "".
 */
export function dateBlocks(
  text: string,
  header: RegExp,
): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let current = "";
  blocks.set(current, []);
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(header);
    if (m) {
      current = isoDate(m[1]);
      if (!blocks.has(current)) blocks.set(current, []);
      // A header line may carry its own value ("2026-10-24: 52 bpm").
      const rest = line.slice(m[0].length).trim();
      if (rest) blocks.get(current)!.push(rest);
      continue;
    }
    blocks.get(current)!.push(line);
  }
  return blocks;
}

function kv(lines: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of lines) {
    for (const [k, v] of pairs(line)) if (!m.has(k)) m.set(k, v);
  }
  return m;
}

// --- per-tool parsers ----------------------------------------------------

const ISO_LINE = /^(\d{4}-\d{2}-\d{2}):?\s*$/;

/** querySleepOverview: one block per wake-up day. */
export function parseSleepOverview(text: string): Map<string, SleepOverview> {
  const out = new Map<string, SleepOverview>();
  for (const [date, lines] of dateBlocks(text, ISO_LINE)) {
    if (!date) continue;
    const f = kv(lines);
    const window = f.get("main sleep window") ?? "";
    const [start, end] = window.split(/\s+-\s+/);
    out.set(date, {
      score: num(f.get("sleep score")),
      dailyMinutes: minutes(f.get("daily sleep")),
      mainAsleepMinutes: minutes(f.get("main sleep (asleep)")),
      mainPeriodMinutes: minutes(f.get("main sleep period (incl. awake)")),
      deepPct: num(f.get("deep sleep ratio")),
      lightPct: num(f.get("light sleep ratio")),
      remPct: num(f.get("rem ratio")),
      awakePct: num(f.get("awake ratio")),
      awakeMinutes: minutes(f.get("awake time")),
      awakeCount: num(f.get("awake count (>5 min)")),
      mainStart: start?.trim() || null,
      mainEnd: end?.trim() || null,
      napMinutes: minutes(f.get("naps total (asleep)") ?? f.get("naps total")),
    });
  }
  return out;
}

/**
 * queryDailyHealthData: steps, calories, stress and sleep stages per day.
 *
 * The header line carries account-wide values too ("Resting HR: 52 bpm | HRV
 * Baseline: 42 ms"). Those are returned separately: they are today's figures,
 * not any one day's, and attaching them to a date would be a small lie.
 */
export function parseDailyHealth(text: string): {
  days: Map<string, { activity: DailyActivity; stages: SleepStages }>;
  restingHr: number | null;
  hrvBaseline: number | null;
} {
  const blocks = dateBlocks(text, /^-{2,}\s*(\d{8})\s*-{2,}\s*$/);
  const head = kv(blocks.get("") ?? []);
  const days = new Map<
    string,
    { activity: DailyActivity; stages: SleepStages }
  >();
  for (const [date, lines] of blocks) {
    if (!date) continue;
    const f = kv(lines);
    const stress = f.get("stress");
    days.set(date, {
      activity: {
        steps: num(f.get("steps")),
        calories: num(f.get("calories")),
        exerciseMinutes: minutes(f.get("exercise")),
        stressAvg: stress ? num(stress) : null,
      },
      stages: {
        totalMinutes: minutes(f.get("total")),
        deepMinutes: minutes(f.get("deep")),
        lightMinutes: minutes(f.get("light")),
        remMinutes: minutes(f.get("rem")),
        awakeMinutes: minutes(f.get("awake")),
        // "Sleep HR: Avg 48 bpm | Min 40 bpm | Max 69 bpm" splits on the pipes
        // into one pair and two fragments with no colon, so read the line.
        ...sleepHr(lines),
      },
    });
  }
  // The header line splits on " | " as well, so its keys land in `head`.
  return {
    days,
    restingHr: num(head.get("resting hr")),
    hrvBaseline: num(head.get("hrv baseline")),
  };
}

function sleepHr(
  lines: string[],
): { avgHr: number | null; minHr: number | null; maxHr: number | null } {
  const line = lines.find((l) => /sleep hr\s*:/i.test(l)) ?? "";
  const grab = (k: string) =>
    num(line.match(new RegExp(`${k}\\s+(\\d+)`, "i"))?.[1]);
  return { avgHr: grab("avg"), minHr: grab("min"), maxHr: grab("max") };
}

/**
 * querySleepHrv: the assessment section only.
 *
 * The tool also returns a raw time series, one line per measurement — most of
 * its output by size. Parsing stops at that section's heading; the series is
 * not something a daily record needs, and storing thousands of points a week
 * as typed data would bury the numbers that matter.
 */
export function parseSleepHrv(text: string): Map<string, HrvAssessment> {
  const cut = text.search(/^Sleep HRV Time Series/m);
  const assessment = cut >= 0 ? text.slice(0, cut) : text;
  const out = new Map<string, HrvAssessment>();
  for (const [date, lines] of dateBlocks(assessment, ISO_LINE)) {
    if (!date) continue;
    const f = kv(lines);
    const avgRaw = f.get("hrv avg") ?? "";
    const status = avgRaw.split(/\s+[—-]\s+/)[1]?.trim() ?? null;
    const range = (f.get("normal range") ?? "").match(/(\d+)\s*-\s*(\d+)/);
    out.set(date, {
      avg: num(avgRaw),
      status,
      rangeLow: range ? Number(range[1]) : null,
      rangeHigh: range ? Number(range[2]) : null,
      baseline: num(f.get("baseline")),
    });
  }
  return out;
}

/** queryRestingHeartRate: "2026-10-24: 52 bpm" per line. */
export function parseRestingHr(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}):\s*(\d+)\s*bpm/);
    if (m) out.set(m[1], Number(m[2]));
  }
  return out;
}

/** queryStressLevel: average stress per day. */
export function parseStress(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [date, lines] of dateBlocks(text, ISO_LINE)) {
    if (!date) continue;
    const v = num(kv(lines).get("average stress"));
    if (v !== null) out.set(date, v);
  }
  return out;
}

/** queryTrainingLoadAssessment: short/long-term load and their ratio per day. */
export function parseTrainingLoad(text: string): Map<string, LoadAssessment> {
  const out = new Map<string, LoadAssessment>();
  for (const [date, lines] of dateBlocks(text, ISO_LINE)) {
    if (!date) continue;
    const f = kv(lines);
    out.set(date, {
      comment: f.get("comment") ?? null,
      shortTerm: num(f.get("short-term load")),
      longTerm: num(f.get("long-term load")),
      ratio: num(f.get("load ratio")),
    });
  }
  return out;
}

export function parseRecovery(text: string): Recovery {
  const f = kv(text.split(/\r?\n/));
  return {
    percent: num(f.get("recovery")),
    level: f.get("level") ?? null,
    fullRecoveryIn: f.get("estimated full recovery") ?? null,
  };
}

export function parseFitness(text: string): Fitness {
  const f = kv(text.split(/\r?\n/));
  const predictions: Record<string, string> = {};
  for (const [k, v] of f) {
    const m = k.match(/^(.+?)\s+prediction$/);
    if (m) predictions[m[1]] = v;
  }
  const pace = (f.get("threshold pace") ?? "").match(
    /(\d+:\d{2})\s*\/\s*(km|mi)/,
  );
  let threshold: number | null = null;
  if (pace) {
    const s = clockSeconds(pace[1]);
    threshold = s === null
      ? null
      : pace[2] === "mi"
      ? Math.round(s / 1.609344)
      : s;
  }
  return {
    vo2max: num(f.get("vo2max")),
    runningLevel: num(f.get("running level")),
    thresholdPaceSecPerKm: threshold,
    predictions,
  };
}

/**
 * The result of a create or schedule call: whether it worked and the ids the
 * text mentions.
 *
 * The server tells the model "never show idInPlan to the user", which is about
 * presentation. Storing it is the point: it is the only handle for updating
 * the workout later.
 */
export function parseCreateResult(text: string): {
  idInPlan: string | null;
  workoutId: string | null;
} {
  const id = (label: string) =>
    text.match(new RegExp(`${label}\\s*[:=]\\s*"?(\\d+)`, "i"))?.[1] ?? null;
  return { idInPlan: id("idInPlan"), workoutId: id("Workout ID") };
}
