/**
 * `pr_state` against a fake GitHub: conclusions, paging past 100 checks, missing
 * PRs, batch failures, retries, redirects and the token.
 *
 * Run with: ~/.swamp/deno/deno test
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { behavior, readGithub } from "./github.ts";
import type { FetchLike, HttpOptions } from "./_lib/http.ts";
import { buildPrState, type Pr, type PrState } from "./_lib/pr_state.ts";

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers });

const run = (name: string, conclusion: string | null, status = "COMPLETED") => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
  detailsUrl: `https://ci.example/${name}`,
});

// deno-lint-ignore no-explicit-any
type Node = any;

function prNode(number: number, checks: Node[] | null, over: Node = {}, more?: Node) {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefOid: "abc",
    updatedAt: "2026-11-06T12:00:00Z",
    mergeCommit: null,
    commits: {
      nodes: [{
        commit: {
          oid: "abc",
          statusCheckRollup: checks === null ? null : {
            contexts: {
              pageInfo: more ?? { hasNextPage: false, endCursor: null },
              nodes: checks,
            },
          },
        },
      }],
    },
    ...over,
  };
}

/** Answers each alias from `prs`, by owner/repo#number, and pages from `pages`. */
function fakeGithub(
  prs: Record<string, Node>,
  over: { pages?: Record<string, Node>; respond?: (attempt: number) => Response | undefined } = {},
) {
  const requests: { query: string; variables: Record<string, unknown>; headers: Headers }[] = [];
  const fetchImpl: FetchLike = (_input, init) => {
    const { query, variables } = JSON.parse(String(init?.body));
    requests.push({ query, variables, headers: new Headers(init?.headers) });
    const custom = over.respond?.(requests.length);
    if (custom) return Promise.resolve(custom);
    if (typeof variables.c === "string") {
      return Promise.resolve(json({
        data: {
          repository: {
            pullRequest: { commits: { nodes: [{ commit: over.pages?.[variables.c] }] } },
          },
        },
      }));
    }
    const data: Record<string, unknown> = {};
    const errors: unknown[] = [];
    for (let i = 0; `o${i}` in variables; i++) {
      const key = `${variables[`o${i}`]}/${variables[`n${i}`]}#${variables[`x${i}`]}`;
      const node = prs[key];
      if (node) {
        data[`p${i}`] = { pullRequest: node };
      } else {
        data[`p${i}`] = { pullRequest: null };
        errors.push({ type: "NOT_FOUND", path: [`p${i}`, "pullRequest"], message: "nope" });
      }
    }
    return Promise.resolve(json(errors.length ? { data, errors } : { data }));
  };
  return {
    requests,
    opts: { userAgent: "test", token: "ghp_secret", fetchImpl, sleep: () => Promise.resolve() } as HttpOptions,
  };
}

const read = (prs: string[], opts: HttpOptions): Promise<PrState> =>
  buildPrState(prs, readGithub, opts);

Deno.test("every conclusion lands in its bucket, and only failures are listed", async () => {
  const f = fakeGithub({
    "o/r#1": prNode(1, [
      run("ok", "SUCCESS"),
      run("fail", "FAILURE"),
      run("timeout", "TIMED_OUT"),
      run("cancel", "CANCELLED"),
      run("action", "ACTION_REQUIRED"),
      run("startup", "STARTUP_FAILURE"),
      run("stale", "STALE"),
      run("new-word", "SOMETHING_NEW"),
      run("neutral", "NEUTRAL"),
      run("skip", "SKIPPED"),
      run("queued", null, "QUEUED"),
      run("running", null, "IN_PROGRESS"),
      { __typename: "StatusContext", context: "s-ok", state: "SUCCESS", targetUrl: null },
      { __typename: "StatusContext", context: "s-fail", state: "FAILURE", targetUrl: "https://ci.example/s" },
      { __typename: "StatusContext", context: "s-error", state: "ERROR", targetUrl: "" },
      { __typename: "StatusContext", context: "s-wait", state: "PENDING", targetUrl: null },
      { __typename: "StatusContext", context: "s-expected", state: "EXPECTED", targetUrl: null },
    ]),
  });
  const { prs: [pr] } = await read(["o/r#1"], f.opts);
  const { failures, ...counts } = pr.checks;
  assertEquals(counts, {
    state: "failing",
    total: 17,
    passed: 2,
    failed: 9,
    pending: 4,
    skipped: 2,
  });
  assertEquals(failures.map((c) => c.name), [
    "fail",
    "timeout",
    "cancel",
    "action",
    "startup",
    "stale",
    "new-word",
    "s-fail",
    "s-error",
  ]);
  assertEquals(failures[0], {
    name: "fail",
    conclusion: "failure",
    url: "https://ci.example/fail",
  });
  assertEquals(failures[8].url, null);
});

Deno.test("no checks is none, not passing", async () => {
  const f = fakeGithub({ "o/r#1": prNode(1, null) });
  const { prs: [pr] } = await read(["o/r#1"], f.opts);
  assertEquals(pr.checks, {
    state: "none",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    failures: [],
  });
});

Deno.test("unfinished checks are pending, and all passed is passing", async () => {
  const f = fakeGithub({
    "o/r#1": prNode(1, [run("a", "SUCCESS"), run("b", null, "QUEUED")]),
    "o/r#2": prNode(2, [run("a", "SUCCESS"), run("b", "SKIPPED")]),
  });
  const { prs } = await read(["o/r#1", "o/r#2"], f.opts);
  assertEquals(prs.map((p) => p.checks.state), ["pending", "passing"]);
});

Deno.test("a failure on the second page of checks is not lost", async () => {
  const first = Array.from({ length: 100 }, (_, i) => run(`c${i}`, "SUCCESS"));
  const f = fakeGithub({
    "o/r#1": prNode(1, first, {}, { hasNextPage: true, endCursor: "next" }),
  }, {
    pages: {
      next: {
        oid: "abc",
        statusCheckRollup: {
          contexts: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [run("late", "FAILURE"), run("c100", "SUCCESS")],
          },
        },
      },
    },
  });
  const { prs: [pr], complete } = await read(["o/r#1"], f.opts);
  assert(complete);
  assertEquals(pr.checks.total, 102);
  assertEquals(pr.checks.failed, 1);
  assertEquals(pr.checks.failures[0].name, "late");
  assertEquals(f.requests.length, 2);
});

Deno.test("a head that moves between pages of checks fails that PR, not the others", async () => {
  const f = fakeGithub({
    "o/r#1": prNode(1, [run("a", "SUCCESS")], {}, { hasNextPage: true, endCursor: "next" }),
    "o/r#2": prNode(2, [run("a", "SUCCESS")]),
  }, {
    pages: {
      next: {
        oid: "different",
        statusCheckRollup: {
          contexts: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    },
  });
  const state = await read(["o/r#1", "o/r#2"], f.opts);
  assertEquals(state.failures, [{ pr: "o/r#1", error: "the head moved during the read" }]);
  assertEquals(state.prs.map((p) => p.number), [2]);
  assertEquals(state.complete, false);
});

Deno.test("a missing PR is listed beside the ones that were found", async () => {
  const f = fakeGithub({ "o/r#1": prNode(1, []) });
  const state = await read(["o/r#404", "o/r#1"], f.opts);
  assertEquals(state.prs.map((p) => p.number), [1]);
  assertEquals(state.failures, [{
    pr: "o/r#404",
    error: "not found, or not visible to this token",
  }]);
  assertEquals(state.complete, false);
});

Deno.test("an error beside data fails the PR, because null checks would read as none", async () => {
  const f = fakeGithub({}, {
    respond: () =>
      json({
        data: { p0: { pullRequest: prNode(1, null) } },
        errors: [{
          type: "FORBIDDEN",
          path: ["p0", "pullRequest", "commits"],
          message: "Resource not accessible by personal access token",
        }],
      }),
  });
  const state = await read(["o/r#1"], f.opts);
  assertEquals(state.prs, []);
  assertEquals(state.failures, [{
    pr: "o/r#1",
    error: "Resource not accessible by personal access token",
  }]);
});

Deno.test("a batch failing as a whole lists every PR in it", async () => {
  const f = fakeGithub({}, { respond: () => json({ message: "boom" }, 500) });
  const state = await read(["o/r#1", "o/r#2"], f.opts);
  assertEquals(state.failures, [
    { pr: "o/r#1", error: "HTTP 500" },
    { pr: "o/r#2", error: "HTTP 500" },
  ]);
  assertEquals(state.complete, false);
});

Deno.test("an error with no path, such as a rate limit, fails the whole batch", async () => {
  const f = fakeGithub({}, {
    respond: () => json({ data: null, errors: [{ type: "RATE_LIMITED", message: "slow down" }] }),
  });
  const state = await read(["o/r#1", "o/r#2"], f.opts);
  assertEquals(state.failures.map((x) => x.error), ["slow down", "slow down"]);
});

Deno.test("PRs are batched at 20 per request, across repositories, in input order", async () => {
  const prs: Record<string, Node> = {};
  const names: string[] = [];
  for (let n = 1; n <= 45; n++) {
    const key = `o${n % 3}/r#${n}`;
    prs[key] = prNode(n, []);
    names.push(key);
  }
  const f = fakeGithub(prs);
  const state = await read(names, f.opts);
  assertEquals(f.requests.length, 3);
  assertEquals(state.prs.map((p) => p.number), Array.from({ length: 45 }, (_, i) => i + 1));
  assertEquals(state.prs[0].repo, "o1/r");
});

Deno.test("merged and closed PRs say so, and mergeability is unknown on both", async () => {
  const f = fakeGithub({
    "o/r#1": prNode(1, [], { state: "MERGED", mergeable: "MERGEABLE", mergeCommit: { oid: "m1" } }),
    "o/r#2": prNode(2, [], { state: "CLOSED", mergeable: "CONFLICTING" }),
    "o/r#3": prNode(3, [], { mergeable: "CONFLICTING", isDraft: true }),
    "o/r#4": prNode(4, [], { mergeable: "UNKNOWN" }),
  });
  const { prs } = await read(["o/r#1", "o/r#2", "o/r#3", "o/r#4"], f.opts);
  const pick = (p: Pr) => [p.state, p.mergeable, p.mergeCommit, p.draft];
  assertEquals(prs.map(pick), [
    ["merged", "unknown", "m1", false],
    ["closed", "unknown", null, false],
    ["open", "conflicting", null, true],
    ["open", "unknown", null, false],
  ]);
});

Deno.test("a rate limit is retried, including 403 with Retry-After", async () => {
  const waits: number[] = [];
  const f = fakeGithub({ "o/r#1": prNode(1, []) }, {
    respond: (n) =>
      n === 1
        ? json({}, 403, { "retry-after": "7" })
        : n === 2
        ? json({}, 429)
        : n === 3
        ? json({}, 502)
        : undefined,
  });
  f.opts.sleep = (ms) => {
    waits.push(ms);
    return Promise.resolve();
  };
  const state = await read(["o/r#1"], f.opts);
  assert(state.complete);
  assertEquals(f.requests.length, 4);
  assertEquals(waits[0], 7000);
});

Deno.test("a 403 with no Retry-After is not retried", async () => {
  const f = fakeGithub({}, { respond: () => json({}, 403) });
  const state = await read(["o/r#1"], f.opts);
  assertEquals(f.requests.length, 1);
  assertEquals(state.failures[0].error, "HTTP 403");
});

Deno.test("a redirect is refused", async () => {
  const f = fakeGithub({}, {
    respond: () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
  });
  const state = await read(["o/r#1"], f.opts);
  assertEquals(f.requests.length, 1);
  assertStringIncludes(state.failures[0].error, "refused a redirect");
});

Deno.test("a rejected token fails the run", async () => {
  const f = fakeGithub({}, { respond: () => json({}, 401) });
  await assertRejects(() => read(["o/r#1"], f.opts), Error, "rejected the token");
});

Deno.test("a rejected token on a later page of checks also fails the run", async () => {
  const f = fakeGithub({
    "o/r#1": prNode(1, [], {}, { hasNextPage: true, endCursor: "next" }),
  }, { respond: (n) => (n === 2 ? json({}, 401) : undefined) });
  await assertRejects(() => read(["o/r#1"], f.opts), Error, "rejected the token");
});

Deno.test("an invalid PR name is refused before any request", async () => {
  const f = fakeGithub({});
  await assertRejects(() => read(["o/r#1", "not-a-pr"], f.opts), Error, "not-a-pr");
  assertEquals(f.requests.length, 0);
});

Deno.test("names go as GraphQL variables, never into the query text", async () => {
  const f = fakeGithub({ "owner-x/repo.y#7": prNode(7, []) });
  await read(["owner-x/repo.y#7"], f.opts);
  assert(!f.requests[0].query.includes("owner-x"));
  assertEquals(f.requests[0].variables.o0, "owner-x");
});

Deno.test("every request is a query, never a mutation", async () => {
  const first = Array.from({ length: 100 }, (_, i) => run(`c${i}`, "SUCCESS"));
  const f = fakeGithub({
    "o/r#1": prNode(1, first, {}, { hasNextPage: true, endCursor: "next" }),
  }, {
    pages: {
      next: {
        oid: "abc",
        statusCheckRollup: {
          contexts: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      },
    },
  });
  await read(["o/r#1"], f.opts);
  assertEquals(f.requests.length, 2);
  for (const r of f.requests) assert(r.query.startsWith("query("));
});

Deno.test("the behavior requires a token", () => {
  assert(!behavior.globalArguments.safeParse({}).success);
  assert(behavior.globalArguments.safeParse({ token: "x" }).success);
});

async function withFetch(fetchImpl: FetchLike, work: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    await work();
  } finally {
    globalThis.fetch = original;
  }
}

function fakeCtx() {
  const logs: string[] = [];
  const written: { name: string; instance: string; data: unknown }[] = [];
  const log = (m: string, p?: unknown) => logs.push(m + JSON.stringify(p ?? {}));
  return {
    logs,
    written,
    ctx: {
      globalArgs: { token: "ghp_secret", userAgent: "test" },
      logger: { info: log, warning: log },
      writeResource: (name: string, instance: string, data: unknown) => {
        written.push({ name, instance, data });
        return Promise.resolve({ name });
      },
    },
  };
}

Deno.test("the token goes on the request and into neither the record nor the logs", async () => {
  const f = fakeGithub({ "o/r#1": prNode(1, []) });
  const c = fakeCtx();
  await withFetch(f.opts.fetchImpl!, async () => {
    await behavior.methods.pr_state.execute({ prs: ["o/r#1", "o/r#2"] }, c.ctx);
  });
  assertEquals(f.requests[0].headers.get("authorization"), "Bearer ghp_secret");
  assertEquals(c.written.length, 1);
  assertEquals(c.written[0].instance, "pr-state");
  assert(!JSON.stringify(c.written).includes("ghp_secret"));
  assert(!c.logs.join("\n").includes("ghp_secret"));
});

Deno.test("a run that read nothing fails and writes nothing", async () => {
  const f = fakeGithub({});
  const c = fakeCtx();
  await withFetch(f.opts.fetchImpl!, async () => {
    await assertRejects(
      () => behavior.methods.pr_state.execute({ prs: ["o/r#1"] }, c.ctx),
      Error,
      "Nothing could be read",
    );
  });
  assertEquals(c.written, []);
});

Deno.test("a cancelled run fails rather than reporting failed reads", async () => {
  const controller = new AbortController();
  const f = fakeGithub({}, {
    respond: () => {
      controller.abort(new Error("cancelled"));
      return json({}, 500);
    },
  });
  await assertRejects(
    () => read(["o/r#1"], { ...f.opts, signal: controller.signal }),
    Error,
    "cancelled",
  );
});
