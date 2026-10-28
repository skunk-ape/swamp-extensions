/**
 * @skunk-ape/coros/hub — the COROS Training Hub web API, for what the official
 * server will not give as data.
 *
 * Activities and daily metrics come back from Training Hub as JSON, with the
 * training-load and threshold fields the official server summarises into
 * prose. It is also the only way to take a workout off the calendar: the
 * official server can create and update scheduled workouts but not remove
 * them.
 *
 * Unofficial and reverse-engineered, with an email and password rather than
 * OAuth. Prefer `@skunk-ape/coros/official` wherever it covers the need, and
 * expect this to break when COROS changes its web app.
 *
 * No sleep, and no mobile API, by design: a mobile login signs the account
 * owner out of the COROS app on their phone.
 */
import { z } from "npm:zod@4";
import {
  type DailyMetrics,
  findScheduled,
  Hub,
  HubError,
  type HubSession,
  login,
} from "./_lib/hub.ts";
import { corosDate } from "./_lib/units.ts";

// deno-lint-ignore no-explicit-any
type Ctx = any;

const GlobalArgsSchema = z.object({
  email: z.string().describe("COROS account email. Source it from a vault."),
  password: z.string().meta({ sensitive: true }).describe(
    "COROS account password. Source it from a vault; it is sent only to COROS, MD5-hashed, which is how Training Hub takes it.",
  ),
  region: z.enum(["us", "eu", "asia"]).default("us").describe(
    'The account\'s home region. COROS accepts a login on any region and then rejects every call with "Access token is invalid" on the wrong one, which reads like an expired token rather than a misconfiguration.',
  ),
  timezone: z.string().default("").describe(
    "IANA timezone for working out today's date. Empty uses the host's.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const SessionSchema = z.object({
  accessToken: z.string().meta({ sensitive: true }),
  userId: z.string(),
  region: z.string(),
  obtainedAt: z.string(),
});
type SessionData = z.infer<typeof SessionSchema>;

const numN = z.number().nullable();

const MetricsSchema = z.object({
  date: z.string(),
  hrv: numN.describe("Nightly average sleep HRV (RMSSD), ms."),
  hrvBaseline: numN,
  restingHr: numN,
  trainingLoad: numN.describe("That day's training load."),
  trainingLoadRatio: numN.describe("Acute:chronic load ratio."),
  fatigue: numN,
  acuteLoad: numN,
  chronicLoad: numN,
  distanceMetres: numN,
  durationSeconds: numN,
  vo2max: numN.describe("Only filled for roughly the last 28 days."),
  lthr: numN,
  thresholdPaceSecPerKm: numN,
  stamina: numN,
  stamina7d: numN,
  fetchedAt: z.string(),
});

const ActivitySchema = z.object({
  labelId: z.string(),
  name: z.string(),
  sportType: z.number(),
  sport: z.string(),
  startTime: z.string().nullable(),
  durationSeconds: numN,
  distanceMetres: numN,
  avgHr: numN,
  maxHr: numN,
  calories: numN,
  trainingLoad: numN,
  avgPower: numN,
  ascentMetres: numN,
  fetchedAt: z.string(),
});

const DetailSchema = z.object({
  labelId: z.string(),
  sportType: z.number(),
  detail: z.record(z.string(), z.unknown()),
  fetchedAt: z.string(),
});

const RemovedSchema = z.object({
  date: z.string(),
  idInPlan: z.string(),
  name: z.string(),
  dryRun: z.boolean(),
  at: z.string(),
});

// --- session ---------------------------------------------------------------

// Training Hub tokens last about 24 hours. Reusing one for most of that saves
// a login per run; logging in on every run would work, but each login is a
// password sent over the wire that did not need to be.
const SESSION_REUSE_MS = 20 * 3600 * 1000;

async function connect(ctx: Ctx): Promise<Hub> {
  const g = ctx.globalArgs as GlobalArgs;
  const cached = await ctx.readResource("session").catch(() => null) as
    | SessionData
    | null;
  const fresh = async (): Promise<HubSession> => {
    ctx.logger.info("Logging in to Training Hub ({region})", {
      region: g.region,
    });
    const s = await login({
      email: g.email,
      password: g.password,
      region: g.region,
    });
    const hub = new Hub(s);
    try {
      await hub.validate();
    } catch (e) {
      if (e instanceof HubError && e.auth) {
        throw new Error(
          `login succeeded but the token is refused on the ${g.region} host — the account is probably in a different region`,
        );
      }
      throw e;
    }
    await ctx.writeResource("session", "session", {
      ...s,
      obtainedAt: new Date().toISOString(),
    });
    return s;
  };

  const usable = cached?.accessToken && cached.region === g.region &&
    Date.now() - Date.parse(cached.obtainedAt) < SESSION_REUSE_MS;
  if (!usable) return new Hub(await fresh());

  // A cached token can still have been revoked. Find out with one cheap call
  // rather than on the first real one.
  const hub = new Hub({
    accessToken: cached!.accessToken,
    userId: cached!.userId,
    region: cached!.region,
  });
  try {
    await hub.validate();
    return hub;
  } catch (e) {
    if (e instanceof HubError && e.auth) return new Hub(await fresh());
    throw e;
  }
}

function today(tz: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", tz ? { timeZone: tz } : undefined);
}

// --- model -----------------------------------------------------------------

/** The `@skunk-ape/coros/hub` behavior type. */
export const behavior = {
  type: "@skunk-ape/coros/hub",
  version: "2026.10.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    session: {
      description: "The current Training Hub token. Stored in a vault.",
      schema: SessionSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    metrics: {
      description:
        "Training Hub's daily metrics for one date: HRV, resting HR, training load and ratio, fatigue, and (for the last ~28 days) VO2max, LTHR and threshold pace. One instance per date, named metrics-YYYY-MM-DD.",
      schema: MetricsSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    activity: {
      description: "One activity's summary, named activity-<labelId>.",
      schema: ActivitySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    detail: {
      description:
        "One activity's laps, zones and summary, with the per-second series dropped.",
      schema: DetailSchema,
      lifetime: "90d",
      garbageCollection: 5,
    },
    removed: {
      description:
        "A scheduled workout this behavior removed, or would have in a dry run.",
      schema: RemovedSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    recent: {
      description:
        "Fetch the last N days of daily metrics and activities. Writes one `metrics-YYYY-MM-DD` per date and one `activity-<labelId>` per activity.",
      arguments: z.object({
        days: z.number().int().min(1).max(180).default(7),
      }),
      execute: async (args: { days: number }, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;
        const hub = await connect(ctx);
        const start = today(g.timezone, -(args.days - 1));
        const end = today(g.timezone);
        const [metrics, activities] = await Promise.all([
          hub.dailyMetrics(start, end),
          hub.activities(start, end),
        ]);
        const fetchedAt = new Date().toISOString();
        const handles = [];
        // dayDetail answers with whole weeks around the range asked for. Days
        // outside it are real data, but writing them would make "the last 7
        // days" mean whatever COROS felt like returning.
        const inRange = (metrics as DailyMetrics[]).filter((m) =>
          m.date >= start && m.date <= end
        );
        for (const m of inRange) {
          handles.push(
            await ctx.writeResource("metrics", `metrics-${m.date}`, {
              ...m,
              fetchedAt,
            }),
          );
        }
        for (const a of activities) {
          handles.push(
            await ctx.writeResource("activity", `activity-${a.labelId}`, {
              ...a,
              fetchedAt,
            }),
          );
        }
        ctx.logger.info(
          "{m} day(s) of metrics and {a} activit(ies) from Training Hub",
          {
            m: inRange.length,
            a: activities.length,
          },
        );
        return { dataHandles: handles };
      },
    },

    activity: {
      description:
        "Fetch one activity's laps, heart-rate and pace zones, and summary. sportType must match the activity — take both from an `activity-<labelId>` record.",
      arguments: z.object({
        labelId: z.string(),
        sportType: z.number().int(),
      }),
      execute: async (
        args: { labelId: string; sportType: number },
        ctx: Ctx,
      ) => {
        const hub = await connect(ctx);
        const detail = await hub.activityDetail(args.labelId, args.sportType);
        const handle = await ctx.writeResource(
          "detail",
          `detail-${args.labelId}`,
          {
            labelId: args.labelId,
            sportType: args.sportType,
            detail,
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    removeScheduledWorkout: {
      description:
        "Take one workout off the training calendar. The official server cannot do this. Matches by idInPlan (from an official `workout` record) or by exact name on that date, and refuses if the match is not exactly one entry. Removes only the calendar entry; a library workout it came from is untouched.",
      arguments: z.object({
        date: z.string().describe("YYYY-MM-DD."),
        idInPlan: z.string().optional(),
        name: z.string().optional(),
        dryRun: z.boolean().default(false),
      }),
      execute: async (
        args: {
          date: string;
          idInPlan?: string;
          name?: string;
          dryRun: boolean;
        },
        ctx: Ctx,
      ) => {
        if (!args.idInPlan && !args.name) {
          throw new Error(
            "give idInPlan or name — removing whatever is on a date is not offered",
          );
        }
        const hub = await connect(ctx);
        const schedule = await hub.schedule(args.date, args.date);
        const day = corosDate(args.date);
        const matches = findScheduled(schedule, args).filter((
          e: { happenDay: string },
        ) => e.happenDay === day);
        if (matches.length !== 1) {
          throw new Error(
            matches.length === 0
              ? `nothing on ${args.date} matches ${
                args.idInPlan ?? `"${args.name}"`
              }`
              : `${matches.length} entries on ${args.date} match "${args.name}" — use idInPlan`,
          );
        }
        const m = matches[0];
        if (!args.dryRun) await hub.removeScheduled(m);
        ctx.logger.info("{verb} {name} on {date}", {
          verb: args.dryRun ? "Would remove" : "Removed",
          name: m.name,
          date: args.date,
        });
        const handle = await ctx.writeResource(
          "removed",
          `removed-${args.date}-${m.idInPlan}`,
          {
            date: args.date,
            idInPlan: m.idInPlan,
            name: m.name,
            dryRun: args.dryRun,
            at: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
