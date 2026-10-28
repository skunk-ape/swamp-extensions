// The COROS Training Hub web API — unofficial, reverse-engineered, and the only
// source of some things the official server will not give.
//
// What it is for here: activities and daily metrics as JSON rather than prose
// (the official server's text has to be parsed; this does not), the
// training-load and threshold fields the official server summarises away, and
// removing a scheduled workout, which the official server does not support.
//
// What it is not for: sleep. Sleep lives on COROS's mobile API, and logging in
// there signs the account owner out of the COROS app on their phone. That is
// not an acceptable side effect of reading last night's sleep, so this file
// has no mobile code at all. Sleep comes from the official server.
//
// Ported from ~/src/coros-mcp (coros_api.py). The gotchas below were each
// found the hard way there, and the comments say where.

import { createHash } from "node:crypto";
import type { FetchLike } from "./mcp.ts";
import { corosDate, isoDate } from "./units.ts";

export const HUB_BASE: Record<string, string> = {
  eu: "https://teameuapi.coros.com",
  us: "https://teamapi.coros.com",
  asia: "https://teamcnapi.coros.com",
};

// Training Hub serves browsers. A non-browser User-Agent has not been tested
// and there is no reason to find out on a production account.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

/** A Training Hub response body: loosely shaped, read defensively. */
// deno-lint-ignore no-explicit-any
export type Json = any;

export type HubSession = {
  accessToken: string;
  userId: string;
  region: string;
};

/** COROS answered with a non-success result. `code` is its result code. */
export class HubError extends Error {
  constructor(message: string, public code: string, public auth = false) {
    super(message);
  }
}

/** Unsalted MD5 hex of the password, which is what the login endpoint takes. */
export function md5hex(s: string): string {
  // WebCrypto has no MD5; node:crypto, which Deno ships, does.
  return createHash("md5").update(s, "utf8").digest("hex");
}

// deno-lint-ignore no-explicit-any
function check(body: any, what: string, status: number): any {
  if (status === 401 || status === 403) {
    throw new HubError(`${what}: HTTP ${status}`, String(status), true);
  }
  if (!body || body.result !== "0000") {
    const msg = body?.message ?? `HTTP ${status}`;
    // "Access token is invalid" is how a token sent to the wrong regional host
    // reads, as well as how an expired one reads. Both mean "log in again",
    // and the region hint is in the instance's region argument.
    const auth = /token/i.test(String(msg)) || body?.result === "1019";
    throw new HubError(`${what}: ${msg}`, String(body?.result ?? status), auth);
  }
  return body.data;
}

/**
 * Log in with email and password.
 *
 * COROS accepts a login on any regional host and then honours the token only on
 * the account's own host, so a login "succeeding" proves nothing. `validate`
 * makes one cheap call to prove the token works where it will be used.
 */
export async function login(
  opts: { email: string; password: string; region: string },
  fetchImpl: FetchLike = fetch,
): Promise<HubSession> {
  const base = HUB_BASE[opts.region];
  if (!base) throw new Error(`unknown region "${opts.region}"`);
  const res = await fetchImpl(`${base}/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      account: opts.email,
      accountType: 2,
      pwd: md5hex(opts.password),
    }),
  });
  const data = check(await res.json().catch(() => null), "login", res.status);
  if (!data?.accessToken || !data?.userId) {
    throw new HubError("login: no token in the response", "noToken");
  }
  return {
    accessToken: data.accessToken,
    userId: String(data.userId),
    region: opts.region,
  };
}

export class Hub {
  constructor(
    private session: HubSession,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent": UA,
      accessToken: this.session.accessToken,
      // The header is literally named "yfheader" and holds a JSON string.
      yfheader: JSON.stringify({ userId: this.session.userId }),
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private url(path: string, params?: Record<string, string | number>): string {
    const u = new URL(HUB_BASE[this.session.region] + path);
    for (const [k, v] of Object.entries(params ?? {})) {
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async get(
    path: string,
    params?: Record<string, string | number>,
  ): Promise<Json> {
    const res = await this.fetchImpl(this.url(path, params), {
      headers: this.headers(),
    });
    return check(await res.json().catch(() => null), path, res.status);
  }

  async post(
    path: string,
    body: unknown,
    params?: Record<string, string>,
  ): Promise<Json> {
    const form = body instanceof URLSearchParams;
    const res = await this.fetchImpl(this.url(path, params), {
      method: "POST",
      // The activity detail endpoint wants a form body; setting a JSON content
      // type on it makes the server ignore the fields.
      headers: this.headers(!form),
      body: form ? body : JSON.stringify(body),
    });
    return check(await res.json().catch(() => null), path, res.status);
  }

  /** One cheap authenticated call, to prove the token works on this host. */
  async validate(): Promise<void> {
    await this.get("/dashboard/query");
  }

  /**
   * Daily metrics over a date range.
   *
   * Two endpoints, merged: `/analyse/dayDetail/query` covers long ranges but
   * lacks the fitness fields, and `/analyse/query` covers only the last ~28
   * days but has them. Fitness fields are copied onto days the first endpoint
   * returned; days only the second returned are dropped, as coros-mcp does.
   */
  async dailyMetrics(start: string, end: string): Promise<DailyMetrics[]> {
    const [detail, recent] = await Promise.all([
      this.get("/analyse/dayDetail/query", {
        startDay: corosDate(start),
        endDay: corosDate(end),
      }),
      // Failing quietly is deliberate: without it the long-range data still
      // stands, minus five fields.
      this.get("/analyse/query").catch(() => null),
    ]);
    return mergeDaily(detail?.dayList ?? [], recent?.t7dayList ?? []);
  }

  /** Activities in a date range, every page. */
  async activities(start: string, end: string): Promise<ActivitySummary[]> {
    const out: ActivitySummary[] = [];
    const size = 100;
    for (let page = 1; page < 50; page++) {
      const data = await this.get("/activity/query", {
        startDay: corosDate(start),
        endDay: corosDate(end),
        pageNumber: page,
        size,
      });
      const items = data?.dataList ?? data?.list ?? [];
      out.push(...items.map(parseActivity));
      const total = Number(data?.totalCount ?? data?.count ?? 0);
      if (items.length < size || page * size >= total) break;
    }
    return out;
  }

  /** One activity's laps, zones and summary, with the bulky series dropped. */
  async activityDetail(labelId: string, sportType: number): Promise<Json> {
    const data = await this.post(
      "/activity/detail/query",
      new URLSearchParams({
        labelId,
        userId: this.session.userId,
        sportType: String(sportType),
      }),
    );
    return compactDetail(data);
  }

  async schedule(start: string, end: string): Promise<Json> {
    // The keys here are startDate/endDate, not startDay/endDay as everywhere
    // else in this API.
    return await this.get("/training/schedule/query", {
      startDate: corosDate(start),
      endDate: corosDate(end),
      supportRestExercise: 1,
    });
  }

  /** Remove one scheduled entry. versionObjects status 3 means delete. */
  async removeScheduled(
    e: { idInPlan: string; planProgramId: string; planId: string },
  ): Promise<void> {
    await this.post("/training/schedule/update", {
      versionObjects: [{
        id: e.idInPlan,
        planProgramId: e.planProgramId,
        planId: e.planId,
        status: 3,
      }],
      pbVersion: 2,
    });
  }
}

// --- shapes ----------------------------------------------------------------

export type DailyMetrics = {
  date: string;
  hrv: number | null;
  hrvBaseline: number | null;
  restingHr: number | null;
  trainingLoad: number | null;
  trainingLoadRatio: number | null;
  fatigue: number | null;
  acuteLoad: number | null;
  chronicLoad: number | null;
  distanceMetres: number | null;
  durationSeconds: number | null;
  vo2max: number | null;
  lthr: number | null;
  thresholdPaceSecPerKm: number | null;
  stamina: number | null;
  stamina7d: number | null;
};

// deno-lint-ignore no-explicit-any
const n = (v: any): number | null =>
  v === null || v === undefined || v === "" || Number.isNaN(Number(v))
    ? null
    : Number(v);

// deno-lint-ignore no-explicit-any
export function mergeDaily(dayList: any[], t7dayList: any[]): DailyMetrics[] {
  const byDay = new Map<string, DailyMetrics>();
  for (const d of dayList) {
    const date = isoDate(String(d.happenDay));
    byDay.set(date, {
      date,
      hrv: n(d.avgSleepHrv),
      hrvBaseline: n(d.sleepHrvBase),
      restingHr: n(d.rhr),
      trainingLoad: n(d.trainingLoad),
      trainingLoadRatio: n(d.trainingLoadRatio),
      // "tiredRateNew" — the field without the suffix is a different, older
      // number.
      fatigue: n(d.tiredRateNew),
      acuteLoad: n(d.ati),
      chronicLoad: n(d.cti),
      distanceMetres: n(d.distance),
      durationSeconds: n(d.duration),
      vo2max: n(d.vo2max),
      lthr: n(d.lthr),
      thresholdPaceSecPerKm: n(d.ltsp),
      stamina: n(d.staminaLevel),
      stamina7d: n(d.staminaLevel7d),
    });
  }
  for (const d of t7dayList) {
    const row = byDay.get(isoDate(String(d.happenDay)));
    if (!row) continue;
    row.vo2max = n(d.vo2max) ?? row.vo2max;
    row.lthr = n(d.lthr) ?? row.lthr;
    row.thresholdPaceSecPerKm = n(d.ltsp) ?? row.thresholdPaceSecPerKm;
    row.stamina = n(d.staminaLevel) ?? row.stamina;
    row.stamina7d = n(d.staminaLevel7d) ?? row.stamina7d;
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export type ActivitySummary = {
  labelId: string;
  name: string;
  sportType: number;
  sport: string;
  startTime: string | null;
  durationSeconds: number | null;
  distanceMetres: number | null;
  avgHr: number | null;
  maxHr: number | null;
  calories: number | null;
  trainingLoad: number | null;
  avgPower: number | null;
  ascentMetres: number | null;
};

/** Activity sport codes. A different namespace from workout sport types. */
export const SPORT_NAMES: Record<number, string> = {
  100: "Run",
  101: "Indoor Run",
  102: "Trail Run",
  103: "Track Run",
  104: "Hike",
  200: "Road Bike",
  201: "Indoor Bike",
  203: "Gravel Bike",
  204: "Mountain Bike",
  300: "Pool Swim",
  301: "Open Water",
  400: "Cardio",
  402: "Strength",
  403: "Yoga",
  900: "Walk",
};

// deno-lint-ignore no-explicit-any
const first = (...vs: any[]) => vs.find((v) => v !== null && v !== undefined);

// deno-lint-ignore no-explicit-any
export function parseActivity(a: any): ActivitySummary {
  const sportType = Number(a.sportType);
  const start = n(a.startTime);
  const cal = n(a.calorie);
  return {
    // An 18-digit id: past Number.MAX_SAFE_INTEGER, so it must stay a string.
    labelId: String(a.labelId),
    name: String(first(a.name, a.remark) ?? ""),
    sportType,
    sport: SPORT_NAMES[sportType] ?? `Sport ${sportType}`,
    startTime: start === null ? null : new Date(start * 1000).toISOString(),
    durationSeconds: n(a.totalTime),
    // `first` rather than `||`: a zero distance is a real value, and falling
    // through to the next field on it was a bug in coros-mcp.
    distanceMetres: n(first(a.distance, a.totalDistance)),
    avgHr: n(a.avgHr),
    maxHr: n(a.maxHr),
    // Calories arrive in calories, not kilocalories.
    calories: cal === null ? null : Math.round(cal / 1000),
    trainingLoad: n(a.trainingLoad),
    avgPower: n(a.avgPower),
    ascentMetres: n(first(a.ascent, a.totalAscent, a.elevationGain)),
  };
}

const DROP_TOP = new Set([
  "graphList",
  "frequencyList",
  "gpsLightDuration",
  "userInfo",
  "userProfile",
  "deviceList",
  "newMessageCount",
  "level",
]);

/**
 * Drop the time series and per-lap noise from an activity detail.
 *
 * The raw response is around 125k characters, almost all of it per-second
 * series. What a person or a report wants is the summary, the zones and the
 * laps, which is a few percent of that.
 */
// deno-lint-ignore no-explicit-any
export function compactDetail(data: any): any {
  if (!data || typeof data !== "object") return data;
  // deno-lint-ignore no-explicit-any
  const out: any = {};
  for (const [k, v] of Object.entries(data)) if (!DROP_TOP.has(k)) out[k] = v;
  if (Array.isArray(out.lapList)) {
    // deno-lint-ignore no-explicit-any
    out.lapList = out.lapList.map((lap: any) => ({
      ...lap,
      lapItemList: Array.isArray(lap.lapItemList)
        // deno-lint-ignore no-explicit-any
        ? lap.lapItemList.map((item: any) =>
          Object.fromEntries(
            Object.entries(item).filter(([key, v]) =>
              v !== null && v !== "" && v !== 0 && v !== false &&
              !(Array.isArray(v) && v.length === 0) && !key.endsWith("Index")
            ),
          )
        )
        : lap.lapItemList,
    }));
  }
  return out;
}

/** Find a scheduled entry by idInPlan or by name on one day. */
export function findScheduled(
  schedule: Json,
  by: { idInPlan?: string; name?: string },
) {
  const planId = String(schedule?.id ?? "");
  // deno-lint-ignore no-explicit-any
  const programs = new Map<string, any>();
  for (const p of schedule?.programs ?? []) programs.set(String(p.idInPlan), p);
  // deno-lint-ignore no-explicit-any
  const entries = (schedule?.entities ?? []).map((e: any) => ({
    idInPlan: String(e.idInPlan),
    planProgramId: String(e.planProgramId ?? e.idInPlan),
    planId,
    happenDay: String(e.happenDay),
    name: String(programs.get(String(e.idInPlan))?.name ?? ""),
  }));
  // deno-lint-ignore no-explicit-any
  return entries.filter((e: any) =>
    by.idInPlan
      ? e.idInPlan === String(by.idInPlan)
      : by.name
      ? e.name.trim().toLowerCase() === by.name.trim().toLowerCase()
      : true
  );
}
