/**
 * The journal page: dates, a vault's template and the built-in one, the
 * Lab-missing fallback, escaped titles, and the never-overwrite rule.
 *
 * Run with: ~/.swamp/deno/deno test --allow-env --allow-read --allow-write
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  addDays,
  DEFAULT_TEMPLATE,
  escapeTitle,
  heading,
  journalPath,
  type Lab,
  prRef,
  renderJournal,
  today,
} from "./_lib/journal.ts";
import { behavior } from "./lifeos_daily.ts";

const TZ = "America/New_York";

const lab = (over: Partial<Lab> = {}): Lab => ({
  generatedAt: new Date().toISOString(),
  window: {
    start: "2026-10-29T11:00:00Z",
    end: "2026-10-30T11:00:00Z",
    from: "baseline",
  },
  coverage: { ok: true, note: "" },
  shipped: [
    {
      number: 3868,
      title: "data spliced into shell runs is quoted like secrets",
      status: "shipped",
      prs: [{ repo: "swamp", number: 3467 }, {
        repo: "swamp-uat",
        number: 836,
      }],
    },
    { number: 4117, title: "survey harnesses", status: "closed", prs: [] },
  ],
  plate: [
    {
      number: 916,
      title: "wedged run",
      status: "open",
      since: "2026-10-19T13:30:03Z",
      sinceSource: "status",
    },
    {
      number: 4164,
      title: "cold open",
      status: "in_progress",
      since: "2026-10-30T13:40:00Z",
      sinceSource: "status",
    },
    {
      number: 1376,
      title: "swamp invite",
      status: "triaged",
      since: "2026-10-29T02:00:00Z",
      sinceSource: "updated",
    },
  ],
  ...over,
});

Deno.test("dates: heading, tomorrow across a month, path, today in a timezone", () => {
  assertEquals(heading("2026-10-30"), "Friday, October 30, 2026");
  assertEquals(addDays("2026-10-31", 1), "2026-11-01");
  assertEquals(
    journalPath("/v/journal/", "2026-11-02"),
    "/v/journal/2026/11/2026-11-02.md",
  );
  // 03:00Z on the 31st is still the 30th in New York.
  assertEquals(today(TZ, new Date("2026-10-31T03:00:00Z")), "2026-10-30");
});

// A vault's own layout, with every placeholder and a section of its own.
const TEMPLATE = [
  "# {{heading}}",
  "",
  "## Plan",
  "",
  "## Done",
  "",
  "{{shipped}}",
  "",
  "## Open",
  "",
  "{{plate}}",
  "",
  "## Review",
  "Written: {{tomorrow}} for {{date}}",
  "{{unknown}} stays as it is",
  "",
].join("\n");

Deno.test("page: a template's layout, shipped with PRs, plate by status", () => {
  const page = renderJournal("2026-10-30", lab(), TZ, TEMPLATE);
  const order = [
    "# Friday, October 30, 2026",
    "## Plan",
    "## Done\n\n- **swamp-club#3868",
    "## Open\n\n### In progress",
    "## Review\nWritten: 2026-10-31 for 2026-10-30",
    "{{unknown}} stays as it is",
  ];
  let at = -1;
  for (const s of order) {
    const i = page.indexOf(s);
    assert(i > at, `out of order or missing: ${s}`);
    at = i;
  }
  assertStringIncludes(
    page,
    "- **swamp-club#3868: data spliced into shell runs is quoted like secrets** — swamp#3467, swamp-uat#836",
  );
  assertStringIncludes(
    page,
    "- **swamp-club#4117: survey harnesses** *(closed)*\n",
  );
  assert(page.indexOf("### In progress") < page.indexOf("### Triaged"));
  assert(page.indexOf("### Triaged") < page.indexOf("### Open"));
  assertStringIncludes(
    page,
    "**swamp-club#916: wedged run** — since Oct 19 (11 days)",
  );
  assertStringIncludes(
    page,
    "**swamp-club#4164: cold open** — since Oct 30 (today)",
  );
  // 02:00Z on the 29th is the evening of the 28th in New York.
  assertStringIncludes(
    page,
    "**swamp-club#1376: swamp invite** — last updated Oct 28 (2 days)",
  );
  assert(!page.includes("Since "), "a normal one-day window needs no note");
});

Deno.test("page: with no template, the built-in page", () => {
  const page = renderJournal("2026-10-30", lab(), TZ);
  assertEquals(page, renderJournal("2026-10-30", lab(), TZ, DEFAULT_TEMPLATE));
  for (
    const s of [
      "# Friday, October 30, 2026",
      "## Shipped yesterday",
      "## On my plate",
      "## Notes",
    ]
  ) {
    assertStringIncludes(page, s);
  }
  assert(!page.includes("{{"), "every placeholder filled");
});

Deno.test("page: a long or first window and a coverage gap say so", () => {
  const page = renderJournal(
    "2026-11-02",
    lab({
      window: {
        start: "2026-10-30T11:00:00Z",
        end: "2026-11-02T12:00:00Z",
        from: "baseline",
      },
      coverage: { ok: false, note: "The corpus is 5 hours old." },
      shipped: [],
      plate: [],
    }),
    TZ,
  );
  assertStringIncludes(page, "*(Coverage gap: The corpus is 5 hours old.)*");
  assertStringIncludes(page, "*(Since Fri, Oct 30, 07:00.)*");
  assertStringIncludes(page, "- Nothing shipped or closed.");
  assertStringIncludes(page, "- Nothing open.");
});

Deno.test("page: no Lab record still makes the page", () => {
  const page = renderJournal("2026-11-02", null, TZ, TEMPLATE);
  assertStringIncludes(page, "# Monday, November 2, 2026");
  assertStringIncludes(page, "The Lab could not be read this morning");
  assertStringIncludes(page, "Written: 2026-11-03");
});

function ctx(written: unknown[], template = "") {
  return {
    globalArgs: { journalRoot: "", template, timezone: TZ, maxLabAgeHours: 3 },
    logger: { info() {}, warning() {} },
    writeResource: (_spec: string, _name: string, data: unknown) => {
      written.push(data);
      return Promise.resolve({ name: "journal" });
    },
  };
}

Deno.test("journal: writes a new file, then leaves it alone", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const out = `${dir}/sub/2026-10-30.md`;
    const written: Array<Record<string, unknown>> = [];
    const run = (l: unknown) =>
      behavior.methods.journal.execute({
        lab: l,
        date: "2026-10-30",
        output: out,
      }, ctx(written));

    await run(lab());
    assertEquals(written[0].reason, "written");
    assertEquals(written[0].labUsed, true);
    const first = await Deno.readTextFile(out);
    assertStringIncludes(first, "swamp-club#3868");

    await Deno.writeTextFile(out, "Someone started this.\n");
    await run(lab());
    assertEquals(written[1].reason, "exists");
    assertEquals(await Deno.readTextFile(out), "Someone started this.\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("journal: a record from an earlier run is not repeated", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const out = `${dir}/x.md`;
    const written: Array<Record<string, unknown>> = [];
    const stale = lab({
      generatedAt: new Date(Date.now() - 30 * 3600000).toISOString(),
    });
    await behavior.methods.journal.execute({
      lab: stale,
      date: "2026-11-02",
      output: out,
    }, ctx(written));
    assertEquals(written[0].labUsed, false);
    assert(!(await Deno.readTextFile(out)).includes("swamp-club#3868"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("journal: a vault template from a file, and a missing one fails", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const tpl = `${dir}/daily.md`;
    await Deno.writeTextFile(tpl, TEMPLATE);
    const written: Array<Record<string, unknown>> = [];
    const out = `${dir}/2026-10-30.md`;
    await behavior.methods.journal.execute({
      lab: lab(),
      date: "2026-10-30",
      output: out,
    }, ctx(written, tpl));
    assertStringIncludes(
      await Deno.readTextFile(out),
      "## Review\nWritten: 2026-10-31",
    );

    let failed = false;
    try {
      await behavior.methods.journal.execute(
        { lab: lab(), date: "2026-10-31", output: `${dir}/2026-10-31.md` },
        ctx(written, `${dir}/missing.md`),
      );
    } catch {
      failed = true;
    }
    assert(failed, "a named template that is missing fails the run");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("page: a Lab title cannot open HTML, links, tags or emphasis", () => {
  assertEquals(
    escapeTitle("CLI: swamp invite <email> to drive the platform-invite API"),
    "CLI: swamp invite \\<email\\> to drive the platform-invite API",
  );
  assertEquals(
    escapeTitle("[[x]] #tag **b** `c` $m$"),
    "\\[\\[x\\]\\] \\#tag \\*\\*b\\*\\* \\`c\\` \\$m\\$",
  );
  const page = renderJournal(
    "2026-11-03",
    lab({
      plate: [{
        number: 1376,
        title: "swamp invite <email>",
        status: "triaged",
        since: "2026-10-29T02:00:00Z",
        sinceSource: "updated",
      }],
    }),
    TZ,
  );
  assert(!page.includes("<email>"));
  assertStringIncludes(page, "## Notes");
  // A title is filled in after the template, so its own braces stay text.
  assertStringIncludes(
    renderJournal(
      "2026-11-03",
      lab({ plate: [{ ...lab().plate[0], title: "{{date}}" }] }),
      TZ,
    ),
    "\\{\\{date\\}\\}",
  );
});

Deno.test("page: a swamp-club PR is not mistaken for a Lab issue", () => {
  assertEquals(prRef({ repo: "swamp", number: 3467 }), "swamp#3467");
  assertEquals(
    prRef({ repo: "swamp-club", number: 1463 }),
    "swamp-club PR #1463",
  );
});
