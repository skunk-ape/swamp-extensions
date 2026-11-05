/**
 * The digest against a fake Lab: the fixed shape, visible trimming, per-issue
 * failures, paging to the cursor, the cap, redirects, and the key.
 *
 * Run with: ~/.swamp/deno/deno test
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { behavior, buildDigest } from "./lab.ts";
import { type ClientOptions, type FetchLike, normalizeRow } from "./_lib/lab_client.ts";

type Raw = {
  number: number;
  updatedAt: string;
  status?: string;
  body?: string;
};

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

function row(r: Raw) {
  return {
    number: r.number,
    title: ` Issue ${r.number} `,
    status: r.status ?? "open",
    type: "bug",
    authorUsername: "someone",
    assignees: [],
    blocked: false,
    updatedAt: r.updatedAt,
  };
}

/** A Lab holding `issues`, served newest first, recording every URL it was asked for. */
function fakeLab(issues: Raw[], over: { detail?: (n: number) => Response | undefined } = {}) {
  const calls: string[] = [];
  const sorted = [...issues].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const fetchImpl: FetchLike = (input) => {
    const u = new URL(String(input));
    calls.push(u.pathname + u.search);
    if (u.pathname.endsWith("/lab/list")) {
      const statuses = u.searchParams.getAll("status");
      const offset = Number(u.searchParams.get("offset"));
      const limit = Number(u.searchParams.get("limit"));
      const page = sorted.filter((i) => statuses.includes(i.status ?? "open"))
        .slice(offset, offset + limit).map(row);
      return Promise.resolve(json({ issues: page, total: sorted.length }));
    }
    const n = Number(u.pathname.split("/").pop());
    const custom = over.detail?.(n);
    if (custom) return Promise.resolve(custom);
    const found = sorted.find((i) => i.number === n);
    if (!found) return Promise.resolve(json({ error: "not found" }, 404));
    return Promise.resolve(json({ issue: { ...row(found), body: found.body ?? "" } }));
  };
  return {
    calls,
    bodyCalls: () => calls.filter((c) => c.includes("/lab/issues/")),
    listCalls: () => calls.filter((c) => c.includes("/lab/list")),
    opts: { userAgent: "test", fetchImpl, sleep: () => Promise.resolve() } as ClientOptions,
  };
}

const T = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 3600_000).toISOString();
const NOW = () => new Date("2026-02-01T00:00:00.000Z");
const defaults = { bodyLimit: 2000 as number | null, maxIssues: 100 };

Deno.test("every issue has the fixed shape, whatever form assignees take", () => {
  const r = normalizeRow({
    number: 7,
    title: " t ",
    status: "open",
    type: "bug",
    authorUsername: "a",
    assignees: ["zed", { username: "amy" }, { name: "no-handle" }, null],
    blocked: true,
    updatedAt: T(1),
  });
  assertEquals(r, {
    number: 7,
    url: "https://swamp-club.com/lab/7",
    title: "t",
    status: "open",
    type: "bug",
    author: "a",
    assignees: ["amy", "zed"],
    blocked: true,
    updatedAt: T(1),
  });
  assertEquals(normalizeRow({ number: 8, assignees: "nope" })?.author, null);
  assertEquals(normalizeRow({ number: 8, assignees: "nope" })?.assignees, []);
  assertEquals(normalizeRow({ title: "no number" }), null);
});

Deno.test("no selector is an error, and so is a since that is not a time", async () => {
  const lab = fakeLab([]);
  await assertRejects(() => buildDigest({ ...defaults }, lab.opts), Error, "at least one");
  await assertRejects(
    () => buildDigest({ ...defaults, since: "yesterday" }, lab.opts),
    Error,
    "not a time",
  );
  assertEquals(lab.calls, []);
});

Deno.test("a trimmed body says so, with its original size and the way to get it whole", async () => {
  const lab = fakeLab([
    { number: 1, updatedAt: T(1), body: "é".repeat(50) },
    { number: 2, updatedAt: T(2), body: "short" },
  ]);
  const d = await buildDigest({ ...defaults, numbers: [1, 2], bodyLimit: 10 }, lab.opts);
  const [two, one] = d.issues;
  assertEquals(one.number, 1);
  assertEquals(one.body, "é".repeat(10));
  assertEquals(one.bodyBytes, 100);
  assertEquals(one.bodyTruncated, true);
  assertEquals(two.body, "short");
  assertEquals(two.bodyBytes, 5);
  assertEquals(two.bodyTruncated, false);
  assertEquals(d.fullBodyInput, { numbers: [1], bodyLimit: null, maxIssues: 100 });
  assertEquals(d.complete, true);
});

Deno.test("trimming never splits a surrogate pair", async () => {
  const lab = fakeLab([{ number: 1, updatedAt: T(1), body: "ab😀cd" }]);
  const d = await buildDigest({ ...defaults, numbers: [1], bodyLimit: 3 }, lab.opts);
  assertEquals(d.issues[0].body, "ab");
  assertEquals(d.issues[0].bodyTruncated, true);
});

Deno.test("bodyLimit null returns everything and no fullBodyInput", async () => {
  const body = "x".repeat(5000);
  const lab = fakeLab([{ number: 1, updatedAt: T(1), body }]);
  const d = await buildDigest({ ...defaults, numbers: [1], bodyLimit: null }, lab.opts);
  assertEquals(d.issues[0].body, body);
  assertEquals(d.issues[0].bodyTruncated, false);
  assertEquals(d.fullBodyInput, null);
});

Deno.test("bodyLimit 0 makes no body requests for listed issues, and says bodies were omitted", async () => {
  const lab = fakeLab([{ number: 1, updatedAt: T(1), body: "b" }, { number: 2, updatedAt: T(2) }]);
  const d = await buildDigest({ ...defaults, status: ["open"], bodyLimit: 0 }, lab.opts);
  assertEquals(lab.bodyCalls(), []);
  assertEquals(d.issues.map((i) => [i.number, i.body, i.bodyBytes, i.bodyTruncated]), [
    [2, null, null, true],
    [1, null, null, true],
  ]);
  assertEquals(d.fullBodyInput, { numbers: [2, 1], bodyLimit: null, maxIssues: 100 });
  assertEquals(d.complete, true);
});

Deno.test("bodyLimit 0 with numbers still reads each, and reports the size it saw", async () => {
  const lab = fakeLab([{ number: 1, updatedAt: T(1), body: "abc" }, { number: 2, updatedAt: T(2) }]);
  const d = await buildDigest({ ...defaults, numbers: [1, 2], bodyLimit: 0 }, lab.opts);
  assertEquals(lab.bodyCalls().length, 2);
  assertEquals(d.issues.map((i) => [i.number, i.body, i.bodyBytes, i.bodyTruncated]), [
    [2, "", 0, false],
    [1, null, 3, true],
  ]);
  assertEquals(d.fullBodyInput, { numbers: [1], bodyLimit: null, maxIssues: 100 });
});

Deno.test("one failed read lands in failures with the rest intact", async () => {
  const lab = fakeLab(
    [{ number: 1, updatedAt: T(1), body: "one" }, { number: 3, updatedAt: T(3), body: "three" }],
    { detail: (n) => n === 3 ? json({}, 500) : undefined },
  );
  const d = await buildDigest({ ...defaults, numbers: [1, 2, 3] }, lab.opts);
  assertEquals(d.issues.map((i) => i.number), [1]);
  assertEquals(d.failures, [{ number: 2, error: "HTTP 404" }, { number: 3, error: "HTTP 500" }]);
  assertEquals(d.complete, false);
  assertEquals(d.truncated, false);
});

Deno.test("a listed issue whose body read fails keeps its row and says the body is missing", async () => {
  const lab = fakeLab(
    [{ number: 1, updatedAt: T(1), body: "one" }, { number: 2, updatedAt: T(2), body: "two" }],
    { detail: (n) => n === 2 ? json({}, 500) : undefined },
  );
  const d = await buildDigest({ ...defaults, status: ["open"] }, lab.opts);
  assertEquals(d.issues.map((i) => [i.number, i.body, i.bodyBytes, i.bodyTruncated]), [
    [2, null, null, true],
    [1, "one", 3, false],
  ]);
  assertEquals(d.failures, [{ number: 2, error: "HTTP 500" }]);
  assertEquals(d.fullBodyInput, { numbers: [2], bodyLimit: null, maxIssues: 100 });
});

Deno.test("a failed list page is reported, and what was read is kept", async () => {
  const issues = Array.from({ length: 150 }, (_, i) => ({ number: i + 1, updatedAt: T(i) }));
  const lab = fakeLab(issues);
  const inner = lab.opts.fetchImpl!;
  const opts: ClientOptions = {
    ...lab.opts,
    fetchImpl: (input, init) =>
      String(input).includes("offset=100")
        ? Promise.resolve(json({}, 500))
        : inner(input, init),
  };
  const d = await buildDigest({ status: ["open"], bodyLimit: 0, maxIssues: 500 }, opts);
  assertEquals(d.issues.length, 100);
  assertEquals(d.failures, [{ number: null, error: "list at offset 100: HTTP 500" }]);
  assertEquals(d.complete, false);
});

Deno.test("since stops paging at the cursor and includes an issue exactly on it", async () => {
  const issues = Array.from({ length: 250 }, (_, i) => ({ number: i + 1, updatedAt: T(i) }));
  const lab = fakeLab(issues);
  const d = await buildDigest(
    { since: T(180), bodyLimit: 0, maxIssues: 500 },
    lab.opts,
    NOW,
  );
  assertEquals(d.issues.length, 70);
  assertEquals(d.issues.at(-1)?.number, 181);
  assertEquals(lab.listCalls().length, 1);
  assertEquals(d.asOf, "2026-01-31T23:55:00.000Z"); // five minutes of overlap
  assertEquals(d.complete, true);
  for (const s of ["open", "triaged", "in_progress", "shipped", "closed"]) {
    assert(lab.listCalls()[0].includes(`status=${s}`), `names ${s}`);
  }
  assert(lab.listCalls()[0].includes("sort=updated-desc"));
});

Deno.test("since pages as far as it must, and status narrows it", async () => {
  const issues = Array.from({ length: 250 }, (_, i) => ({
    number: i + 1,
    updatedAt: T(i),
    status: i % 2 ? "shipped" : "open",
  }));
  const lab = fakeLab(issues);
  const d = await buildDigest(
    { since: T(0), status: ["open"], bodyLimit: 0, maxIssues: 500 },
    lab.opts,
  );
  assertEquals(d.issues.length, 125);
  assert(d.issues.every((i) => i.status === "open"));
  assertEquals(lab.listCalls().length, 2);
});

Deno.test("maxIssues sets truncated and complete false, so a cursor is not moved past what was dropped", async () => {
  const issues = Array.from({ length: 10 }, (_, i) => ({ number: i + 1, updatedAt: T(i) }));
  const lab = fakeLab(issues);
  const d = await buildDigest({ status: ["open"], bodyLimit: 0, maxIssues: 3 }, lab.opts);
  assertEquals(d.issues.map((i) => i.number), [10, 9, 8]);
  assertEquals(d.truncated, true);
  assertEquals(d.complete, false);
});

Deno.test("exactly maxIssues issues is not truncated", async () => {
  const issues = Array.from({ length: 3 }, (_, i) => ({ number: i + 1, updatedAt: T(i) }));
  const lab = fakeLab(issues);
  const d = await buildDigest({ status: ["open"], bodyLimit: 0, maxIssues: 3 }, lab.opts);
  assertEquals(d.truncated, false);
  assertEquals(d.complete, true);
});

Deno.test("numbers beyond maxIssues are truncated", async () => {
  const lab = fakeLab([{ number: 1, updatedAt: T(1) }, { number: 2, updatedAt: T(2) }]);
  const d = await buildDigest({ numbers: [1, 2], bodyLimit: 2000, maxIssues: 1 }, lab.opts);
  assertEquals(d.issues.map((i) => i.number), [1]);
  assertEquals(d.truncated, true);
});

Deno.test("numbers and a selector combine without reading or counting an issue twice", async () => {
  const lab = fakeLab([
    { number: 1, updatedAt: T(1), body: "one", status: "closed" },
    { number: 2, updatedAt: T(2), body: "two" },
    { number: 3, updatedAt: T(3), body: "three" },
  ]);
  const d = await buildDigest({ numbers: [1, 3, 3], status: ["open"], bodyLimit: 2000, maxIssues: 3 }, lab.opts);
  assertEquals(d.issues.map((i) => i.number), [3, 2, 1]);
  assertEquals(lab.bodyCalls().length, 3);
  assertEquals(d.truncated, false);
});

Deno.test("a rejected key stops the run before any read, even though the Lab would answer", async () => {
  const seen: string[] = [];
  const opts: ClientOptions = {
    userAgent: "t",
    apiKey: "expired",
    sleep: () => Promise.resolve(),
    fetchImpl: (input) => {
      seen.push(String(input));
      return Promise.resolve(
        String(input).endsWith("/api/whoami") ? json({}, 401) : json({ issues: [], total: 0 }),
      );
    },
  };
  await assertRejects(
    () => buildDigest({ ...defaults, status: ["open"] }, opts),
    Error,
    "could not be confirmed: HTTP 401",
  );
  assertEquals(seen, ["https://swamp-club.com/api/whoami"]);
});

Deno.test("a redirect from whoami is refused too, so the key goes nowhere else", async () => {
  await assertRejects(
    () =>
      buildDigest({ ...defaults, numbers: [1] }, {
        userAgent: "t",
        apiKey: "k",
        fetchImpl: () =>
          Promise.resolve(new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })),
      }),
    Error,
    "refused a redirect",
  );
});

Deno.test("only a since read gives a cursor, and an incomplete one does not move it", async () => {
  const lab = fakeLab([{ number: 1, updatedAt: T(1), body: "b" }]);
  const byNumber = await buildDigest({ ...defaults, numbers: [1] }, lab.opts, NOW);
  assertEquals(byNumber.asOf, null);
  const byStatus = await buildDigest({ ...defaults, status: ["open"] }, lab.opts, NOW);
  assertEquals(byStatus.asOf, null);
  const incomplete = await buildDigest({ ...defaults, since: T(0), maxIssues: 1, numbers: [1, 9] }, lab.opts, NOW);
  assertEquals(incomplete.complete, false);
  assertEquals(incomplete.asOf, T(0));
});

Deno.test("a since read narrowed by status gives no cursor, so changes in other statuses aren't skipped", async () => {
  const lab = fakeLab([
    { number: 1, updatedAt: T(5), status: "open" },
    { number: 2, updatedAt: T(5), status: "shipped" },
  ]);
  const narrow = await buildDigest({ since: T(0), status: ["open"], bodyLimit: 0, maxIssues: 10 }, lab.opts, NOW);
  assertEquals(narrow.issues.map((i) => i.number), [1]);
  assertEquals(narrow.asOf, null);
  assertEquals(narrow.since, T(0));
  const wide = await buildDigest({ since: T(0), bodyLimit: 0, maxIssues: 10 }, lab.opts, NOW);
  assertEquals(wide.issues.map((i) => i.number), [2, 1]);
  assertEquals(wide.asOf, "2026-01-31T23:55:00.000Z");
});

Deno.test("a failed list page or body read holds the cursor at this read's since", async () => {
  const lab = fakeLab([{ number: 1, updatedAt: T(5), body: "b" }], {
    detail: () => json({}, 500),
  });
  const failedBody = await buildDigest({ ...defaults, since: T(0) }, lab.opts, NOW);
  assertEquals(failedBody.complete, false);
  assertEquals(failedBody.asOf, T(0));
  const failedList = await buildDigest({ ...defaults, since: T(0) }, {
    userAgent: "t",
    fetchImpl: () => Promise.resolve(json({}, 500)),
  }, NOW);
  assertEquals(failedList.failures, [{ number: null, error: "list at offset 0: HTTP 500" }]);
  assertEquals(failedList.asOf, T(0));
});

Deno.test("a status read reports the list changing under it", async () => {
  const page = Array.from({ length: 100 }, (_, i) => row({ number: i + 1, updatedAt: T(500 - i) }));
  const responses = [{ issues: page, total: 150 }, {
    issues: [row({ number: 200, updatedAt: T(1) })],
    total: 149,
  }];
  let n = 0;
  const d = await buildDigest({ status: ["open"], bodyLimit: 0, maxIssues: 500 }, {
    userAgent: "t",
    fetchImpl: () => Promise.resolve(json(responses[n++])),
  });
  assertEquals(d.complete, false);
  assertEquals(d.failures, [{
    number: null,
    error: "the list changed during the read (total 150, then 149), so an issue may be missing",
  }]);
  assertEquals(d.issues.length, 101);
});

Deno.test("a status read reports an unread issue updated mid-read: it jumps behind the reader and rows repeat", async () => {
  // 150 issues, newest first. After page 1, #140 is updated and moves to the top,
  // so #100 repeats at the start of page 2 and #140 is never seen.
  let list = Array.from({ length: 150 }, (_, i) => row({ number: i + 1, updatedAt: T(500 - i) }));
  let page = 0;
  const d = await buildDigest({ status: ["open"], bodyLimit: 0, maxIssues: 500 }, {
    userAgent: "t",
    fetchImpl: (input) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      const issues = list.slice(offset, offset + 100);
      if (page++ === 0) {
        const moved = list.find((r) => r.number === 140)!;
        list = [{ ...moved, updatedAt: T(900) }, ...list.filter((r) => r !== moved)];
      }
      return Promise.resolve(json({ issues, total: 150 }));
    },
  });
  assert(!d.issues.some((i) => i.number === 140));
  assertEquals(d.complete, false);
  assertEquals(d.failures, [{
    number: null,
    error: "the list changed during the read (#100 appeared twice), so an issue may be missing",
  }]);
});

Deno.test("a since read across all statuses tolerates a repeat, because its cursor sees the update next time", async () => {
  const page = Array.from({ length: 100 }, (_, i) => row({ number: i + 1, updatedAt: T(500 - i) }));
  const responses = [{ issues: page, total: 150 }, { issues: [page[99]], total: 150 }];
  let n = 0;
  const d = await buildDigest({ since: T(0), bodyLimit: 0, maxIssues: 500 }, {
    userAgent: "t",
    fetchImpl: () => Promise.resolve(json(responses[n++])),
  });
  assertEquals(d.failures, []);
  assertEquals(d.complete, true);
});

Deno.test("a since read reports a shrinking total, and holds its cursor: a row may have fallen between pages", async () => {
  const page = Array.from({ length: 100 }, (_, i) => row({ number: i + 1, updatedAt: T(500 - i) }));
  const responses = [{ issues: page, total: 150 }, {
    issues: [row({ number: 200, updatedAt: T(1) })],
    total: 149,
  }];
  let n = 0;
  const d = await buildDigest({ since: T(0), bodyLimit: 0, maxIssues: 500 }, {
    userAgent: "t",
    fetchImpl: () => Promise.resolve(json(responses[n++])),
  }, NOW);
  assertEquals(d.complete, false);
  assertEquals(d.asOf, T(0));
});

Deno.test("a detail response with no body field is a failed read, not an empty body", async () => {
  const d = await buildDigest({ numbers: [1], bodyLimit: 2000, maxIssues: 1 }, {
    userAgent: "t",
    fetchImpl: () => Promise.resolve(json({ issue: row({ number: 1, updatedAt: T(1) }) })),
  });
  assertEquals(d.failures, [{ number: 1, error: "the response has no body" }]);
});

Deno.test("across all statuses a growing total is not a failure: nothing can fall between pages", async () => {
  const page = Array.from({ length: 100 }, (_, i) => row({ number: i + 1, updatedAt: T(500 - i) }));
  const responses = [{ issues: page, total: 150 }, {
    issues: [row({ number: 200, updatedAt: T(1) })],
    total: 151,
  }];
  let n = 0;
  const d = await buildDigest({ since: T(0), bodyLimit: 0, maxIssues: 500 }, {
    userAgent: "t",
    fetchImpl: () => Promise.resolve(json(responses[n++])),
  });
  assertEquals(d.failures, []);
  assertEquals(d.complete, true);
});

Deno.test("an empty apiKey is refused rather than reading as no key", () => {
  const schema = behavior.globalArguments;
  assertEquals(schema.safeParse({ apiKey: "" }).success, false);
  assertEquals(schema.safeParse({}).success, true);
  assertEquals(schema.safeParse({ apiKey: "k" }).success, true);
});

Deno.test("cancelling during a real Retry-After wait stops at once", async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(new Error("cancelled")), 10);
  await assertRejects(
    () =>
      buildDigest({ numbers: [1], bodyLimit: 2000, maxIssues: 1 }, {
        userAgent: "t",
        signal: controller.signal,
        fetchImpl: () => Promise.resolve(new Response(null, { status: 429, headers: { "retry-after": "30" } })),
      }),
    Error,
    "cancelled",
  );
  assert(Date.now() - started < 5000);
});

Deno.test("cancelling during list paging stops rather than recording a failed page", async () => {
  const controller = new AbortController();
  await assertRejects(
    () =>
      buildDigest({ status: ["open"], bodyLimit: 0, maxIssues: 5 }, {
        userAgent: "t",
        signal: controller.signal,
        fetchImpl: () => {
          controller.abort(new Error("cancelled"));
          return Promise.reject(new Error("aborted"));
        },
      }),
    Error,
    "cancelled",
  );
});

Deno.test("a since read writes its own instance, so other reads can't replace its cursor", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const u = String(input);
    return Promise.resolve(
      u.includes("/lab/list")
        ? json({ issues: [row({ number: 1, updatedAt: T(1) })] })
        : json({ issue: { ...row({ number: 1, updatedAt: T(1) }), body: "b" } }),
    );
  }) as typeof fetch;
  try {
    const names: string[] = [];
    const ctx = {
      globalArgs: { userAgent: "t" },
      logger: { info: () => {}, warning: () => {} },
      writeResource: (spec: string, name: string) => {
        names.push(name);
        return Promise.resolve({ spec, name });
      },
    };
    await behavior.methods.issues.execute({ since: T(0), bodyLimit: 0, maxIssues: 5 }, ctx);
    await behavior.methods.issues.execute({ numbers: [1], bodyLimit: 2000, maxIssues: 5 }, ctx);
    await behavior.methods.issues.execute({ since: T(0), status: ["open"], bodyLimit: 0, maxIssues: 5 }, ctx);
    assertEquals(names, ["changes", "digest", "digest"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("a run that read nothing fails and writes nothing", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(json({}, 500))) as typeof fetch;
  try {
    let wrote = false;
    await assertRejects(
      () =>
        behavior.methods.issues.execute({ numbers: [1, 2], bodyLimit: 2000, maxIssues: 5 }, {
          globalArgs: { userAgent: "t" },
          logger: { info: () => {}, warning: () => {} },
          writeResource: () => {
            wrote = true;
            return Promise.resolve({});
          },
        }),
      Error,
      "Nothing could be read: 2 failure(s), first #1: HTTP 500",
    );
    assertEquals(wrote, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("nothing selected is a good read, not a failure", async () => {
  const lab = fakeLab([]);
  const d = await buildDigest({ ...defaults, status: ["open"] }, lab.opts);
  assertEquals(d.issues, []);
  assertEquals(d.complete, true);
});

Deno.test("each attempt gets its own timeout signal", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  let n = 0;
  await buildDigest({ numbers: [1], bodyLimit: 2000, maxIssues: 1 }, {
    userAgent: "t",
    sleep: () => Promise.resolve(),
    fetchImpl: (_input, init) => {
      signals.push(init?.signal);
      return Promise.resolve(n++ === 0 ? new Response(null, { status: 429 }) : json({}, 404));
    },
  });
  assertEquals(signals.length, 2);
  assert(signals[0] !== signals[1]);
});

Deno.test("fullBodyInput carries a maxIssues large enough to replay it", async () => {
  const issues = Array.from({ length: 150 }, (_, i) => ({ number: i + 1, updatedAt: T(i) }));
  const lab = fakeLab(issues);
  const d = await buildDigest({ status: ["open"], bodyLimit: 0, maxIssues: 500 }, lab.opts);
  assertEquals(d.fullBodyInput?.numbers.length, 150);
  assertEquals(d.fullBodyInput?.maxIssues, 150);
});

Deno.test("a list row with no valid number is reported and doesn't end paging early", async () => {
  const pages = [
    [...Array.from({ length: 99 }, (_, i) => row({ number: i + 1, updatedAt: T(500 - i) })), { title: "broken" }],
    [row({ number: 200, updatedAt: T(1) })],
  ];
  let page = 0;
  const d = await buildDigest({ status: ["open"], bodyLimit: 0, maxIssues: 500 }, {
    userAgent: "t",
    fetchImpl: () => Promise.resolve(json({ issues: pages[page++] })),
  });
  assertEquals(d.issues.length, 100);
  assertEquals(d.failures, [{ number: null, error: "list at offset 0: 1 row(s) had no valid number" }]);
  assertEquals(d.complete, false);
});

Deno.test("the page limit sets truncated", async () => {
  const full = Array.from({ length: 100 }, (_, i) => row({ number: i + 1, updatedAt: T(1) }));
  let pages = 0;
  const d = await buildDigest({ status: ["open"], bodyLimit: 0, maxIssues: 1000 }, {
    userAgent: "t",
    fetchImpl: () => {
      pages++;
      return Promise.resolve(json({ issues: full })); // a Lab that never runs out
    },
  });
  assertEquals(pages, 50);
  assertEquals(d.issues.length, 100);
  assertEquals(d.truncated, true);
});

Deno.test("cancelling a run stops it rather than recording failed reads", async () => {
  const controller = new AbortController();
  await assertRejects(() =>
    buildDigest({ numbers: [1, 2], bodyLimit: 2000, maxIssues: 5 }, {
      userAgent: "t",
      signal: controller.signal,
      fetchImpl: () => {
        controller.abort(new Error("cancelled"));
        return Promise.reject(new Error("aborted"));
      },
    })
  );
});

Deno.test("redirects are refused, not followed", async () => {
  const seen: string[] = [];
  const opts: ClientOptions = {
    userAgent: "t",
    fetchImpl: (input, init) => {
      seen.push(String(input));
      assertEquals(init?.redirect, "manual");
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
      );
    },
  };
  const d = await buildDigest({ numbers: [1], bodyLimit: 2000, maxIssues: 1 }, opts);
  assertEquals(seen.length, 1);
  assertEquals(d.failures, [{ number: 1, error: "refused a redirect (HTTP 302)" }]);
});

Deno.test("429 and 503 are retried, honoring Retry-After, then reported", async () => {
  const waits: number[] = [];
  let n = 0;
  const responses = [
    () => new Response(null, { status: 429, headers: { "retry-after": "2" } }),
    () => new Response(null, { status: 503 }),
    () => json({ issue: { ...row({ number: 1, updatedAt: T(1) }), body: "ok" } }),
  ];
  const d = await buildDigest({ numbers: [1], bodyLimit: 2000, maxIssues: 1 }, {
    userAgent: "t",
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    fetchImpl: () => Promise.resolve(responses[n++]()),
  });
  assertEquals(d.issues[0].body, "ok");
  assertEquals(waits, [2000, 2000]);

  let attempts = 0;
  const failed = await buildDigest({ numbers: [1], bodyLimit: 2000, maxIssues: 1 }, {
    userAgent: "t",
    sleep: () => Promise.resolve(),
    fetchImpl: () => {
      attempts++;
      return Promise.resolve(new Response(null, { status: 429 }));
    },
  });
  assertEquals(attempts, 4);
  assertEquals(failed.failures, [{ number: 1, error: "HTTP 429" }]);
});

Deno.test("a body that is not this issue, or not JSON, is a failure", async () => {
  const wrong = await buildDigest({ numbers: [1], bodyLimit: 2000, maxIssues: 1 }, {
    userAgent: "t",
    fetchImpl: () => Promise.resolve(json({ issue: row({ number: 2, updatedAt: T(1) }) })),
  });
  assertEquals(wrong.failures, [{ number: 1, error: "the response is not this issue" }]);
  const html = await buildDigest({ numbers: [1], bodyLimit: 2000, maxIssues: 1 }, {
    userAgent: "t",
    fetchImpl: () => Promise.resolve(new Response("<html>")),
  });
  assertEquals(html.failures, [{ number: 1, error: "the response was not JSON" }]);
});

Deno.test("the key is sent to the Lab and never reaches the record or the logs", async () => {
  const KEY = "swamp_secret_key_value";
  const realFetch = globalThis.fetch;
  const auth: (string | null)[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get("authorization"));
    const u = new URL(String(input));
    if (u.pathname === "/api/whoami") return Promise.resolve(json({ username: "me" }));
    if (u.pathname.endsWith("/issues/2")) return Promise.resolve(json({}, 500));
    return Promise.resolve(
      json({ issue: { ...row({ number: 1, updatedAt: T(1) }), body: "b" } }),
    );
  }) as typeof fetch;
  try {
    const logged: unknown[] = [];
    let written: unknown;
    const log = (...a: unknown[]) => logged.push(a);
    const result = await behavior.methods.issues.execute(
      { numbers: [1, 2], bodyLimit: 2000, maxIssues: 100 },
      {
        globalArgs: { apiKey: KEY, userAgent: "t" },
        logger: { info: log, warning: log },
        writeResource: (spec: string, name: string, data: unknown) => {
          written = data;
          return Promise.resolve({ spec, name });
        },
      },
    );
    assertEquals(result.dataHandles, [{ spec: "digest", name: "digest" }]);
    assertEquals(auth, [`Bearer ${KEY}`, `Bearer ${KEY}`, `Bearer ${KEY}`]);
    assert(!JSON.stringify(written).includes(KEY));
    assert(!JSON.stringify(logged).includes(KEY));
    assertEquals(behavior.resources.digest.schema.safeParse(written).success, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("without a key no Authorization header is sent", async () => {
  let header: string | null = "unset";
  await buildDigest({ numbers: [1], bodyLimit: 2000, maxIssues: 1 }, {
    userAgent: "t",
    fetchImpl: (_input, init) => {
      header = new Headers(init?.headers).get("authorization");
      return Promise.resolve(json({}, 404));
    },
  });
  assertEquals(header, null);
});
