// What `pr_state` means on any forge: the input, the one record shape, how checks
// count, and what makes a run fail. A forge only has to say how to read its PRs.

import { z } from "npm:zod@4";
import type { HttpOptions } from "./http.ts";

export const USER_AGENT =
  "skunk-ape-local-dev/1.0 (+https://github.com/skunk-ape/swamp-extensions)";

const MAX_PRS = 200;
const MAX_ERROR_CHARS = 300;
const GITHUB_INT_MAX = 2_147_483_647; // GraphQL's Int, and far above any real PR

export const PrStateArgs = z.object({
  prs: z.array(z.string()).min(1).max(MAX_PRS).describe(
    "The pull requests to read, each as owner/repo#number. They can span repositories.",
  ),
});

const FailedCheckSchema = z.object({
  name: z.string(),
  conclusion: z.string().describe("The forge's own word for it, lowercased."),
  url: z.string().nullable().describe(
    "An absolute http or https link, or null when the forge gave no usable one.",
  ),
});

const ChecksSchema = z.object({
  state: z.enum(["passing", "failing", "pending", "none"]).describe(
    "failing if any failed, else pending if any are unfinished, else passing. none when there are no checks.",
  ),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  pending: z.number(),
  skipped: z.number(),
  failures: z.array(FailedCheckSchema).describe("Only the checks that failed."),
});
export type Checks = z.infer<typeof ChecksSchema>;

const PrSchema = z.object({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  state: z.enum(["open", "merged", "closed"]),
  draft: z.boolean(),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]).describe(
    "unknown on any PR that is not open.",
  ),
  headSha: z.string(),
  mergeCommit: z.string().nullable().describe("Null unless merged."),
  updatedAt: z.string(),
  checks: ChecksSchema,
});
export type Pr = z.infer<typeof PrSchema>;

export const PrStateSchema = z.object({
  prs: z.array(PrSchema).describe("The PRs that were read, in input order."),
  failures: z.array(z.object({
    pr: z.string().describe("owner/repo#number, as given."),
    error: z.string(),
  })).describe("The PRs that could not be read, in input order."),
  complete: z.boolean().describe("False when any PR is in `failures`."),
});
export type PrState = z.infer<typeof PrStateSchema>;

/** A pull request named by the input. `key` is its spelling, `owner/repo#number`. */
export type PrRef = {
  key: string;
  owner: string;
  name: string;
  repo: string;
  number: number;
};

/** What a forge found for each PR, by `PrRef.key`. */
export type PrResults = Map<string, Pr | { error: string }>;

/** Reads every PR it can. Throws only for what fails the whole run. */
export type PrReader = (
  refs: PrRef[],
  opts: HttpOptions,
) => Promise<PrResults>;

/** The forge refused the token, which is the run's failure and not any one PR's. */
export class TokenRejected extends Error {}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

function validSegment(s: string): boolean {
  // "." and ".." would walk up a REST path, with the token on the request.
  return SEGMENT.test(s) && s !== "." && s !== "..";
}

/** Parses `owner/repo#number`, or returns null. */
export function parsePrRef(text: string): PrRef | null {
  const match = /^([^/#]+)\/([^/#]+)#([1-9][0-9]*)$/.exec(text);
  if (!match) return null;
  const [, owner, name, digits] = match;
  const number = Number(digits);
  if (
    !validSegment(owner) || !validSegment(name) || number > GITHUB_INT_MAX
  ) {
    return null;
  }
  return { key: text, owner, name, repo: `${owner}/${name}`, number };
}

/** Every PR named, once each, in order. Refuses the whole input over a bad name. */
export function parsePrRefs(prs: string[]): PrRef[] {
  const refs = [...new Set(prs)].map((text) => ({
    text,
    ref: parsePrRef(text),
  }));
  const bad = refs.filter((r) => r.ref === null).map((r) => r.text);
  if (bad.length) {
    throw new Error(`Not owner/repo#number: ${bad.join(", ")}`);
  }
  return refs.map((r) => r.ref as PrRef);
}

/** One check, already sorted into a bucket by its forge. */
export type Check = {
  bucket: "passed" | "failed" | "pending" | "skipped";
  name: string;
  conclusion: string;
  url: string | null;
};

/** The counts and overall state, which is worked out here and never taken from a forge. */
export function summarizeChecks(checks: Check[]): Checks {
  const count = (bucket: Check["bucket"]) =>
    checks.filter((c) => c.bucket === bucket).length;
  const failed = count("failed");
  const pending = count("pending");
  return {
    state: checks.length === 0
      ? "none"
      : failed > 0
      ? "failing"
      : pending > 0
      ? "pending"
      : "passing",
    total: checks.length,
    passed: count("passed"),
    failed,
    pending,
    skipped: count("skipped"),
    failures: checks.filter((c) => c.bucket === "failed").map((c) => ({
      name: c.name,
      conclusion: c.conclusion,
      url: c.url,
    })),
  };
}

/**
 * Resolves a check's link against the forge. Check links are set by whatever
 * reports the check, so only http and https survive.
 */
export function absoluteLink(raw: unknown, base: string): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const url = new URL(raw, base);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** One form of time across forges, leaving anything unparsable as it came. */
export function isoTime(raw: unknown): string {
  const text = String(raw ?? "");
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? text : new Date(ms).toISOString();
}

/** Keeps an error from a server short enough for a record. */
export function shortError(text: string): string {
  return text.length > MAX_ERROR_CHARS
    ? `${text.slice(0, MAX_ERROR_CHARS)}...`
    : text;
}

/** Parses, reads and shapes. A bad name refuses the run before any request. */
export async function buildPrState(
  prs: string[],
  read: PrReader,
  opts: HttpOptions,
): Promise<PrState> {
  const refs = parsePrRefs(prs);
  const results = await read(refs, opts);
  opts.signal?.throwIfAborted(); // a cancelled run is not a run of failed reads
  const state: PrState = { prs: [], failures: [], complete: true };
  for (const ref of refs) {
    const result = results.get(ref.key) ??
      { error: "the forge returned nothing for this PR" };
    if ("error" in result) {
      state.failures.push({ pr: ref.key, error: result.error });
    } else {
      state.prs.push(result);
    }
  }
  state.complete = state.failures.length === 0;
  return state;
}

/** The one resource both types write. */
export const prStateResources = {
  state: {
    description:
      "The PRs the last pr_state run read, in instance pr-state. A run that read nothing writes nothing, so the last good record stays the latest.",
    schema: PrStateSchema,
    lifetime: "infinite",
    garbageCollection: 10,
  },
} as const;

// deno-lint-ignore no-explicit-any
type Ctx = any;

/** A `pr_state` run: read, refuse to write an empty record, say what's missing. */
export async function runPrState(
  args: { prs: string[] },
  ctx: Ctx,
  read: PrReader,
  opts: HttpOptions,
): Promise<{ dataHandles: unknown[] }> {
  ctx.logger.info("Reading {n} PR(s)", { n: args.prs.length });
  const state = await buildPrState(args.prs, read, opts);
  // Writing this would put an empty record where the last good one is.
  if (state.prs.length === 0) {
    const first = state.failures[0];
    throw new Error(
      `Nothing could be read: ${state.failures.length} failure(s), first ${first.pr}: ${first.error}`,
    );
  }
  if (!state.complete) {
    ctx.logger.warning("Incomplete: {n} PR(s) could not be read", {
      n: state.failures.length,
    });
  }
  ctx.logger.info("{n} PR(s) read", { n: state.prs.length });
  const handle = await ctx.writeResource("state", "pr-state", state);
  return { dataHandles: [handle] };
}
