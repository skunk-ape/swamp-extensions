/**
 * The Lab digest: classification, the diff against a baseline, every section,
 * the phone rules, and the API client against a fake server.
 *
 * Fixtures follow Apalone's Python suite (#900 Seth ships Stagecraft, #901
 * Paul ships datastore, #902 Zack opens a lock issue echoing #800, #700 an old
 * open gatorwalk issue) with invented titles.
 *
 * Run with: ~/.swamp/deno/deno test
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { classify, primaryArea } from "./_lib/classify.ts";
import { baselineOf, buildDigest, type DigestInput, keywords } from "./_lib/digest.ts";
import { fetchCorpus, type Issue, normalize } from "./_lib/lab.ts";
import { phrase, render, stripPrefix } from "./_lib/render.ts";

const NOW = "2026-01-15T13:00:00.000Z";
const SINCE = "2026-01-14T13:00:00.000Z";
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86400000).toISOString();
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3600000).toISOString();

function issue(over: Partial<Issue> & { number: number; title: string }): Issue {
  return {
    type: "bug",
    status: "open",
    author: "someone",
    assignees: [],
    blocked: false,
    childCount: 0,
    source: "swamp",
    createdAt: daysAgo(60),
    updatedAt: daysAgo(60),
    ...over,
  };
}

const TEAM = { "skunk-ape": "Seth", stack72: "Paul", zack: "Zack" };

const fixtures = (): Issue[] => [
  issue({ number: 700, title: "gatorwalk-factory loses a stage on resume", createdAt: daysAgo(30) }),
  issue({
    number: 800,
    title: "writer-lease fencing token drifts under concurrent datastore lock renewal",
    status: "shipped",
    createdAt: daysAgo(40),
    author: "stack72",
    assignees: ["stack72"],
  }),
  issue({
    number: 900,
    title: "stagecraft studio shows a stale work item",
    status: "shipped",
    author: "skunk-ape",
    assignees: ["skunk-ape"],
    createdAt: hoursAgo(10),
    updatedAt: hoursAgo(2),
  }),
  issue({
    number: 901,
    title: "s3-datastore sync drops a chunk on retry",
    status: "shipped",
    author: "outsider",
    assignees: ["stack72"],
    createdAt: daysAgo(5),
    updatedAt: hoursAgo(3),
  }),
  issue({
    number: 902,
    title: "fencing token drifts when writer-lease renewal races a lock",
    author: "zack",
    createdAt: hoursAgo(5),
    updatedAt: hoursAgo(5),
  }),
];

/** Baseline as of yesterday: 901 was in progress, 900 and 902 did not exist. */
function baselineYesterday(issues: Issue[]) {
  const b = baselineOf(issues.filter((i) => i.number < 900 || i.number === 901));
  b["901"] = { status: "in_progress", assignees: ["stack72"] };
  return b;
}

function input(over: Partial<DigestInput> = {}): DigestInput {
  const issues = fixtures();
  return {
    issues,
    baseline: baselineYesterday(issues),
    windowStart: SINCE,
    windowEnd: NOW,
    team: TEAM,
    me: "skunk-ape",
    widened: false,
    coverage: { total: 5, seen: 5, coverage: 1, ok: true, note: "" },
    ...over,
  };
}

// --- classification ------------------------------------------------------

Deno.test("gatorwalk-factory is Stagecraft", () => {
  assertEquals(primaryArea(classify("gatorwalk-factory drops a stage")), "stagecraft");
});

Deno.test("primary area follows rule order, not the alphabet", () => {
  // The Python digest filed this under "ci": tied at confidence 1.0, SQLite
  // returned the tags alphabetically. Stagecraft is rule 1.
  const areas = classify("stagecraft flaky test in ci");
  assertEquals(areas.map((a) => a.area).slice(0, 2), ["stagecraft", "ci"]);
  assertEquals(primaryArea(areas), "stagecraft");
});

Deno.test("no match is other; a body hit is half confidence", () => {
  assertEquals(classify("something odd"), [{ area: "other", label: "Other", confidence: 0 }]);
  assertEquals(classify("something odd", "the vault refused")[0], { area: "secrets", label: "Secrets & vault", confidence: 0.5 });
});

Deno.test("^docs only matches at the start of the title", () => {
  assertEquals(primaryArea(classify("docs: explain grants")), "docs");
  assert(!classify("update the docs").some((a) => a.area === "docs"));
});

// --- digest --------------------------------------------------------------

Deno.test("shipped is what became done since the baseline, credited to the assignee", () => {
  const d = buildDigest(input());
  assertEquals(d.shipped.total, 2);
  const seth = d.shipped.byPerson.find((p) => p.handle === "skunk-ape")!;
  assertEquals(seth.person, "Seth");
  assertEquals(seth.implemented, 1);
  const paul = d.shipped.byPerson.find((p) => p.handle === "stack72")!;
  // 901 was authored by an outsider and implemented by Paul: Paul shipped it.
  assertEquals(paul.items.map((i) => i.number), [901]);
  assertEquals(paul.items[0].basis, "assignee");
  // 800 shipped long ago: already done at the baseline, so not re-announced.
  assert(!d.shipped.byPerson.some((p) => p.items.some((i) => i.number === 800)));
});

Deno.test("an issue closed with no assignee is credited to its author, as author-only", () => {
  const issues = [...fixtures(), issue({ number: 903, title: "typo in banner", status: "closed", author: "zack", createdAt: daysAgo(3) })];
  const baseline = baselineYesterday(issues);
  baseline["903"] = { status: "open", assignees: [] };
  const d = buildDigest(input({ issues, baseline }));
  const zack = d.shipped.byPerson.find((p) => p.handle === "zack")!;
  assertEquals(zack.authoredOnly, 1);
  assertEquals(zack.implemented, 0);
});

Deno.test("assignees match by membership, not substring", () => {
  const issues = [
    ...fixtures(),
    issue({ number: 904, title: "a fix", status: "shipped", assignees: ["zack2"], createdAt: daysAgo(3) }),
  ];
  const baseline = baselineYesterday(issues);
  baseline["904"] = { status: "open", assignees: ["zack2"] };
  const d = buildDigest(input({ issues, baseline }));
  assertEquals(d.teamActivity.find((t) => t.handle === "zack")!.shipped, 0);
});

Deno.test("opened groups by primary area, other last", () => {
  const d = buildDigest(input());
  assertEquals(d.opened.total, 2);
  assert(d.opened.byArea.some((g) => g.area === "locks" && g.items[0].number === 902));
});

Deno.test("Stagecraft: new work makes it not quiet; old open items are listed with age", () => {
  const d = buildDigest(input());
  assertEquals(d.stagecraft.quiet, false);
  assertEquals(d.stagecraft.new.map((i) => i.number), [900]);
  assertEquals(d.stagecraft.openItems.map((i) => [i.number, i.ageDays]), [[700, 30]]);
});

Deno.test("Stagecraft is quiet, and still present, when nothing happened", () => {
  const issues = fixtures().filter((i) => i.number !== 900);
  const d = buildDigest(input({ issues }));
  assertEquals(d.stagecraft.quiet, true);
  assertStringIncludes(render(d, "UTC"), "## Stagecraft\n\nNothing new opened, nothing moved. Clean.");
});

Deno.test("a status change in Stagecraft is reported as moved", () => {
  const issues = fixtures().map((i) => i.number === 700 ? { ...i, status: "in_progress" } : i);
  const d = buildDigest(input({ issues }));
  assertEquals(d.stagecraft.moved.map((m) => [m.number, m.transition]), [[700, "open → in_progress"]]);
});

Deno.test("a new lock issue echoes the older one on rare shared terms", () => {
  const d = buildDigest(input());
  const e = d.echoes.find((x) => x.issue.number === 902)!;
  assert(e, "902 should echo 800");
  assertEquals(e.prior[0].number, 800);
  assert(e.prior[0].sharedTerms.includes("fencing"));
});

Deno.test("echoes skip excluded areas", () => {
  const issues = [
    ...fixtures(),
    issue({ number: 905, title: "docs: getting-started walkthrough skips the manual chapter", createdAt: daysAgo(20) }),
    issue({ number: 906, title: "docs: getting-started walkthrough skips the manual chapter again", createdAt: hoursAgo(1) }),
  ];
  const d = buildDigest(input({ issues }));
  assert(!d.echoes.some((e) => e.issue.number === 906));
});

Deno.test("new issues in my recent areas land near my work; mine do not", () => {
  const issues = [
    ...fixtures(),
    issue({ number: 910, title: "stagecraft factory validate is slow", author: "skunk-ape", createdAt: daysAgo(8) }),
    issue({ number: 911, title: "stagecraft tracker misses a stage", author: "outsider", createdAt: hoursAgo(4) }),
  ];
  const d = buildDigest(input({ issues }));
  assertEquals(d.mine.focusAreas, ["stagecraft"]);
  assertEquals(d.mine.connections.map((c) => c.issue.number), [911]);
});

Deno.test("issues gone from the corpus since the baseline are vanished, not counted", () => {
  const issues = fixtures().filter((i) => i.number !== 700);
  const baseline = baselineYesterday(fixtures());
  const d = buildDigest(input({ issues, baseline }));
  assertEquals(d.vanished, [700]);
});

Deno.test("first run: shipped falls back to last-updated inside the window", () => {
  const d = buildDigest(input({ baseline: null }));
  assertEquals(d.window.firstRun, true);
  assertEquals(d.shipped.total, 2);
});

Deno.test("team activity is in team order", () => {
  assertEquals(buildDigest(input()).teamActivity.map((t) => t.person), ["Seth", "Paul", "Zack"]);
});

// --- render --------------------------------------------------------------

Deno.test("render follows the phone rules", () => {
  const md = render(buildDigest(input()), "America/Chicago");
  for (const h of ["## Shipped", "## Stagecraft", "## Newly opened", "## Repeats"]) assertStringIncludes(md, h);
  assert(!md.includes("|"), "no tables");
  assert(!/\[#?\d+\]\(/.test(md), "no links on bare numbers");
  assert(!md.includes("skunk-ape") && !md.includes("stack72"), "names, not handles");
  assertStringIncludes(md, "https://swamp-club.com/lab/902");
});

Deno.test("dates are in the reader's timezone", () => {
  // 02:00 UTC on the 15th is the evening of the 14th in Chicago.
  const d = buildDigest(input({ windowEnd: "2026-01-15T02:00:00.000Z", windowStart: "2026-01-14T02:00:00.000Z" }));
  assertStringIncludes(render(d, "America/Chicago"), "## Lab — Wed 14 Jan");
});

Deno.test("a coverage gap leads, and says empty is unknown", () => {
  const d = buildDigest(input({ coverage: { total: 3000, seen: 500, coverage: 0.17, ok: false, note: "Saw 500 of 3000." } }));
  const md = render(d, "UTC");
  assertStringIncludes(md, "**Coverage gap:** Saw 500 of 3000.");
  assert(md.indexOf("Coverage gap") < md.indexOf("## Shipped"));
});

Deno.test("phrases drop a short prefix and cut at a word", () => {
  assertEquals(stripPrefix("serve: worker loses heartbeat"), "worker loses heartbeat");
  assertEquals(stripPrefix("A very long prefix that is not a tag at all: tail"), "A very long prefix that is not a tag at all: tail");
  assertEquals(phrase("word ".repeat(30), 20), "word word word word…");
});

Deno.test("keywords drop stopwords and short words", () => {
  assertEquals([...keywords("The swamp lock is racing the lease")].sort(), ["lease", "lock", "racing"]);
});

// --- API client ----------------------------------------------------------

Deno.test("normalize takes usernames from either assignee shape", () => {
  const i = normalize({ number: 5, title: " t ", assignees: [{ username: "b" }, "a"], blocked: true })!;
  assertEquals(i.assignees, ["a", "b"]);
  assertEquals(i.title, "t");
  assertEquals(normalize({ number: "x" }), null);
});

Deno.test("fetchCorpus names every status, pages, dedupes and measures coverage", async () => {
  const urls: string[] = [];
  const page = (from: number, n: number) => Array.from({ length: n }, (_, k) => ({ number: from + k, title: "t" }));
  const pages = [page(1, 500), [...page(500, 499), { number: 1, title: "dup" }]];
  const f = (u: string | URL) => {
    urls.push(String(u));
    const body = { total: 1000, issues: pages[urls.length - 1] ?? [] };
    return Promise.resolve(new Response(JSON.stringify(body)));
  };
  const c = await fetchCorpus({ userAgent: "t", fetchImpl: f });
  assertEquals(new URL(urls[0]).searchParams.getAll("status"), ["open", "triaged", "in_progress", "shipped", "closed"]);
  // The second page is full (499 + 1 duplicate), so a third, empty page ends it.
  assertEquals(c.pages, 3);
  assertEquals(c.duplicates, 2);
  assertEquals(c.issues.length, 998);
  assertEquals(c.coverage, 0.998);
});

Deno.test("fetchCorpus refuses a response with no issues array", async () => {
  const f = () => Promise.resolve(new Response(JSON.stringify({ items: [] })));
  let err = "";
  try {
    await fetchCorpus({ userAgent: "t", fetchImpl: f });
  } catch (e) {
    err = (e as Error).message;
  }
  assertStringIncludes(err, "API shape changed");
});
