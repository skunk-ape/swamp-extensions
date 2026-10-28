/**
 * @skunk-ape/swamp-lab — a daily digest of Swamp Club's public Lab.
 *
 * `sync` mirrors every public Lab issue into one versioned `corpus` record.
 * `digest` compares that corpus with the baseline the last recorded digest
 * saved, and writes what shipped, what opened, what moved, what repeats older
 * issues, and what lands near the reader's own recent work — with the
 * phone-friendly markdown alongside. Nothing in it is written by a model: the
 * agent that delivers it adds its own reading on top.
 *
 * Read-only towards Swamp Club: public endpoints, no authentication, nothing
 * filed or commented.
 */
import { z } from "npm:zod@4";
import { classify, primaryArea } from "./_lib/classify.ts";
import { type Baseline, baselineOf, buildDigest } from "./_lib/digest.ts";
import { fetchCorpus, fetchIssue, type Issue } from "./_lib/lab.ts";
import { render } from "./_lib/render.ts";

// deno-lint-ignore no-explicit-any
type Ctx = any;

const GlobalArgsSchema = z.object({
  team: z.record(z.string(), z.string()).default({
    "skunk-ape": "Seth",
    stack72: "Paul",
    zack: "Zack",
  }).describe(
    "Lab handle to the name the digest uses. Order is the order of the 'who was where' lines.",
  ),
  me: z.string().default("skunk-ape").describe(
    "The reader's Lab handle: whose recent work 'lands near your work' is measured against.",
  ),
  timezone: z.string().default("America/Chicago").describe(
    "IANA timezone dates are shown in.",
  ),
  userAgent: z.string().default(
    "skunk-ape-swamp-lab/1.0 (+https://github.com/skunk-ape/swamp-extensions)",
  ),
  minCoverage: z.number().default(0.98).describe(
    "Below this share of the server's reported total, the corpus is reported as a coverage gap.",
  ),
  maxCorpusAgeHours: z.number().default(3).describe(
    "A digest built on a corpus older than this reports a coverage gap: the sync it should follow did not happen.",
  ),
  firstWindowStart: z.string().default("").describe(
    "ISO time the first digest starts from, when no digest has been recorded yet — for taking over from an earlier digest without a gap. Ignored once a baseline exists. Empty uses the digest's `hours`.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const IssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  type: z.string(),
  status: z.string(),
  author: z.string().nullable(),
  assignees: z.array(z.string()),
  blocked: z.boolean(),
  childCount: z.number(),
  source: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  areas: z.array(z.string()),
  primaryArea: z.string(),
});

const CorpusSchema = z.object({
  fetchedAt: z.string(),
  total: z.number().describe("The total the server reported."),
  seen: z.number(),
  pages: z.number(),
  duplicates: z.number(),
  coverage: z.number(),
  ok: z.boolean(),
  issues: z.array(IssueSchema),
});
type CorpusData = z.infer<typeof CorpusSchema>;

const BaselineSchema = z.object({
  at: z.string().describe("End of the last recorded digest's window."),
  issues: z.record(
    z.string(),
    z.object({ status: z.string(), assignees: z.array(z.string()) }),
  ),
});
type BaselineData = z.infer<typeof BaselineSchema>;

const DigestSchema = z.object({
  generatedAt: z.string(),
  recorded: z.boolean(),
  markdown: z.string(),
  digest: z.record(z.string(), z.unknown()),
});

const DetailSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  status: z.string(),
  body: z.string(),
  statusHistory: z.array(
    z.object({ at: z.string(), from: z.string().nullable(), to: z.string() }),
  ),
  prs: z.array(
    z.object({ number: z.number(), url: z.string(), at: z.string() }),
  ),
  fetchedAt: z.string(),
});

/** The `@skunk-ape/swamp-lab` behavior type. */
export const model = {
  type: "@skunk-ape/swamp-lab",
  version: "2026.10.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    corpus: {
      description:
        "Every public Lab issue as of the last sync, with its areas. One instance, versioned per sync.",
      schema: CorpusSchema,
      lifetime: "infinite",
      garbageCollection: 14,
    },
    baseline: {
      description:
        "Each issue's status and assignees at the end of the last recorded digest. What the next digest diffs against.",
      schema: BaselineSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    digest: {
      description:
        "The last digest: structured sections and the rendered markdown.",
      schema: DigestSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    issue: {
      description:
        "One issue's body, status history and linked PRs, fetched on request. Named issue-<number>.",
      schema: DetailSchema,
      lifetime: "30d",
      garbageCollection: 3,
    },
  },
  methods: {
    sync: {
      description:
        "Mirror every public Lab issue into the corpus. A full scan (about six requests for three thousand issues), deduplicated, and checked against the total the server reports so a partial scan reads as a coverage gap rather than a quiet day.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;
        const c = await fetchCorpus({
          userAgent: g.userAgent,
          signal: ctx.signal,
          delayMs: 400,
        });
        const ok = c.coverage >= g.minCoverage;
        if (!ok) {
          ctx.logger.warning(
            "Corpus incomplete: {seen} of {total} issues ({pct}%)",
            {
              seen: c.issues.length,
              total: c.total,
              pct: Math.round(c.coverage * 1000) / 10,
            },
          );
        }
        const handle = await ctx.writeResource("corpus", "corpus", {
          fetchedAt: new Date().toISOString(),
          total: c.total,
          seen: c.issues.length,
          pages: c.pages,
          duplicates: c.duplicates,
          coverage: c.coverage,
          ok,
          issues: c.issues.map((i) => {
            const areas = classify(i.title);
            return {
              ...i,
              areas: areas.map((a) => a.area),
              primaryArea: primaryArea(areas),
            };
          }),
        });
        ctx.logger.info("{n} Lab issues mirrored in {p} page(s)", {
          n: c.issues.length,
          p: c.pages,
        });
        return { dataHandles: [handle] };
      },
    },

    digest: {
      description:
        "Build the digest from the corpus: shipped by person, opened by area, Stagecraft, repeats of older issues, and new issues near the reader's recent work. The window runs from the last recorded digest to the corpus's sync time; with no recorded digest, it is the last `hours`. `record` (the default) saves the baseline the next digest diffs against — pass false to preview without moving the window.",
      arguments: z.object({
        hours: z.number().default(24).describe(
          "Window length when there is no recorded digest to start from.",
        ),
        record: z.boolean().default(true),
      }),
      execute: async (args: { hours: number; record: boolean }, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;
        const corpus = await ctx.readResource("corpus") as CorpusData | null;
        if (!corpus) throw new Error("no corpus yet — run sync first");
        const prev = await ctx.readResource("baseline") as BaselineData | null;

        const end = corpus.fetchedAt;
        const defaultStart = new Date(Date.parse(end) - args.hours * 3600000)
          .toISOString();
        const start = prev?.at ?? (g.firstWindowStart || defaultStart);
        const widened = start < defaultStart;

        const ageHours = (Date.now() - Date.parse(corpus.fetchedAt)) / 3600000;
        const notes: string[] = [];
        if (!corpus.ok) {
          notes.push(
            `The last sync saw ${corpus.seen} of the ${corpus.total} issues the Lab reports.`,
          );
        }
        if (ageHours > g.maxCorpusAgeHours) {
          notes.push(
            `The corpus is ${
              Math.round(ageHours)
            } hours old; the sync before this digest did not complete.`,
          );
        }

        const digest = buildDigest({
          issues: corpus.issues as Issue[],
          baseline: prev ? prev.issues as Baseline : null,
          windowStart: start,
          windowEnd: end,
          team: g.team,
          me: g.me,
          widened,
          coverage: {
            total: corpus.total,
            seen: corpus.seen,
            coverage: corpus.coverage,
            ok: notes.length === 0,
            note: notes.join(" "),
          },
        });
        const markdown = render(digest, g.timezone);

        const handles = [
          await ctx.writeResource("digest", "current", {
            generatedAt: new Date().toISOString(),
            recorded: args.record,
            markdown,
            digest,
          }),
        ];
        // A digest built on a stale or partial corpus does not move the
        // window: recording it would mark unseen changes as reported.
        if (args.record && digest.coverage.ok) {
          handles.push(
            await ctx.writeResource("baseline", "baseline", {
              at: end,
              issues: baselineOf(corpus.issues as Issue[]),
            }),
          );
        } else if (args.record) {
          ctx.logger.warning(
            "Coverage gap — the window was not recorded, so the next digest covers it again",
          );
        }
        ctx.logger.info(
          "{o} opened, {s} shipped or closed, {e} repeat(s) in {h}h",
          {
            o: digest.opened.total,
            s: digest.shipped.total,
            e: digest.echoes.length,
            h: digest.window.hours,
          },
        );
        return { dataHandles: handles };
      },
    },

    issues: {
      description:
        "Fetch the body, status history and linked PRs for a few issues, to discuss them from their content rather than their titles. One request each; at most 15.",
      arguments: z.object({
        numbers: z.array(z.number().int()).min(1).max(15),
      }),
      execute: async (args: { numbers: number[] }, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;
        const handles = [];
        for (const n of args.numbers) {
          const d = await fetchIssue(n, {
            userAgent: g.userAgent,
            signal: ctx.signal,
          });
          handles.push(
            await ctx.writeResource("issue", `issue-${n}`, {
              ...d,
              fetchedAt: new Date().toISOString(),
            }),
          );
          await new Promise((r) => setTimeout(r, 300));
        }
        return { dataHandles: handles };
      },
    },
  },
};
