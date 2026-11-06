/**
 * @skunk-ape/local-dev/forgejo — Forgejo pull requests in one call and one shape.
 *
 * `pr_state` reads a list of PRs, across repositories, into one record: state,
 * mergeability, and checks as counts plus only the failures. A failed read is
 * listed per PR, never dropped.
 *
 * Read-only: GET requests. Check names and links are stored as data, for a reader
 * to weigh, not to obey.
 */
import { z } from "npm:zod@4";
import {
  HttpError,
  type HttpOptions,
  mapBounded,
  message,
  requestJson,
  requestWithHeaders,
} from "./_lib/http.ts";
import {
  absoluteLink,
  type Check,
  isoTime,
  type Pr,
  type PrReader,
  type PrRef,
  type PrResults,
  PrStateArgs,
  prStateResources,
  runPrState,
  summarizeChecks,
  TokenRejected,
  USER_AGENT,
} from "./_lib/pr_state.ts";

const DEFAULT_BASE_URL = "https://git.swamp-club.com";
const PR_CONCURRENCY = 6;
const STATUS_PAGE_SIZE = 50;
const MAX_STATUS_PAGES = 50;

const GlobalArgsSchema = z.object({
  baseUrl: z.string().url().refine((u) => u.startsWith("https://"), {
    message: "baseUrl must be https, because the token goes there",
  }).default(DEFAULT_BASE_URL).describe("The Forgejo server."),
  token: z.string().min(1).meta({ sensitive: true }).optional().describe(
    "A Forgejo token, from a vault. Without one, only public repositories can be read.",
  ),
  userAgent: z.string().default(USER_AGENT),
});

// deno-lint-ignore no-explicit-any
function toCheck(status: any, base: string): Check {
  const name = String(status?.context ?? "unnamed check");
  const conclusion = String(status?.status ?? "unknown").toLowerCase();
  const url = absoluteLink(status?.target_url, base);
  if (conclusion === "success") {
    return { bucket: "passed", name, conclusion, url };
  }
  if (conclusion === "pending") {
    return { bucket: "pending", name, conclusion, url };
  }
  if (conclusion === "skipped") {
    return { bucket: "skipped", name, conclusion, url };
  }
  // failure, error and warning, and any word this doesn't know yet, so it is seen.
  return { bucket: "failed", name, conclusion, url };
}

/** All of a commit's latest statuses. A page past the end has `statuses: null`. */
async function readStatuses(
  api: string,
  ref: PrRef,
  sha: string,
  opts: HttpOptions,
  // deno-lint-ignore no-explicit-any
): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  const statuses: any[] = [];
  let total: number | undefined;
  for (let page = 1; page <= MAX_STATUS_PAGES; page++) {
    const url = `${api}/repos/${ref.repo}/commits/${
      encodeURIComponent(sha)
    }/status?limit=${STATUS_PAGE_SIZE}&page=${page}`;
    const response = await requestWithHeaders(url, opts);
    // deno-lint-ignore no-explicit-any
    const body = response.body as any;
    const batch = Array.isArray(body?.statuses) ? body.statuses : [];
    statuses.push(...batch);
    // The body's total_count is only this page's length. The header is the real
    // total. Without one, page to the empty page: a short page proves nothing,
    // because a server can cap a page below the limit asked for.
    const header = response.headers.get("x-total-count");
    if (header !== null && Number.isInteger(Number(header))) {
      total = Number(header);
    }
    if (batch.length === 0) {
      if (page === 1 && body?.total_count > 0) {
        throw new Error("the status response is missing its statuses");
      }
      // An early end must not read as fewer checks.
      if (total !== undefined && statuses.length < total) {
        throw new Error("the status pages ended before their total");
      }
      return statuses;
    }
    if (total !== undefined && statuses.length >= total) return statuses;
  }
  throw new Error(`more than ${MAX_STATUS_PAGES} pages of statuses`);
}

async function readPr(
  api: string,
  web: string,
  ref: PrRef,
  opts: HttpOptions,
): Promise<Pr> {
  const pr = await requestJson(
    `${api}/repos/${ref.repo}/pulls/${ref.number}`,
    opts,
    // deno-lint-ignore no-explicit-any
  ) as any;
  const sha = pr?.head?.sha;
  const state = pr?.merged === true ? "merged" : pr?.state;
  if (
    pr?.number !== ref.number || typeof sha !== "string" || sha === "" ||
    (state !== "open" && state !== "merged" && state !== "closed")
  ) {
    throw new Error("the response is not this PR");
  }
  const statuses = await readStatuses(api, ref, sha, opts);
  return {
    repo: ref.repo,
    number: ref.number,
    url: String(pr.html_url ?? `${web}/${ref.repo}/pulls/${ref.number}`),
    state,
    draft: pr.draft === true,
    // Only a boolean here. False can also mean Forgejo is still checking.
    mergeable: state !== "open"
      ? "unknown"
      : pr.mergeable === true
      ? "mergeable"
      : pr.mergeable === false
      ? "conflicting"
      : "unknown",
    headSha: sha,
    mergeCommit: state === "merged" ? pr.merge_commit_sha ?? null : null,
    updatedAt: isoTime(pr.updated_at),
    checks: summarizeChecks(statuses.map((s) => toCheck(s, web))),
  };
}

/** A reader for one server: REST, two requests per PR, six PRs at a time. */
export function forgejoReader(baseUrl: string): PrReader {
  const web = baseUrl.replace(/\/+$/, "");
  const api = `${web}/api/v1`;
  return async (refs: PrRef[], opts: HttpOptions): Promise<PrResults> => {
    const results: PrResults = new Map();
    let rejected: TokenRejected | undefined;
    await mapBounded(refs, PR_CONCURRENCY, async (ref) => {
      if (rejected) return;
      try {
        results.set(ref.key, await readPr(api, web, ref, opts));
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) {
          rejected = new TokenRejected(
            opts.token
              ? "Forgejo rejected the token (HTTP 401)"
              : "this Forgejo server requires a token (HTTP 401)",
          );
        } else if (e instanceof HttpError && e.status === 404) {
          results.set(ref.key, {
            error: "not found, or not visible to this token",
          });
        } else {
          results.set(ref.key, { error: message(e) });
        }
      }
    });
    if (rejected) throw rejected;
    return results;
  };
}

// deno-lint-ignore no-explicit-any
type Ctx = any;

/** The `@skunk-ape/local-dev/forgejo` behavior type, with its one method, `pr_state`. */
export const behavior = {
  type: "@skunk-ape/local-dev/forgejo",
  version: "2026.11.06.1",
  globalArguments: GlobalArgsSchema,
  resources: prStateResources,
  methods: {
    pr_state: {
      description:
        "Read Forgejo PRs, across repositories, into one record: state, mergeability, and checks as counts plus only the failures. Failed reads are listed per PR.",
      arguments: PrStateArgs,
      execute: (args: { prs: string[] }, ctx: Ctx) =>
        runPrState(args, ctx, forgejoReader(ctx.globalArgs.baseUrl), {
          token: ctx.globalArgs.token,
          userAgent: ctx.globalArgs.userAgent,
          signal: ctx.signal,
        }),
    },
  },
};
