/**
 * @skunk-ape/is-it-us — when something breaks, check whether the problem is
 * upstream before assuming it is us.
 *
 * `check` reads the public status pages for GitHub, Cloudflare and AWS, writes
 * one record per provider and a rollup, and works out which open incidents are
 * new since the last check. The rollup carries a ready-made alert title,
 * message and priority, so a workflow can hand them to `@mgreten/ntfy-notify`
 * with no glue in between, and skip the push when nothing is new.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  decodeAwsBody,
  failedStatus,
  IMPACTS,
  parseAwsEvents,
  parseStatuspage,
  type Provider,
  PROVIDERS,
  type ProviderStatus,
  rollup,
  SOURCES,
  type Summary,
} from "./_lib/providers.ts";

// deno-lint-ignore no-explicit-any
type Ctx = any;

const GlobalArgsSchema = z.object({
  providers: z.array(z.enum(PROVIDERS)).min(1).default([...PROVIDERS])
    .describe(
      "Which status pages to read. All three by default; drop one you do not depend on so its incidents never page you.",
    ),
  awsRegions: z.array(z.string()).default([]).describe(
    'AWS region codes to care about, such as "us-east-1", plus "global" for events that have no region. Empty keeps every region. Worth setting: AWS events in regions you do not use can stay open for months.',
  ),
  timeoutSeconds: z.number().positive().default(20).describe(
    "Per-provider wall-clock cap. A provider that times out is reported as unreachable; the others still count.",
  ),
  userAgent: z.string().default(
    "swamp-is-it-us/1.0 (+https://github.com/skunk-ape/swamp-extensions)",
  ).describe("User-Agent sent to the status pages."),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ImpactSchema = z.enum(IMPACTS);

const IncidentSchema = z.object({
  id: z.string(),
  provider: z.enum(PROVIDERS),
  title: z.string(),
  status: z.string(),
  impact: ImpactSchema,
  url: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  components: z.array(z.string()),
  latestUpdate: z.string(),
});

const ProviderStatusSchema = z.object({
  provider: z.enum(PROVIDERS),
  name: z.string(),
  pageUrl: z.string(),
  ok: z.boolean(),
  error: z.string(),
  indicator: ImpactSchema,
  description: z.string(),
  incidents: z.array(IncidentSchema),
  checkedAt: z.string(),
});

const SummarySchema = z.object({
  checkedAt: z.string(),
  providers: z.array(z.object({
    provider: z.enum(PROVIDERS),
    name: z.string(),
    ok: z.boolean(),
    indicator: ImpactSchema,
    description: z.string(),
    openIncidents: z.number(),
  })),
  overall: ImpactSchema,
  openIncidentCount: z.number(),
  openIncidents: z.array(IncidentSchema),
  newIncidentCount: z.number(),
  newIncidents: z.array(IncidentSchema),
  resolvedIncidentIds: z.array(z.string()),
  failedProviders: z.array(z.enum(PROVIDERS)),
  seenIncidentIds: z.array(z.string()),
  firstCheck: z.boolean(),
  alertTitle: z.string(),
  alertMessage: z.string(),
  alertPriority: z.number(),
});

async function fetchProvider(
  provider: Provider,
  g: GlobalArgs,
  signal: AbortSignal | undefined,
): Promise<ProviderStatus> {
  const checkedAt = new Date().toISOString();
  const timeout = AbortSignal.timeout(g.timeoutSeconds * 1000);
  try {
    const res = await fetch(SOURCES[provider].api, {
      headers: { "user-agent": g.userAgent, accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return failedStatus(provider, `HTTP ${res.status}`, checkedAt);
    }
    if (provider === "aws") {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = decodeAwsBody(bytes, res.headers.get("content-type") ?? "");
      return parseAwsEvents(JSON.parse(text), checkedAt, g.awsRegions);
    }
    return parseStatuspage(provider, await res.json(), checkedAt);
  } catch (err) {
    return failedStatus(
      provider,
      err instanceof Error ? err.message : String(err),
      checkedAt,
    );
  }
}

/** Behavior definition for `@skunk-ape/is-it-us`. */
export const behavior = {
  type: "@skunk-ape/is-it-us",
  version: "2026.10.28.1",
  globalArguments: GlobalArgsSchema,
  reports: ["@skunk-ape/is-it-us/rollup"],
  resources: {
    provider: {
      description:
        "One provider's status on the latest check: overall indicator and its open incidents.",
      schema: ProviderStatusSchema,
      lifetime: "30d",
      garbageCollection: 50,
    },
    summary: {
      description:
        "The rollup across providers: open and new incidents, and a ready-made alert for ntfy.",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    check: {
      description:
        "Read the public status pages and roll them up. Read-only: one GET per provider, nothing else. Fails only when every provider is unreachable, since a rollup of nothing would read as all clear.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;
        const providers = [...new Set(g.providers)];
        ctx.logger.info("Reading status pages: {providers}", {
          providers: providers.join(", "),
        });
        const statuses = await Promise.all(
          providers.map((p) => fetchProvider(p, g, ctx.signal)),
        );

        if (statuses.every((s) => !s.ok)) {
          throw new Error(
            `No status page could be read: ${
              statuses.map((s) => `${s.provider}: ${s.error}`).join("; ")
            }`,
          );
        }

        const previous = await ctx.readResource("summary") as Summary | null;
        const summary = rollup(statuses, previous, new Date().toISOString());

        const handles = [];
        for (const s of statuses) {
          handles.push(
            await ctx.writeResource("provider", `provider-${s.provider}`, s),
          );
          if (!s.ok) {
            ctx.logger.warning("{provider} unreachable: {error}", {
              provider: s.name,
              error: s.error,
            });
          }
        }
        handles.push(await ctx.writeResource("summary", "summary", summary));

        ctx.logger.info(
          "{open} open incident(s), {fresh} new, {resolved} resolved since last check",
          {
            open: summary.openIncidentCount,
            fresh: summary.newIncidentCount,
            resolved: summary.resolvedIncidentIds.length,
          },
        );
        return { dataHandles: handles };
      },
    },
  },
};
