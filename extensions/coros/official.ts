/**
 * @skunk-ape/coros/official — COROS's official MCP server, called as an API.
 *
 * The server at mcpus.coros.com is an MCP endpoint, but nothing about using it
 * requires an MCP host: it is stateless JSON-RPC over HTTPS behind standard
 * OAuth. This behavior registers its own OAuth client, signs in once in a
 * browser, refreshes on its own, and turns the server's prose answers into
 * typed swamp data.
 *
 * It is the only source of sleep this extension has. The Training Hub API
 * (`@skunk-ape/coros/hub`) can reach sleep only through COROS's mobile login,
 * which signs the account owner out of the app on their phone.
 */
import { z } from "npm:zod@4";
import { callTool, McpAuthError, type ToolResult } from "./_lib/mcp.ts";
import {
  authorizationUrl,
  DEFAULT_SCOPE,
  discover,
  exchangeCode,
  needsRefresh,
  pkce,
  refresh,
  register,
  type TokenSet,
  waitForCallback,
} from "./_lib/oauth.ts";
import {
  type DailyActivity,
  type HrvAssessment,
  type LoadAssessment,
  parseCreateResult,
  parseDailyHealth,
  parseFitness,
  parseRecovery,
  parseRestingHr,
  parseSleepHrv,
  parseSleepOverview,
  parseStress,
  parseTrainingLoad,
  type SleepOverview,
  type SleepStages,
} from "./_lib/parse.ts";
import { corosDate } from "./_lib/units.ts";
import { RepeatSchema, StepSchema, toCourse } from "./_lib/workout.ts";

// deno-lint-ignore no-explicit-any
type Ctx = any;

const GlobalArgsSchema = z.object({
  mcpUrl: z.string().default("https://mcpus.coros.com/mcp").describe(
    "The official COROS MCP endpoint. mcpus is the US server; the account's region decides which one holds its data.",
  ),
  callbackPort: z.number().int().default(27891).describe(
    "Loopback port the browser returns to during `authorize`. Registered with COROS as part of the redirect URI, so changing it later means authorizing again.",
  ),
  clientName: z.string().default("swamp @skunk-ape/coros").describe(
    "Name this client registers under. COROS may show it on the consent page.",
  ),
  units: z.enum(["imperial", "metric"]).default("imperial").describe(
    'How bare paces and generated workout descriptions are read and written. "7:10" means per mile under imperial and per km under metric.',
  ),
  timezone: z.string().default("").describe(
    "IANA timezone for working out today's date, e.g. America/Chicago. Empty uses the host's.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// --- resources -------------------------------------------------------------

const TokenSchema = z.object({
  issuer: z.string(),
  tokenEndpoint: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  scope: z.string(),
  accessToken: z.string().meta({ sensitive: true }),
  refreshToken: z.string().meta({ sensitive: true }),
  expiresAt: z.string(),
  obtainedAt: z.string(),
});
type TokenData = z.infer<typeof TokenSchema>;

const nul = <T extends z.ZodType>(t: T) => t.nullable();
const numN = z.number().nullable();
const strN = z.string().nullable();

const DaySchema = z.object({
  date: z.string().describe(
    "Wake-up day, YYYY-MM-DD. A night's sleep belongs to the morning it ended.",
  ),
  sleep: nul(z.object({
    score: numN,
    dailyMinutes: numN,
    mainAsleepMinutes: numN,
    mainPeriodMinutes: numN,
    deepPct: numN,
    lightPct: numN,
    remPct: numN,
    awakePct: numN,
    awakeMinutes: numN,
    awakeCount: numN,
    mainStart: strN,
    mainEnd: strN,
    napMinutes: numN,
  })),
  stages: nul(z.object({
    totalMinutes: numN,
    deepMinutes: numN,
    lightMinutes: numN,
    remMinutes: numN,
    awakeMinutes: numN,
    avgHr: numN,
    minHr: numN,
    maxHr: numN,
  })),
  hrv: nul(z.object({
    avg: numN,
    status: strN,
    rangeLow: numN,
    rangeHigh: numN,
    baseline: numN,
  })),
  restingHr: numN,
  activity: nul(z.object({
    steps: numN,
    calories: numN,
    exerciseMinutes: numN,
    stressAvg: numN,
  })),
  stressAvg: numN,
  load: nul(z.object({
    comment: strN,
    shortTerm: numN,
    longTerm: numN,
    ratio: numN,
  })),
  fetchedAt: z.string(),
});
/** One wake-up day as stored in a `day-YYYY-MM-DD` record. */
export type Day = z.infer<typeof DaySchema>;

const SnapshotSchema = z.object({
  asOf: z.string(),
  today: z.string(),
  recovery: nul(z.object({ percent: numN, level: strN, fullRecoveryIn: strN })),
  fitness: nul(z.object({
    vo2max: numN,
    runningLevel: numN,
    thresholdPaceSecPerKm: numN,
    predictions: z.record(z.string(), z.string()),
  })),
  restingHr: numN,
  hrvBaseline: numN.describe(
    "From the daily-health header. Not the same figure as the sleep-HRV baseline on each day: COROS reports two different baselines.",
  ),
  schedule: z.string().describe(
    "Upcoming scheduled workouts, as COROS describes them.",
  ),
  days: z.array(z.string()),
  errors: z.array(z.object({ tool: z.string(), error: z.string() })),
});

const RawSchema = z.object({
  fetchedAt: z.string(),
  results: z.array(z.object({
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    text: z.string(),
    isError: z.boolean(),
  })),
});

const QuerySchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  text: z.string(),
  json: z.unknown().nullable(),
  isError: z.boolean(),
  fetchedAt: z.string(),
});

const WorkoutSchema = z.object({
  ok: z.boolean(),
  dryRun: z.boolean(),
  placement: z.enum(["schedule", "library"]),
  date: strN,
  name: z.string(),
  course: z.record(z.string(), z.unknown()),
  response: z.string(),
  idInPlan: strN,
  workoutId: strN,
  at: z.string(),
});

// --- auth ------------------------------------------------------------------

/**
 * A caller that holds a fresh token and refreshes at most once per run.
 *
 * `recent` makes its calls in parallel, so a 401 can arrive on several at once.
 * The refresh is shared through one promise; without that, each call would
 * refresh separately, and on a server that rotates refresh tokens every one
 * after the first would present a token the first had just spent.
 */
async function connect(ctx: Ctx) {
  const g = ctx.globalArgs as GlobalArgs;
  let tok = await ctx.readResource("token") as TokenData | null;
  if (!tok?.refreshToken) {
    throw new Error(
      "not authorized — run the `authorize` method once on a machine with a browser",
    );
  }
  let refreshing: Promise<void> | null = null;
  const doRefresh = () =>
    refreshing ??= (async () => {
      ctx.logger.info("Refreshing the COROS access token");
      const fresh = await refresh(
        { token_endpoint: tok!.tokenEndpoint },
        { clientId: tok!.clientId, refreshToken: tok!.refreshToken },
      );
      tok = { ...tok!, ...fresh, obtainedAt: new Date().toISOString() };
      await ctx.writeResource("token", "token", tok);
    })();

  if (needsRefresh(tok.expiresAt)) await doRefresh();

  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    try {
      return await callTool({
        url: g.mcpUrl,
        token: tok!.accessToken,
        name,
        args,
        signal: ctx.signal,
      });
    } catch (e) {
      if (!(e instanceof McpAuthError)) throw e;
      await doRefresh();
      return await callTool({
        url: g.mcpUrl,
        token: tok!.accessToken,
        name,
        args,
        signal: ctx.signal,
      });
    }
  };
  return { call, token: () => tok! };
}

function today(tz: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", tz ? { timeZone: tz } : undefined);
}

// Read-only tools exposed through `query`, from the server's own
// readOnlyHint annotations. Everything that writes goes through a named method
// with its own checks, so `query` cannot become a back door to them.
const READ_TOOLS = [
  "queryActivityLapData",
  "queryCustomActivityLapData",
  "getActivityDetail",
  "analyzeActivityDetail",
  "queryDailyHealthData",
  "querySleepOverview",
  "queryDevices",
  "queryFitnessAssessmentOverview",
  "queryTrainingLoadAssessment",
  "queryRecoveryStatus",
  "querySportRecords",
  "queryAvgHeartRate",
  "queryRestingHeartRate",
  "querySleepHrv",
  "queryStressLevel",
  "queryHealthCheckTimeSeries",
  "queryStressTimeSeries",
  "queryScheduledWorkoutDetails",
  "queryTrainingPlanDetails",
  "queryTrainingPlanLibrary",
  "queryTrainingSchedule",
  "queryWorkoutDetails",
  "queryWorkoutLibrary",
  "queryUserInfo",
] as const;

/** Merge what each tool said about each day into one record per day. */
export function mergeDays(
  parts: {
    sleep: Map<string, SleepOverview>;
    health: Map<string, { activity: DailyActivity; stages: SleepStages }>;
    hrv: Map<string, HrvAssessment>;
    rhr: Map<string, number>;
    stress: Map<string, number>;
    load: Map<string, LoadAssessment>;
  },
  fetchedAt: string,
): Day[] {
  const dates = new Set<string>();
  for (const m of Object.values(parts)) for (const k of m.keys()) dates.add(k);
  return [...dates].sort().map((date) => ({
    date,
    sleep: parts.sleep.get(date) ?? null,
    stages: parts.health.get(date)?.stages ?? null,
    hrv: parts.hrv.get(date) ?? null,
    restingHr: parts.rhr.get(date) ?? null,
    activity: parts.health.get(date)?.activity ?? null,
    stressAvg: parts.stress.get(date) ??
      parts.health.get(date)?.activity.stressAvg ?? null,
    load: parts.load.get(date) ?? null,
    fetchedAt,
  }));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 40) || "workout";
}

// --- model -----------------------------------------------------------------

/** The `@skunk-ape/coros/official` behavior type. */
export const behavior = {
  type: "@skunk-ape/coros/official",
  version: "2026.10.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    token: {
      description:
        "OAuth client and tokens for the official server. The tokens are stored in a vault, never in data.",
      schema: TokenSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    day: {
      description:
        "Everything COROS reported about one wake-up day: sleep, stages, HRV, resting HR, stress, steps and training load. One instance per date, named day-YYYY-MM-DD.",
      schema: DaySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    snapshot: {
      description:
        "Point-in-time state from the last `recent` run: recovery, fitness, upcoming schedule, and any tool that failed.",
      schema: SnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    raw: {
      description:
        "The server's own text from the last `recent` run, kept so a parse that missed something can be checked against what was said.",
      schema: RawSchema,
      lifetime: "14d",
      garbageCollection: 10,
    },
    query: {
      description:
        "One read-only tool call's text, for questions `recent` does not cover.",
      schema: QuerySchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
    workout: {
      description:
        "A workout this behavior created, or a dry run of one: the course sent, COROS's answer, and the ids needed to change it later.",
      schema: WorkoutSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    authorize: {
      description:
        "Sign in to COROS once, in a browser on this machine. Registers this instance's own OAuth client if it has none, prints a URL, waits for the redirect to the loopback port, and stores the tokens in a vault. Run it again only if refreshing ever fails.",
      arguments: z.object({
        timeoutSeconds: z.number().int().default(300).describe(
          "How long to wait for the browser.",
        ),
        openBrowser: z.boolean().default(true).describe(
          "Try to open the URL with xdg-open or open.",
        ),
      }),
      execute: async (
        args: { timeoutSeconds: number; openBrowser: boolean },
        ctx: Ctx,
      ) => {
        const g = ctx.globalArgs as GlobalArgs;
        const redirectUri = `http://127.0.0.1:${g.callbackPort}/callback`;
        const meta = await discover(g.mcpUrl);

        // Reuse a registration made for the same redirect, so re-authorizing
        // does not leave a trail of orphaned clients at COROS.
        const prior = await ctx.readResource("token").catch(() => null) as
          | TokenData
          | null;
        const clientId = prior?.clientId && prior.redirectUri === redirectUri &&
            prior.issuer === meta.issuer
          ? prior.clientId
          : await register(meta, {
            clientName: g.clientName,
            redirectUri,
            scope: DEFAULT_SCOPE,
          });

        const { verifier, challenge } = await pkce();
        const state = crypto.randomUUID();
        const url = authorizationUrl(meta, {
          clientId,
          redirectUri,
          scope: DEFAULT_SCOPE,
          state,
          challenge,
          resource: g.mcpUrl,
        });

        const waiting = waitForCallback({
          port: g.callbackPort,
          state,
          timeoutMs: args.timeoutSeconds * 1000,
          signal: ctx.signal,
        });
        ctx.logger.warning("Open this URL to sign in to COROS:\n\n  {url}\n", {
          url,
        });
        if (args.openBrowser) {
          try {
            // deno-lint-ignore no-explicit-any
            const D = (globalThis as any).Deno;
            const opener = D.build.os === "darwin" ? "open" : "xdg-open";
            const child = new D.Command(opener, {
              args: [url],
              stdout: "null",
              stderr: "null",
            }).spawn();
            child.status.catch(() => {});
          } catch {
            // No opener on this host. The URL is in the log.
          }
        }

        const code = await waiting;
        const tokens: TokenSet = await exchangeCode(meta, {
          clientId,
          code,
          redirectUri,
          verifier,
        });
        const handle = await ctx.writeResource("token", "token", {
          issuer: meta.issuer,
          tokenEndpoint: meta.token_endpoint,
          clientId,
          redirectUri,
          scope: tokens.scope || DEFAULT_SCOPE,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          obtainedAt: new Date().toISOString(),
        });
        ctx.logger.info("Authorized. Access token valid until {exp}", {
          exp: tokens.expiresAt,
        });
        return { dataHandles: [handle] };
      },
    },

    recent: {
      description:
        "Fetch the last N days of sleep, stages, HRV, resting HR, stress, steps and training load, plus current recovery, fitness and the coming week's schedule. Writes one `day-YYYY-MM-DD` record per date and a `snapshot`. One method, one token refresh: the calls run in parallel inside it rather than as separate steps contending for the instance.",
      arguments: z.object({
        days: z.number().int().min(1).max(30).default(7),
        aheadDays: z.number().int().min(0).max(30).default(7).describe(
          "How far ahead to read the training schedule.",
        ),
      }),
      execute: async (args: { days: number; aheadDays: number }, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;
        const { call } = await connect(ctx);
        const d = args.days;
        const plan: Array<[string, Record<string, unknown>]> = [
          ["querySleepOverview", { days: d }],
          ["queryDailyHealthData", { days: d }],
          ["querySleepHrv", { days: d }],
          ["queryRestingHeartRate", { days: d }],
          ["queryStressLevel", { days: d }],
          ["queryTrainingLoadAssessment", { days: d }],
          ["queryRecoveryStatus", {}],
          ["queryFitnessAssessmentOverview", {}],
          ["queryTrainingSchedule", {
            startDate: corosDate(today(g.timezone)),
            endDate: corosDate(today(g.timezone, args.aheadDays)),
          }],
        ];
        const settled = await Promise.allSettled(
          plan.map(([n, a]) => call(n, a)),
        );

        const errors: Array<{ tool: string; error: string }> = [];
        const text = new Map<string, string>();
        const raw = [];
        for (const [i, s] of settled.entries()) {
          const [tool, a] = plan[i];
          if (s.status === "rejected") {
            errors.push({ tool, error: String(s.reason?.message ?? s.reason) });
            continue;
          }
          raw.push({
            tool,
            args: a,
            text: s.value.text,
            isError: s.value.isError,
          });
          if (s.value.isError) {
            errors.push({ tool, error: s.value.text.slice(0, 500) });
          } else text.set(tool, s.value.text);
        }
        if (text.size === 0) {
          throw new Error(
            `every COROS call failed: ${
              errors.map((e) => `${e.tool}: ${e.error}`).join("; ")
            }`,
          );
        }
        for (const e of errors) ctx.logger.warning("{tool} failed: {error}", e);

        const t = (k: string) => text.get(k) ?? "";
        const health = parseDailyHealth(t("queryDailyHealthData"));
        const fetchedAt = new Date().toISOString();
        const days = mergeDays({
          sleep: parseSleepOverview(t("querySleepOverview")),
          health: health.days,
          hrv: parseSleepHrv(t("querySleepHrv")),
          rhr: parseRestingHr(t("queryRestingHeartRate")),
          stress: parseStress(t("queryStressLevel")),
          load: parseTrainingLoad(t("queryTrainingLoadAssessment")),
        }, fetchedAt);

        const handles = [];
        for (const day of days) {
          handles.push(await ctx.writeResource("day", `day-${day.date}`, day));
        }
        handles.push(
          await ctx.writeResource("snapshot", "current", {
            asOf: fetchedAt,
            today: today(g.timezone),
            recovery: text.has("queryRecoveryStatus")
              ? parseRecovery(t("queryRecoveryStatus"))
              : null,
            fitness: text.has("queryFitnessAssessmentOverview")
              ? parseFitness(t("queryFitnessAssessmentOverview"))
              : null,
            restingHr: health.restingHr,
            hrvBaseline: health.hrvBaseline,
            schedule: t("queryTrainingSchedule").trim(),
            days: days.map((x) => x.date),
            errors,
          }),
        );
        handles.push(
          await ctx.writeResource("raw", "recent", { fetchedAt, results: raw }),
        );
        ctx.logger.info("{n} day(s) from COROS, {e} tool(s) failed", {
          n: days.length,
          e: errors.length,
        });
        return { dataHandles: handles };
      },
    },

    query: {
      description:
        "Call one read-only tool on the official server and keep its text. For questions `recent` does not answer: lap data, one activity's detail, the workout library, a training plan. Write tools are not reachable this way.",
      arguments: z.object({
        tool: z.enum(READ_TOOLS),
        args: z.record(z.string(), z.unknown()).default({}).describe(
          "The tool's own arguments, as its schema names them.",
        ),
      }),
      execute: async (
        args: { tool: string; args: Record<string, unknown> },
        ctx: Ctx,
      ) => {
        const { call } = await connect(ctx);
        const r = await call(args.tool, args.args);
        const handle = await ctx.writeResource("query", args.tool, {
          tool: args.tool,
          args: args.args,
          text: r.text,
          json: r.json ?? null,
          isError: r.isError,
          fetchedAt: new Date().toISOString(),
        });
        if (r.isError) throw new Error(`${args.tool}: ${r.text.slice(0, 500)}`);
        return { dataHandles: [handle] };
      },
    },

    createWorkout: {
      description:
        'Create a run, trail run or ride from a plain description of its steps. Paces like "7:10/mi", distances like "800m" and times like "90s" are converted to COROS\'s units here, and every rule COROS enforces is checked before anything is sent. With a date it goes on the training calendar; without one it is saved to the workout library. dryRun shows the converted course and sends nothing.',
      arguments: z.object({
        name: z.string().min(1).max(100).describe(
          "Shown in the COROS app as written.",
        ),
        description: z.string().optional().describe(
          "Shown in the COROS app as written. Generated from the steps when omitted.",
        ),
        sport: z.enum(["run", "trail", "bike"]).default("run"),
        steps: z.array(z.union([RepeatSchema, StepSchema])).min(1).describe(
          'Steps in order. A step: {kind: warmup|work|recover|cooldown, one target (distance | time | climb | open), at most one intensity (pace | paceZone | pacePercent | hr | hrZone | hrPercent | power | powerZone)}. A repeat: {repeat: n, steps: [...]} with work/recover steps only, no nesting. Example: [{kind:"warmup",distance:"1.5mi",hrZone:2},{repeat:6,steps:[{kind:"work",distance:"800m",pace:"6:50/mi"},{kind:"recover",distance:"400m",hrZone:1}]},{kind:"cooldown",distance:"1mi",hrZone:1}]',
        ),
        date: z.string().optional().describe(
          "YYYY-MM-DD, today through 90 days out. Omit to save to the library instead.",
        ),
        dryRun: z.boolean().default(false),
      }),
      execute: async (
        // deno-lint-ignore no-explicit-any
        args: any,
        ctx: Ctx,
      ) => {
        const g = ctx.globalArgs as GlobalArgs;
        const course = toCourse(
          {
            name: args.name,
            description: args.description,
            sport: args.sport,
            steps: args.steps,
          },
          g.units,
        );
        const placement = args.date ? "schedule" : "library";
        const date = args.date ? corosDate(args.date) : null;
        const instance = `workout-${args.date ?? "library"}-${slug(args.name)}`;
        const record = {
          dryRun: args.dryRun,
          placement,
          date: args.date ?? null,
          name: args.name,
          course,
          at: new Date().toISOString(),
        };

        if (args.dryRun) {
          ctx.logger.info("Dry run — nothing sent. {desc}", {
            desc: course.courseDescription,
          });
          const handle = await ctx.writeResource("workout", instance, {
            ...record,
            ok: true,
            response: "",
            idInPlan: null,
            workoutId: null,
          });
          return { dataHandles: [handle] };
        }

        const { call } = await connect(ctx);
        const r = placement === "schedule"
          ? await call("createScheduledWorkout", { date, course })
          : await call("createSingleWorkout", { course });
        const ids = parseCreateResult(r.text);
        const handle = await ctx.writeResource("workout", instance, {
          ...record,
          ok: !r.isError,
          response: r.text,
          ...ids,
        });
        // Written before throwing on purpose: a rejected course and COROS's
        // reason for rejecting it are the record most worth keeping.
        if (r.isError) {
          throw new Error(
            `COROS rejected the workout: ${r.text.slice(0, 800)}`,
          );
        }
        ctx.logger.info("{name} created ({where})", {
          name: args.name,
          where: args.date ?? "library",
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
