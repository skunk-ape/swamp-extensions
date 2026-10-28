// A workout described the way a runner says it, turned into a COROS course.
//
// The official createScheduledWorkout tool takes a well-specified course: a
// list of sections with numeric sectionType, targetType, intensityType and
// integer values in seconds-per-kilometre, metres and seconds. It also comes
// with several pages of rules — which target types each sport allows, which
// intensity formats go with which metric, that interval groups cannot nest,
// that zero means "provided and invalid" rather than "unset".
//
// An agent can follow those rules, mostly. The failures are predictable: a
// mile pace written into a per-km field, a percentage of max HR in a field
// meaning percentage of LTHR, a time target on a trail run. So the agent writes
// the friendly form below, and this file applies the rules and the unit
// conversions in code. A course that reaches COROS has already passed the same
// checks COROS will run, and fails here with a message naming the step.

import { z } from "npm:zod@4";
import {
  distanceMetres,
  durationSeconds,
  formatClock,
  formatDistance,
  formatPace,
  paceRange,
  type UnitSystem,
} from "./units.ts";

const SPORT = { run: 1, bike: 2, trail: 5 } as const;
export type Sport = keyof typeof SPORT;

const SECTION_TYPE = { warmup: 1, work: 2, recover: 3, cooldown: 4 } as const;
const TARGET = { distance: 1, time: 2, climb: 3, open: 4 } as const;
const INTENSITY = { hr: 1, pace: 2, power: 4 } as const;

/** Which targets and metrics each sport accepts, from the tool's own rules. */
const ALLOWED: Record<Sport, { targets: number[]; intensities: number[] }> = {
  run: { targets: [1, 2, 4], intensities: [1, 2, 4] },
  bike: { targets: [1, 2, 4], intensities: [1, 4] },
  trail: { targets: [1, 3, 4], intensities: [1, 2, 4] },
};

const range2 = z.tuple([z.number().int(), z.number().int()]);

export const StepSchema = z.object({
  kind: z.enum(["warmup", "work", "recover", "cooldown"]).describe(
    "warmup, work, recover or cooldown. Inside a repeat only work and recover are allowed.",
  ),
  distance: z.string().optional().describe(
    'Distance target with a unit: "800m", "2mi", "5km".',
  ),
  time: z.string().optional().describe(
    'Time target: "90s", "10min", "10:00". Not allowed on trail runs, which COROS limits to distance and climb.',
  ),
  climb: z.string().optional().describe(
    'Climb target in metres, trail runs only: "30m".',
  ),
  open: z.boolean().optional().describe(
    "Open-ended: no target, the athlete ends the step with the lap button. Only when asked for explicitly.",
  ),
  pace: z.string().optional().describe(
    'Absolute pace, single or range, unit at the end: "7:10/mi", "7:20-7:00/mi", "4:30/km". A bare pace uses the instance\'s units.',
  ),
  paceZone: z.number().int().min(1).max(6).optional().describe(
    "Pace zone 1-6 from the athlete's COROS threshold pace.",
  ),
  pacePercent: range2.optional().describe(
    "Percent of COROS threshold pace as [start, end], 20-140, start < end.",
  ),
  hr: z.string().optional().describe(
    'Heart rate in bpm, single or range: "150", "140-150".',
  ),
  hrZone: z.number().int().min(1).max(6).optional().describe(
    "Heart-rate zone 1-6.",
  ),
  hrPercent: range2.optional().describe(
    "Percent of LTHR (lactate threshold HR — not max HR, not reserve) as [start, end], 20-120, start < end.",
  ),
  power: z.string().optional().describe(
    'Power in watts, single or range: "250", "240-260".',
  ),
  powerZone: z.number().int().min(1).max(7).optional().describe(
    "FTP power zone 1-7. Cycling only; running power takes watts.",
  ),
});
export type Step = z.infer<typeof StepSchema>;

export const RepeatSchema = z.object({
  repeat: z.number().int().min(1).max(20).describe("How many times, 1-20."),
  steps: z.array(StepSchema).min(1).describe(
    "The steps repeated, work and recover only. Repeats cannot nest: write 6x(400m + 2x200m) as a repeat of six with the 200s spelled out.",
  ),
});
export type Repeat = z.infer<typeof RepeatSchema>;

export const WorkoutSpecSchema = z.object({
  name: z.string().min(1).max(100).describe(
    "Shown in the COROS app as written. Plain coaching language.",
  ),
  description: z.string().optional().describe(
    "Shown in the COROS app as written. Generated from the steps when omitted.",
  ),
  sport: z.enum(["run", "trail", "bike"]).default("run"),
  steps: z.array(z.union([RepeatSchema, StepSchema])).min(1),
});
export type WorkoutSpec = z.input<typeof WorkoutSpecSchema>;

// deno-lint-ignore no-explicit-any
export type Section = Record<string, any>;
export type Course = {
  courseName: string;
  courseDescription: string;
  sportType: number;
  sections: Section[];
};

function intRange(s: string, what: string): [number, number] {
  const m = s.trim().match(/^(\d+)(?:\s*(?:-|–|to)\s*(\d+))?$/);
  if (!m) {
    throw new Error(`cannot read ${what} "${s}" — write "150" or "140-150"`);
  }
  const a = Number(m[1]);
  const b = m[2] !== undefined ? Number(m[2]) : a;
  return [Math.min(a, b), Math.max(a, b)];
}

function within(v: number, lo: number, hi: number, what: string) {
  if (v < lo || v > hi) throw new Error(`${what} ${v} is outside ${lo}-${hi}`);
}

function section(
  step: Step,
  sport: Sport,
  units: UnitSystem,
  where: string,
): Section {
  const fail = (msg: string): never => {
    throw new Error(`${where}: ${msg}`);
  };
  try {
    return buildSection(step, sport, units, fail);
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(msg.startsWith(where) ? msg : `${where}: ${msg}`);
  }
}

function buildSection(
  step: Step,
  sport: Sport,
  units: UnitSystem,
  fail: (m: string) => never,
): Section {
  const out: Section = { sectionType: SECTION_TYPE[step.kind] };
  const allowed = ALLOWED[sport];

  // Exactly one target. Coros reads a missing target as invalid, not as free
  // mode, so "open" has to be said.
  const targets = (["distance", "time", "climb", "open"] as const).filter((k) =>
    step[k] !== undefined && step[k] !== false
  );
  if (targets.length !== 1) {
    fail(
      targets.length === 0
        ? "give one target — distance, time, climb, or open: true"
        : `give one target, not ${targets.join(" and ")}`,
    );
  }
  const target = targets[0];
  if (!allowed.targets.includes(TARGET[target])) {
    fail(
      sport === "trail" && target === "time"
        ? "COROS does not allow time targets on trail runs — use distance or climb"
        : `${target} targets are not allowed for ${sport}`,
    );
  }
  out.targetType = TARGET[target];
  if (target === "distance") out.targetValue = distanceMetres(step.distance!);
  if (target === "time") out.targetValue = durationSeconds(step.time!);
  if (target === "climb") out.targetValue = distanceMetres(step.climb!);
  if (out.targetValue !== undefined && out.targetValue <= 0) {
    fail("target must be positive");
  }

  // At most one intensity. None at all is legal, but only as a deliberate
  // choice — the tool's rules say not to leave it unset to avoid choosing.
  const given = (
    [
      "pace",
      "paceZone",
      "pacePercent",
      "hr",
      "hrZone",
      "hrPercent",
      "power",
      "powerZone",
    ] as const
  ).filter((k) => step[k] !== undefined);
  if (given.length > 1) fail(`give one intensity, not ${given.join(" and ")}`);
  if (given.length === 0) return out;

  const key = given[0];
  const metric = key.startsWith("pace")
    ? "pace"
    : key.startsWith("hr")
    ? "hr"
    : "power";
  const type = INTENSITY[metric];
  if (!allowed.intensities.includes(type)) {
    fail(`${metric} targets are not allowed for ${sport}`);
  }
  out.intensityType = type;

  switch (key) {
    case "pace": {
      const [slow, fast] = paceRange(step.pace!, units);
      within(slow, 120, 1499, "pace (s/km)");
      within(fast, 120, 1499, "pace (s/km)");
      out.intensityValueStart = slow;
      out.intensityValueEnd = fast;
      break;
    }
    case "hr": {
      const [lo, hi] = intRange(step.hr!, "heart rate");
      within(lo, 30, 240, "heart rate");
      within(hi, 30, 240, "heart rate");
      out.intensityValueStart = lo;
      out.intensityValueEnd = hi;
      break;
    }
    case "power": {
      const [lo, hi] = intRange(step.power!, "power");
      within(lo, 10, 2000, "power (W)");
      within(hi, 10, 2000, "power (W)");
      out.intensityValueStart = lo;
      out.intensityValueEnd = hi;
      break;
    }
    case "paceZone":
    case "hrZone":
      out.sectionIntensity = step[key];
      break;
    case "powerZone":
      if (sport !== "bike") {
        fail("running power takes watts, not zones");
      }
      out.sectionIntensity = step.powerZone;
      break;
    case "pacePercent":
    case "hrPercent": {
      const [a, b] = step[key]!;
      const hi = key === "hrPercent" ? 120 : 140;
      if (!(a >= 20 && a < b && b <= hi)) {
        fail(`${key} must be [start, end] with 20 <= start < end <= ${hi}`);
      }
      out.intensityPercentStart = a;
      out.intensityPercentEnd = b;
      break;
    }
  }
  return out;
}

function isRepeat(x: Step | Repeat): x is Repeat {
  return (x as Repeat).repeat !== undefined;
}

/** Plain words for one step, for the description the athlete reads. */
function describeStep(step: Step, units: UnitSystem): string {
  const what = step.distance
    ? formatDistance(distanceMetres(step.distance), units)
    : step.time
    ? formatClock(durationSeconds(step.time))
    : step.climb
    ? `${distanceMetres(step.climb)} m climb`
    : "until ready";
  let how = "";
  if (step.pace) {
    const [slow, fast] = paceRange(step.pace, units);
    how = slow === fast
      ? ` at ${formatPace(slow, units)}`
      : ` at ${formatPace(slow, units).replace(/\/.*/, "")}-${
        formatPace(fast, units)
      }`;
  } else if (step.paceZone) how = ` in pace zone ${step.paceZone}`;
  else if (step.pacePercent) {
    how = ` at ${step.pacePercent.join("-")}% of threshold pace`;
  } else if (step.hr) how = ` at ${step.hr} bpm`;
  else if (step.hrZone) how = ` in heart-rate zone ${step.hrZone}`;
  else if (step.hrPercent) how = ` at ${step.hrPercent.join("-")}% of LTHR`;
  else if (step.power) how = ` at ${step.power} W`;
  else if (step.powerZone) how = ` in power zone ${step.powerZone}`;
  const verb = {
    warmup: "Warm up",
    work: "",
    recover: "recover",
    cooldown: "Cool down",
  }[step.kind];
  return [verb, what + how].filter(Boolean).join(" ").trim();
}

export function describe(spec: WorkoutSpec, units: UnitSystem): string {
  const parsed = WorkoutSpecSchema.parse(spec);
  const parts = parsed.steps.map((s) =>
    isRepeat(s)
      ? `${s.repeat} x (${
        s.steps.map((x) => describeStep(x, units)).join(", ")
      })`
      : describeStep(s, units)
  );
  return parts.join("; ") + ".";
}

/**
 * The course COROS expects, or an error naming the step that would fail.
 *
 * Validation happens before any network call, so a dry run catches everything
 * this file knows about. COROS validates again on its side; the two should
 * agree, and where they do not, COROS's answer is stored with the attempt.
 */
export function toCourse(spec: WorkoutSpec, units: UnitSystem): Course {
  const parsed = WorkoutSpecSchema.parse(spec);
  const sport = parsed.sport;
  const sections: Section[] = parsed.steps.map((s, i) => {
    const where = `step ${i + 1}`;
    if (!isRepeat(s)) return section(s, sport, units, where);
    const sets = s.steps.map((x, j) => {
      if (x.kind !== "work" && x.kind !== "recover") {
        throw new Error(
          `${where}.${
            j + 1
          }: inside a repeat only work and recover are allowed, not ${x.kind}`,
        );
      }
      return section(x, sport, units, `${where}.${j + 1}`);
    });
    // The container carries no target or intensity of its own; COROS rejects
    // one that does.
    return { intervalGroup: true, repeats: s.repeat, sets };
  });
  return {
    courseName: parsed.name,
    courseDescription: parsed.description?.trim() || describe(parsed, units),
    sportType: SPORT[sport],
    sections,
  };
}
