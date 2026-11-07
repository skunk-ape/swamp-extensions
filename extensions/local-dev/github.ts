/**
 * @skunk-ape/local-dev/github — GitHub pull requests in one call and one shape.
 *
 * `pr_state` reads a list of PRs, across repositories, into one record: state,
 * mergeability, and checks as counts plus only the failures. A failed read is
 * listed per PR, never dropped.
 *
 * Read-only: it sends queries to GraphQL and no mutations. Check names and links
 * are stored as data, for a reader to weigh, not to obey.
 */
import { z } from "npm:zod@4";
import {
  HttpError,
  type HttpOptions,
  message,
  requestJson,
} from "./_lib/http.ts";
import {
  absoluteLink,
  type Check,
  isoTime,
  type Pr,
  type PrRef,
  type PrResults,
  PrStateArgs,
  prStateResources,
  runPrState,
  shortError,
  summarizeChecks,
  TokenRejected,
  USER_AGENT,
} from "./_lib/pr_state.ts";

const GRAPHQL_URL = "https://api.github.com/graphql";
const WEB_URL = "https://github.com/";
const BATCH_SIZE = 20;
const MAX_CHECK_PAGES = 50;

const CONTEXT_FIELDS = `pageInfo{hasNextPage endCursor}
nodes{__typename
... on CheckRun{name status conclusion detailsUrl}
... on StatusContext{context state targetUrl}}`;

const PR_FIELDS = `number url state isDraft mergeable headRefOid updatedAt
mergeCommit{oid}
commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){${CONTEXT_FIELDS}}}}}}`;

const NEXT_CHECKS =
  `query($o:String!,$n:String!,$x:Int!,$c:String!){repository(owner:$o,name:$n){pullRequest(number:$x){
commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100,after:$c){${CONTEXT_FIELDS}}}}}}}}}`;

const SKIPPED_CONCLUSIONS = new Set(["NEUTRAL", "SKIPPED"]);

const GlobalArgsSchema = z.object({
  token: z.string().min(1).meta({ sensitive: true }).describe(
    "A GitHub token, from a vault. Required: GitHub's GraphQL API refuses requests without one.",
  ),
  userAgent: z.string().default(USER_AGENT),
});

// deno-lint-ignore no-explicit-any
function toCheck(node: any): Check {
  if (node?.__typename === "CheckRun") {
    const name = String(node.name ?? "unnamed check");
    const url = absoluteLink(node.detailsUrl, WEB_URL);
    if (node.status !== "COMPLETED") {
      return {
        bucket: "pending",
        name,
        conclusion: String(node.status ?? "pending").toLowerCase(),
        url,
      };
    }
    const conclusion = String(node.conclusion ?? "unknown");
    const lower = conclusion.toLowerCase();
    if (conclusion === "SUCCESS") {
      return { bucket: "passed", name, conclusion: lower, url };
    }
    if (SKIPPED_CONCLUSIONS.has(conclusion)) {
      return { bucket: "skipped", name, conclusion: lower, url };
    }
    // failure, timed_out, cancelled, action_required, startup_failure and stale,
    // and any word this doesn't know yet, so it is seen.
    return { bucket: "failed", name, conclusion: lower, url };
  }
  const name = String(node?.context ?? "unnamed check");
  const state = String(node?.state ?? "unknown");
  const url = absoluteLink(node?.targetUrl, WEB_URL);
  const conclusion = state.toLowerCase();
  if (state === "SUCCESS") return { bucket: "passed", name, conclusion, url };
  if (state === "PENDING" || state === "EXPECTED") {
    return { bucket: "pending", name, conclusion, url };
  }
  return { bucket: "failed", name, conclusion, url };
}

const RETRYABLE = (res: Response) =>
  res.status === 429 || res.status === 502 || res.status === 503 ||
  // GitHub's secondary rate limit answers 403 and says when to come back.
  (res.status === 403 && res.headers.has("retry-after"));

async function graphql(
  query: string,
  variables: unknown,
  opts: HttpOptions,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  try {
    return await requestJson(GRAPHQL_URL, opts, {
      method: "POST",
      body: JSON.stringify({ query, variables }),
      retryable: RETRYABLE,
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      throw new TokenRejected("GitHub rejected the token (HTTP 401)");
    }
    throw e;
  }
}

function batchQuery(refs: PrRef[]): { query: string; variables: unknown } {
  const declared: string[] = [];
  const selected: string[] = [];
  const variables: Record<string, unknown> = {};
  refs.forEach((ref, i) => {
    declared.push(`$o${i}:String!,$n${i}:String!,$x${i}:Int!`);
    selected.push(
      `p${i}:repository(owner:$o${i},name:$n${i}){pullRequest(number:$x${i}){...F}}`,
    );
    variables[`o${i}`] = ref.owner;
    variables[`n${i}`] = ref.name;
    variables[`x${i}`] = ref.number;
  });
  return {
    query: `query(${declared.join(",")}){${
      selected.join(" ")
    }} fragment F on PullRequest{${PR_FIELDS}}`,
    variables,
  };
}

// deno-lint-ignore no-explicit-any
function describeErrors(errors: any[]): string {
  const first = errors[0];
  if (first?.type === "NOT_FOUND") {
    return "not found, or not visible to this token";
  }
  return shortError(String(first?.message ?? first?.type ?? "GraphQL error"));
}

/** Reads the rest of a PR's checks, for one with more than a page of them. */
async function remainingChecks(
  ref: PrRef,
  oid: unknown,
  // deno-lint-ignore no-explicit-any
  firstPage: any,
  opts: HttpOptions,
  // deno-lint-ignore no-explicit-any
): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  const nodes: any[] = [];
  let pageInfo = firstPage?.pageInfo;
  for (let page = 0; pageInfo?.hasNextPage; page++) {
    if (page >= MAX_CHECK_PAGES) {
      throw new Error(`more than ${MAX_CHECK_PAGES} pages of checks`);
    }
    if (!pageInfo.endCursor) throw new Error("a page of checks has no cursor");
    const body = await graphql(NEXT_CHECKS, {
      o: ref.owner,
      n: ref.name,
      x: ref.number,
      c: pageInfo.endCursor,
    }, opts);
    if (Array.isArray(body?.errors) && body.errors.length) {
      throw new Error(describeErrors(body.errors));
    }
    const commit = body?.data?.repository?.pullRequest?.commits?.nodes?.[0]
      ?.commit;
    // Counts across two commits would describe neither.
    if (commit?.oid !== oid) throw new Error("the head moved during the read");
    const contexts = commit?.statusCheckRollup?.contexts;
    if (!contexts) throw new Error("a page of checks is missing");
    nodes.push(...contexts.nodes);
    pageInfo = contexts.pageInfo;
  }
  return nodes;
}

// deno-lint-ignore no-explicit-any
async function toPr(ref: PrRef, node: any, opts: HttpOptions): Promise<Pr> {
  const state = String(node.state ?? "").toLowerCase();
  if (
    node.number !== ref.number || typeof node.headRefOid !== "string" ||
    (state !== "open" && state !== "merged" && state !== "closed")
  ) {
    throw new Error("the response is not this PR");
  }
  const commit = node.commits?.nodes?.[0]?.commit;
  // A closed PR can really have no commits listed, and then no checks. An open or
  // merged one always has a head, so a missing commit there is missing data.
  if (commit ? commit.oid !== node.headRefOid : state !== "closed") {
    throw new Error("the checks are not for the head");
  }
  const contexts = commit?.statusCheckRollup?.contexts;
  const more = await remainingChecks(ref, commit?.oid, contexts, opts);
  const checks = [...(contexts?.nodes ?? []), ...more].filter((n) =>
    n !== null
  );
  return {
    repo: ref.repo,
    number: ref.number,
    url: String(node.url ?? `${WEB_URL}${ref.repo}/pull/${ref.number}`),
    state,
    draft: node.isDraft === true,
    mergeable: state !== "open"
      ? "unknown"
      : node.mergeable === "MERGEABLE"
      ? "mergeable"
      : node.mergeable === "CONFLICTING"
      ? "conflicting"
      : "unknown",
    headSha: node.headRefOid,
    mergeCommit: state === "merged" ? node.mergeCommit?.oid ?? null : null,
    updatedAt: isoTime(node.updatedAt),
    checks: summarizeChecks(checks.map(toCheck)),
  };
}

async function readBatch(
  refs: PrRef[],
  results: PrResults,
  opts: HttpOptions,
): Promise<void> {
  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    const { query, variables } = batchQuery(refs);
    body = await graphql(query, variables, opts);
  } catch (e) {
    if (e instanceof TokenRejected) throw e;
    for (const ref of refs) results.set(ref.key, { error: message(e) });
    return;
  }
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const aliases = new Set(refs.map((_, i) => `p${i}`));
  // deno-lint-ignore no-explicit-any
  const general = errors.filter((e: any) => !aliases.has(e?.path?.[0]));
  for (const [i, ref] of refs.entries()) {
    const alias = `p${i}`;
    // An error beside data can mean a part of it is null, and null checks would
    // read as "no checks", so anything GitHub flagged about this PR fails it.
    // deno-lint-ignore no-explicit-any
    const own = errors.filter((e: any) => e?.path?.[0] === alias);
    const node = body?.data?.[alias]?.pullRequest;
    if (own.length || general.length) {
      results.set(ref.key, {
        error: describeErrors(own.length ? own : general),
      });
    } else if (!node) {
      results.set(ref.key, { error: "the response has no such PR" });
    } else {
      try {
        results.set(ref.key, await toPr(ref, node, opts));
      } catch (e) {
        if (e instanceof TokenRejected) throw e;
        results.set(ref.key, { error: message(e) });
      }
    }
  }
}

/** Reads PRs through GraphQL, one request per 20, plus one per extra page of checks. */
export async function readGithub(
  refs: PrRef[],
  opts: HttpOptions,
): Promise<PrResults> {
  const results: PrResults = new Map();
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    await readBatch(refs.slice(i, i + BATCH_SIZE), results, opts);
  }
  return results;
}

// deno-lint-ignore no-explicit-any
type Ctx = any;

/** The `@skunk-ape/local-dev/github` behavior type, with its one method, `pr_state`. */
export const behavior = {
  type: "@skunk-ape/local-dev/github",
  version: "2026.11.06.1",
  globalArguments: GlobalArgsSchema,
  resources: prStateResources,
  methods: {
    pr_state: {
      description:
        "Read GitHub PRs, across repositories, into one record: state, mergeability, and checks as counts plus only the failures. Failed reads are listed per PR.",
      arguments: PrStateArgs,
      execute: (args: { prs: string[] }, ctx: Ctx) =>
        runPrState(args, ctx, readGithub, {
          token: ctx.globalArgs.token,
          userAgent: ctx.globalArgs.userAgent,
          signal: ctx.signal,
        }),
    },
  },
};
