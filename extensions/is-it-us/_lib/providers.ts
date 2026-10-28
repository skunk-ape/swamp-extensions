/**
 * Parsing and rollup for public provider status pages. No I/O lives here, so
 * every rule the alert depends on can be tested against a saved response.
 *
 * @module
 */

/** Providers this extension knows how to read. */
export const PROVIDERS = ["github", "cloudflare", "aws"] as const;
/** One of {@link PROVIDERS}. */
export type Provider = typeof PROVIDERS[number];

/** Normalized severity, worst last. Statuspage's own indicator scale. */
export const IMPACTS = ["none", "minor", "major", "critical"] as const;
/** One of {@link IMPACTS}. */
export type Impact = typeof IMPACTS[number];

/** Where each provider's machine-readable status lives. */
export const SOURCES: Record<
  Provider,
  { name: string; api: string; page: string }
> = {
  github: {
    name: "GitHub",
    api: "https://www.githubstatus.com/api/v2/summary.json",
    page: "https://www.githubstatus.com",
  },
  cloudflare: {
    name: "Cloudflare",
    api: "https://www.cloudflarestatus.com/api/v2/summary.json",
    page: "https://www.cloudflarestatus.com",
  },
  aws: {
    name: "AWS",
    api: "https://health.aws.amazon.com/public/currentevents",
    page: "https://health.aws.amazon.com/health/status",
  },
};

/** Longest provider update text kept on an incident. */
export const MAX_UPDATE_CHARS = 500;

/** One open incident, the same shape whichever provider reported it. */
export type Incident = {
  /** Stable across checks: Statuspage incident id, or the AWS event ARN. */
  id: string;
  provider: Provider;
  title: string;
  /** The provider's own status word: investigating, monitoring, … */
  status: string;
  impact: Impact;
  url: string;
  startedAt: string;
  updatedAt: string;
  components: string[];
  latestUpdate: string;
};

/** What one provider looked like on one check. */
export type ProviderStatus = {
  provider: Provider;
  name: string;
  pageUrl: string;
  /** False when the page could not be fetched or parsed. */
  ok: boolean;
  error: string;
  /** Worst of the page's overall indicator and its open incidents. */
  indicator: Impact;
  description: string;
  incidents: Incident[];
  checkedAt: string;
};

const clip = (s: unknown, n = MAX_UPDATE_CHARS): string => {
  const t = typeof s === "string" ? s.trim() : "";
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const toImpact = (s: unknown): Impact =>
  (IMPACTS as readonly string[]).includes(s as string) ? s as Impact : "none";

/** The more severe of two impacts. */
export const worst = (a: Impact, b: Impact): Impact =>
  IMPACTS.indexOf(a) >= IMPACTS.indexOf(b) ? a : b;

// deno-lint-ignore no-explicit-any
type Json = any;

/**
 * Read an Atlassian Statuspage `summary.json` (GitHub and Cloudflare both use
 * one). The `incidents` array there holds unresolved incidents only, which is
 * exactly "open". Scheduled maintenance is left out on purpose: it is
 * announced in advance and is not something to be woken up for.
 */
export function parseStatuspage(
  provider: Provider,
  body: Json,
  checkedAt: string,
): ProviderStatus {
  if (!body || typeof body !== "object" || !Array.isArray(body.incidents)) {
    throw new Error("not a Statuspage summary: no incidents array");
  }
  const incidents: Incident[] = body.incidents
    .filter((i: Json) =>
      i && i.status !== "resolved" && i.status !== "postmortem"
    )
    .map((i: Json): Incident => ({
      id: `${provider}:${i.id}`,
      provider,
      title: clip(i.name, 300),
      status: String(i.status ?? "unknown"),
      // Statuspage marks some live incidents impact "none"; it is still open.
      impact: toImpact(i.impact),
      url: String(i.shortlink ?? `${SOURCES[provider].page}/incidents/${i.id}`),
      startedAt: String(i.started_at ?? i.created_at ?? ""),
      updatedAt: String(i.updated_at ?? ""),
      components: Array.isArray(i.components)
        ? i.components.map((c: Json) => String(c?.name ?? "")).filter(Boolean)
        : [],
      latestUpdate: clip(i.incident_updates?.[0]?.body),
    }));
  const indicator = incidents.reduce(
    (acc, i) => worst(acc, i.impact),
    toImpact(body.status?.indicator),
  );
  return {
    provider,
    name: SOURCES[provider].name,
    pageUrl: SOURCES[provider].page,
    ok: true,
    error: "",
    indicator,
    description: String(body.status?.description ?? ""),
    incidents,
    checkedAt,
  };
}

/**
 * Decode the AWS Health public feed. It is served as
 * `application/json;charset=utf-16`, big-endian with a byte-order mark, which
 * `Response.json()` would read as UTF-8 and fail on. Honour a BOM when there
 * is one, then the declared charset, then fall back to UTF-8.
 */
export function decodeAwsBody(bytes: Uint8Array, contentType = ""): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (/charset=utf-16/i.test(contentType)) {
    // No BOM: a leading NUL means the high byte comes first.
    return new TextDecoder(bytes[0] === 0 ? "utf-16be" : "utf-16le").decode(
      bytes,
    );
  }
  return new TextDecoder().decode(bytes);
}

// AWS event status: 1 informational, 2 degraded, 3 disruption; 0 is resolved.
const AWS_IMPACT: Record<string, Impact> = {
  "1": "minor",
  "2": "major",
  "3": "critical",
};

/** Region code from an AWS Health ARN; "global" when the ARN has none. */
export function awsRegionOf(arn: string): string {
  return arn.split(":")[3] || "global";
}

const epochIso = (s: unknown): string => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : "";
};

/**
 * Read the AWS Health public `currentevents` feed: a JSON array of events
 * open right now. `regions` limits it to region codes such as `us-east-1`
 * (with `global` for events that have no region); empty keeps every event.
 */
export function parseAwsEvents(
  body: Json,
  checkedAt: string,
  regions: string[] = [],
): ProviderStatus {
  if (!Array.isArray(body)) {
    throw new Error("not an AWS Health feed: expected a JSON array");
  }
  const keep = new Set(regions.map((r) => r.toLowerCase()));
  const incidents: Incident[] = body
    .filter((e: Json) => e && String(e.status) !== "0")
    .filter((e: Json) =>
      keep.size === 0 || keep.has(awsRegionOf(String(e.arn ?? "")))
    )
    .map((e: Json): Incident => {
      const log = Array.isArray(e.event_log) ? e.event_log : [];
      const last = log[log.length - 1];
      const region = e.region_name ? ` (${e.region_name})` : "";
      return {
        id: String(e.arn ?? `aws:${e.service}:${e.date}`),
        provider: "aws",
        title: clip(
          `${e.service_name ?? e.service}${region}: ${e.summary ?? ""}`,
          300,
        ),
        status: last?.summary ? String(last.summary) : "open",
        impact: AWS_IMPACT[String(e.status)] ?? "minor",
        url: SOURCES.aws.page,
        startedAt: epochIso(e.date),
        updatedAt: epochIso(last?.timestamp ?? e.date),
        components: [awsRegionOf(String(e.arn ?? ""))],
        latestUpdate: clip(last?.message),
      };
    });
  const indicator = incidents.reduce<Impact>(
    (acc, i) => worst(acc, i.impact),
    "none",
  );
  return {
    provider: "aws",
    name: SOURCES.aws.name,
    pageUrl: SOURCES.aws.page,
    ok: true,
    error: "",
    indicator,
    description: incidents.length
      ? `${incidents.length} open event${incidents.length === 1 ? "" : "s"}`
      : "No open events",
    incidents,
    checkedAt,
  };
}

/** A provider whose page could not be read this time. */
export function failedStatus(
  provider: Provider,
  error: string,
  checkedAt: string,
): ProviderStatus {
  return {
    provider,
    name: SOURCES[provider].name,
    pageUrl: SOURCES[provider].page,
    ok: false,
    error: clip(error, 300),
    indicator: "none",
    description: "Status page unreachable",
    incidents: [],
    checkedAt,
  };
}

/**
 * Which provider an incident id belongs to. Statuspage ids are prefixed with
 * the provider; AWS ids are event ARNs, or `aws:` when an event has no ARN.
 */
export function providerOfId(id: string): Provider | null {
  if (id.startsWith("arn:aws:") || id.startsWith("aws:")) return "aws";
  const prefix = id.slice(0, id.indexOf(":"));
  return (PROVIDERS as readonly string[]).includes(prefix)
    ? prefix as Provider
    : null;
}

/** The rollup across every provider, and what changed since last time. */
export type Summary = {
  checkedAt: string;
  providers: Array<{
    provider: Provider;
    name: string;
    ok: boolean;
    indicator: Impact;
    description: string;
    openIncidents: number;
  }>;
  /** Worst indicator across the providers that answered. */
  overall: Impact;
  openIncidentCount: number;
  openIncidents: Incident[];
  newIncidentCount: number;
  newIncidents: Incident[];
  /** Incident ids open last check and gone now. */
  resolvedIncidentIds: string[];
  failedProviders: Provider[];
  /**
   * Every incident id considered already seen. It carries forward the
   * previous ids of a provider that failed this check, so a status page that
   * blips does not make its open incidents look new when it comes back.
   */
  seenIncidentIds: string[];
  /** True on the first check, when there was nothing to compare against. */
  firstCheck: boolean;
  alertTitle: string;
  alertMessage: string;
  /** ntfy priority, 1–5. */
  alertPriority: number;
};

const PRIORITY: Record<Impact, number> = {
  none: 3,
  minor: 3,
  major: 4,
  critical: 5,
};

/**
 * Roll provider results into one summary and decide what is new.
 *
 * "New" means not in the previous summary's `seenIncidentIds`. On a first
 * check every open incident is new: that is the moment monitoring started,
 * and an outage already in progress is worth one push.
 */
export function rollup(
  statuses: ProviderStatus[],
  previous: Pick<Summary, "seenIncidentIds" | "openIncidents"> | null,
  checkedAt: string,
): Summary {
  const open = statuses.flatMap((s) => s.incidents);
  const failed = statuses.filter((s) => !s.ok).map((s) => s.provider);
  const prevSeen = new Set(previous?.seenIncidentIds ?? []);
  const newIncidents = open.filter((i) => !prevSeen.has(i.id));

  // From the previous seen ids, not its open incidents: a provider that also
  // failed last time has no open incidents there, and would lose them.
  const carried = [...prevSeen].filter((id) => {
    const p = providerOfId(id);
    return p !== null && failed.includes(p);
  });
  const seen = [...new Set([...open.map((i) => i.id), ...carried])];
  const openIds = new Set(open.map((i) => i.id));
  const resolved = (previous?.openIncidents ?? [])
    .filter((i) => !failed.includes(i.provider) && !openIds.has(i.id))
    .map((i) => i.id);

  const overall = statuses
    .filter((s) => s.ok)
    .reduce<Impact>((acc, s) => worst(acc, s.indicator), "none");
  const top = newIncidents.reduce<Impact>(
    (acc, i) => worst(acc, i.impact),
    "none",
  );
  const names = [...new Set(newIncidents.map((i) => SOURCES[i.provider].name))];

  return {
    checkedAt,
    providers: statuses.map((s) => ({
      provider: s.provider,
      name: s.name,
      ok: s.ok,
      indicator: s.indicator,
      description: s.description,
      openIncidents: s.incidents.length,
    })),
    overall,
    openIncidentCount: open.length,
    openIncidents: open,
    newIncidentCount: newIncidents.length,
    newIncidents,
    resolvedIncidentIds: resolved,
    failedProviders: failed,
    seenIncidentIds: seen,
    firstCheck: previous === null,
    alertTitle: newIncidents.length
      ? `Is it us? Maybe not: ${names.join(", ")} (${newIncidents.length} new)`
      : "",
    alertMessage: newIncidents
      .map((i) =>
        `${
          SOURCES[i.provider].name
        }: ${i.title} [${i.status}, ${i.impact}]\n${i.url}`
      )
      .join("\n\n"),
    alertPriority: PRIORITY[top],
  };
}
