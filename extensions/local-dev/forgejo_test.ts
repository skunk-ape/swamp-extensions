/**
 * `pr_state` against a fake Forgejo: statuses, paging, links, missing PRs,
 * retries, redirects and the token.
 *
 * Run with: ~/.swamp/deno/deno test
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { behavior, forgejoReader } from "./forgejo.ts";
import type { FetchLike, HttpOptions } from "./_lib/http.ts";
import { buildPrState, type PrState } from "./_lib/pr_state.ts";

const BASE = "https://forge.example";
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers });

const status = (context: string, s: string, target_url = "/o/r/actions/runs/1") => ({
  context,
  status: s,
  target_url,
});

// deno-lint-ignore no-explicit-any
type Node = any;

function prBody(number: number, over: Node = {}) {
  return {
    number,
    html_url: `${BASE}/o/r/pulls/${number}`,
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    head: { sha: `sha${number}` },
    merge_commit_sha: null,
    updated_at: "2026-11-06T12:00:00+01:00",
    ...over,
  };
}

/** A forge holding PRs by owner/repo#number, and statuses by head SHA. */
function fakeForgejo(
  prs: Record<string, Node>,
  statuses: Record<string, Node[]> = {},
  over: { respond?: (url: URL, n: number) => Response | undefined } = {},
) {
  const calls: { url: URL; headers: Headers; method?: string }[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers), method: init?.method });
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight--;
    const custom = over.respond?.(url, calls.length);
    if (custom) return custom;
    const pull = url.pathname.match(/^\/api\/v1\/repos\/(.+)\/pulls\/(\d+)$/);
    if (pull) {
      const pr = prs[`${pull[1]}#${pull[2]}`];
      return pr ? json(pr) : json({ message: "not found" }, 404);
    }
    const stat = url.pathname.match(/\/commits\/([^/]+)\/status$/);
    if (stat) {
      const all = statuses[stat[1]] ?? [];
      const limit = Number(url.searchParams.get("limit"));
      const page = Number(url.searchParams.get("page"));
      const slice = all.slice((page - 1) * limit, page * limit);
      // Past the end, as production answers: no statuses and no total.
      if (page > 1 && slice.length === 0) {
        return json({ state: "", statuses: null, total_count: 0 });
      }
      // As production answers: total_count is this page's length, and only the
      // header has the real total.
      return json(
        { state: "ignored", statuses: slice, total_count: slice.length },
        200,
        { "x-total-count": String(all.length) },
      );
    }
    return json({}, 500);
  };
  return {
    calls,
    peak: () => peak,
    opts: { userAgent: "test", fetchImpl, sleep: () => Promise.resolve() } as HttpOptions,
  };
}

const read = (prs: string[], opts: HttpOptions): Promise<PrState> =>
  buildPrState(prs, forgejoReader(BASE), opts);

Deno.test("each status lands in its bucket, whatever the forge's combined state says", async () => {
  const f = fakeForgejo({ "o/r#1": prBody(1) }, {
    sha1: [
      status("ok", "success"),
      status("fail", "failure"),
      status("err", "error"),
      status("warn", "warning"),
      status("new-word", "something_new"),
      status("wait", "pending"),
      status("skip", "skipped"),
    ],
  });
  const { prs: [pr] } = await read(["o/r#1"], f.opts);
  const { failures, ...counts } = pr.checks;
  assertEquals(counts, {
    state: "failing",
    total: 7,
    passed: 1,
    failed: 4,
    pending: 1,
    skipped: 1,
  });
  assertEquals(failures.map((c) => c.conclusion), ["failure", "error", "warning", "something_new"]);
});

Deno.test("links are made absolute, and anything but http and https is dropped", async () => {
  const f = fakeForgejo({ "o/r#1": prBody(1) }, {
    sha1: [
      status("relative", "failure", "/o/r/actions/runs/9"),
      status("absolute", "failure", "https://ci.example/9"),
      status("empty", "failure", ""),
      status("script", "failure", "javascript:alert(1)"),
    ],
  });
  const { prs: [pr] } = await read(["o/r#1"], f.opts);
  assertEquals(pr.checks.failures.map((c) => c.url), [
    `${BASE}/o/r/actions/runs/9`,
    "https://ci.example/9",
    null,
    null,
  ]);
});

Deno.test("no statuses is none", async () => {
  const f = fakeForgejo({ "o/r#1": prBody(1) });
  const { prs: [pr] } = await read(["o/r#1"], f.opts);
  assertEquals(pr.checks.state, "none");
  assertEquals(pr.checks.total, 0);
});

Deno.test("a failure past the first page of statuses is not lost", async () => {
  const many = Array.from({ length: 60 }, (_, i) => status(`c${i}`, "success"));
  many.push(status("late", "failure"));
  const f = fakeForgejo({ "o/r#1": prBody(1) }, { sha1: many });
  const { prs: [pr] } = await read(["o/r#1"], f.opts);
  assertEquals(pr.checks.total, 61);
  assertEquals(pr.checks.state, "failing");
  assertEquals(pr.checks.failures[0].name, "late");
  assertEquals(f.calls.filter((c) => c.url.pathname.endsWith("/status")).length, 2);
});

Deno.test("a full last page takes no extra request", async () => {
  const many = Array.from({ length: 50 }, (_, i) => status(`c${i}`, "success"));
  const f = fakeForgejo({ "o/r#1": prBody(1) }, { sha1: many });
  const { prs: [pr] } = await read(["o/r#1"], f.opts);
  assertEquals(pr.checks.total, 50);
  assertEquals(f.calls.length, 2);
});

Deno.test("with no total in the headers, it pages to the empty page", async () => {
  const pageOf = (page: number) => {
    const start = (page - 1) * 50;
    return Array.from({ length: 60 }, (_, i) => status(`c${i}`, i === 55 ? "failure" : "success"))
      .slice(start, start + 50);
  };
  const f = fakeForgejo({ "o/r#1": prBody(1) }, {}, {
    respond: (url) => {
      if (!url.pathname.endsWith("/status")) return undefined;
      const statuses = pageOf(Number(url.searchParams.get("page")));
      return json({ statuses: statuses.length ? statuses : null, total_count: statuses.length });
    },
  });
  const { prs: [pr] } = await read(["o/r#1"], f.opts);
  assertEquals(pr.checks.total, 60);
  assertEquals(pr.checks.failures.map((c) => c.name), ["c55"]);
});

Deno.test("a server capping pages below the limit still gives every status", async () => {
  const all = Array.from({ length: 25 }, (_, i) => status(`c${i}`, i === 24 ? "failure" : "success"));
  const f = fakeForgejo({ "o/r#1": prBody(1) }, {}, {
    respond: (url) => {
      if (!url.pathname.endsWith("/status")) return undefined;
      const start = (Number(url.searchParams.get("page")) - 1) * 10;
      const statuses = all.slice(start, start + 10);
      return json({ statuses, total_count: statuses.length }, 200, { "x-total-count": "25" });
    },
  });
  const { prs: [pr] } = await read(["o/r#1"], f.opts);
  assertEquals(pr.checks.total, 25);
  assertEquals(pr.checks.failed, 1);
});

Deno.test("status pages that end before their total fail that PR", async () => {
  const f = fakeForgejo({ "o/r#1": prBody(1), "o/r#2": prBody(2) }, {}, {
    respond: (url) => {
      if (!url.pathname.includes("/sha1/status")) return undefined;
      return url.searchParams.get("page") === "1"
        ? json(
          { statuses: Array.from({ length: 50 }, (_, i) => status(`c${i}`, "success")), total_count: 50 },
          200,
          { "x-total-count": "80" },
        )
        : json({ statuses: null, total_count: 0 });
    },
  });
  const state = await read(["o/r#1", "o/r#2"], f.opts);
  assertEquals(state.failures, [{ pr: "o/r#1", error: "the status pages ended before their total" }]);
  assertEquals(state.prs.map((p) => p.number), [2]);
});

Deno.test("a status that changes between pages fails that PR rather than losing another", async () => {
  const before = Array.from({ length: 60 }, (_, i) => status(`c${i}`, "success"));
  // c55 turns to failure after page 1, and moves to the top of the list. That
  // pushes c49 onto page 2, so a count alone would still match the total.
  const after = [status("c55", "failure"), ...before.filter((s) => s.context !== "c55")];
  const f = fakeForgejo({ "o/r#1": prBody(1), "o/r#2": prBody(2) }, {}, {
    respond: (url) => {
      if (!url.pathname.includes("/sha1/status")) return undefined;
      const page = Number(url.searchParams.get("page"));
      const statuses = (page === 1 ? before : after).slice((page - 1) * 50, page * 50);
      return json({ statuses, total_count: statuses.length }, 200, { "x-total-count": "60" });
    },
  });
  const state = await read(["o/r#1", "o/r#2"], f.opts);
  assertEquals(state.failures, [{ pr: "o/r#1", error: "the status list moved during the read" }]);
  assertEquals(state.prs.map((p) => p.number), [2]);
  assertEquals(state.complete, false);
});

Deno.test("a blank total in the headers is no total, so every page is still read", async () => {
  const all = Array.from({ length: 60 }, (_, i) => status(`c${i}`, i === 55 ? "failure" : "success"));
  const f = fakeForgejo({ "o/r#1": prBody(1) }, {}, {
    respond: (url) => {
      if (!url.pathname.endsWith("/status")) return undefined;
      const page = Number(url.searchParams.get("page"));
      const statuses = all.slice((page - 1) * 50, page * 50);
      return json(
        { statuses: statuses.length ? statuses : null, total_count: statuses.length },
        200,
        { "x-total-count": "" },
      );
    },
  });
  const { prs: [pr], complete } = await read(["o/r#1"], f.opts);
  assertEquals(pr.checks.total, 60);
  assertEquals(pr.checks.failures.map((c) => c.name), ["c55"]);
  assert(complete);
});

Deno.test("a status response that isn't a list fails that PR rather than reading as no checks", async () => {
  for (
    const body of [
      {},
      { statuses: "none" },
      { statuses: null },
      { statuses: null, total_count: 3 },
      { statuses: [], total_count: 3 },
    ]
  ) {
    const f = fakeForgejo({ "o/r#1": prBody(1) }, {}, {
      respond: (url) => url.pathname.endsWith("/status") ? json(body) : undefined,
    });
    const state = await read(["o/r#1"], f.opts);
    assertEquals(state.failures, [{ pr: "o/r#1", error: "the status response is missing its statuses" }]);
  }
});

Deno.test("null statuses with a count of zero is the real empty answer", async () => {
  // As production answers for a commit with no statuses, with no total header.
  const f = fakeForgejo({ "o/r#1": prBody(1) }, {}, {
    respond: (url) =>
      url.pathname.endsWith("/status") ? json({ state: "", statuses: null, total_count: 0 }) : undefined,
  });
  const { prs: [pr], complete } = await read(["o/r#1"], f.opts);
  assertEquals(pr.checks.state, "none");
  assert(complete);
});

Deno.test("a missing PR is listed beside the ones that were found", async () => {
  const f = fakeForgejo({ "o/r#1": prBody(1) });
  const state = await read(["o/r#404", "o/r#1"], f.opts);
  assertEquals(state.prs.map((p) => p.number), [1]);
  assertEquals(state.failures, [{ pr: "o/r#404", error: "not found, or not visible to this token" }]);
  assertEquals(state.complete, false);
});

Deno.test("a failed status read fails that PR rather than reading as no checks", async () => {
  const f = fakeForgejo({ "o/r#1": prBody(1) }, {}, {
    respond: (url) => url.pathname.endsWith("/status") ? json({}, 500) : undefined,
  });
  const state = await read(["o/r#1"], f.opts);
  assertEquals(state.failures, [{ pr: "o/r#1", error: "HTTP 500" }]);
});

Deno.test("merged, closed, draft and conflicting PRs say so", async () => {
  const f = fakeForgejo({
    "o/r#1": prBody(1, { state: "closed", merged: true, mergeable: true, merge_commit_sha: "m1" }),
    "o/r#2": prBody(2, { state: "closed", mergeable: false, merge_commit_sha: "stale" }),
    "o/r#3": prBody(3, { mergeable: false, draft: true }),
  });
  const { prs } = await read(["o/r#1", "o/r#2", "o/r#3"], f.opts);
  assertEquals(prs.map((p) => [p.state, p.mergeable, p.mergeCommit, p.draft]), [
    ["merged", "unknown", "m1", false],
    ["closed", "unknown", null, false],
    ["open", "conflicting", null, true],
  ]);
  assertEquals(prs[0].updatedAt, "2026-11-06T11:00:00.000Z");
});

Deno.test("each PR takes two requests, at most six PRs at a time", async () => {
  const prs: Record<string, Node> = {};
  const names: string[] = [];
  for (let n = 1; n <= 20; n++) {
    prs[`o/r#${n}`] = prBody(n);
    names.push(`o/r#${n}`);
  }
  const f = fakeForgejo(prs);
  const state = await read(names, f.opts);
  assertEquals(f.calls.length, 40);
  assert(f.peak() <= 6, `peak ${f.peak()}`);
  assertEquals(state.prs.map((p) => p.number), Array.from({ length: 20 }, (_, i) => i + 1));
});

Deno.test("a rate limit is retried", async () => {
  const f = fakeForgejo({ "o/r#1": prBody(1) }, {}, {
    respond: (_url, n) => n === 1 ? json({}, 429) : undefined,
  });
  const state = await read(["o/r#1"], f.opts);
  assert(state.complete);
  assertEquals(f.calls.length, 3);
});

Deno.test("a redirect is refused", async () => {
  const f = fakeForgejo({}, {}, {
    respond: () => new Response(null, { status: 301, headers: { location: "https://evil.example" } }),
  });
  const state = await read(["o/r#1"], { ...f.opts, token: "fj_secret" });
  assertEquals(f.calls.length, 1);
  assertStringIncludes(state.failures[0].error, "refused a redirect");
});

Deno.test("a rejected token fails the run", async () => {
  const f = fakeForgejo({}, {}, { respond: () => json({}, 401) });
  await assertRejects(
    () => read(["o/r#1"], { ...f.opts, token: "fj_secret" }),
    Error,
    "rejected the token",
  );
});

Deno.test("a server that requires a token says so", async () => {
  const f = fakeForgejo({}, {}, { respond: () => json({}, 401) });
  await assertRejects(() => read(["o/r#1"], f.opts), Error, "requires a token");
});

Deno.test("an invalid PR name is refused before any request", async () => {
  const f = fakeForgejo({});
  for (const bad of ["not-a-pr", "o/r", "o/r#0", "o/r#x", "../../x#1", "o/..#1", "a/b/c#1", "o r/x#1"]) {
    await assertRejects(() => read([bad], f.opts), Error, "Not owner/repo#number");
  }
  assertEquals(f.calls.length, 0);
});

Deno.test("no token, no Authorization header", async () => {
  const f = fakeForgejo({ "o/r#1": prBody(1) });
  await read(["o/r#1"], f.opts);
  assertEquals(f.calls[0].headers.get("authorization"), null);
  assertEquals(f.calls[0].method, "GET");
});

Deno.test("baseUrl must be https, and defaults to the Swamp Club forge", () => {
  const parse = behavior.globalArguments.safeParse;
  assert(!parse({ baseUrl: "http://forge.example" }).success);
  assert(!parse({ baseUrl: "not a url" }).success);
  assertEquals(parse({}).data?.baseUrl, "https://git.swamp-club.com");
});

Deno.test("a trailing slash on baseUrl changes nothing", async () => {
  const f = fakeForgejo({ "o/r#1": prBody(1) });
  await buildPrState(["o/r#1"], forgejoReader(`${BASE}/`), f.opts);
  assertEquals(f.calls[0].url.pathname, "/api/v1/repos/o/r/pulls/1");
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

function fakeCtx(token?: string) {
  const logs: string[] = [];
  const written: { name: string; instance: string; data: unknown }[] = [];
  const log = (m: string, p?: unknown) => logs.push(m + JSON.stringify(p ?? {}));
  return {
    logs,
    written,
    ctx: {
      globalArgs: { baseUrl: BASE, token, userAgent: "test" },
      logger: { info: log, warning: log },
      writeResource: (name: string, instance: string, data: unknown) => {
        written.push({ name, instance, data });
        return Promise.resolve({ name });
      },
    },
  };
}

Deno.test("the token goes on the request and into neither the record nor the logs", async () => {
  const f = fakeForgejo({ "o/r#1": prBody(1) });
  const c = fakeCtx("fj_secret");
  await withFetch(f.opts.fetchImpl!, async () => {
    await behavior.methods.pr_state.execute({ prs: ["o/r#1", "o/r#2"] }, c.ctx);
  });
  assertEquals(f.calls[0].headers.get("authorization"), "Bearer fj_secret");
  assertEquals(c.written[0].instance, "pr-state");
  assert(!JSON.stringify(c.written).includes("fj_secret"));
  assert(!c.logs.join("\n").includes("fj_secret"));
});

Deno.test("a run that read nothing fails and writes nothing", async () => {
  const f = fakeForgejo({});
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
