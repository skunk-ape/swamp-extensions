// Model-surface tests. The engines are covered in _lib/lint_test.ts and
// _lib/normalize_test.ts; what is tested here is the layer swamp calls —
// argument resolution, resource names and shapes, and the referee-mode gate.
//
// `rewrite` is exercised only on the path that spawns nothing. Its loop guard
// is the branch worth testing without a model call; the generation step itself
// belongs to `claude -p`.

import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { model } from "./stef.ts";

// --- harness ---------------------------------------------------------------

interface Written {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

interface Logged {
  msg: string;
  props: Record<string, unknown>;
}

/** A ctx that records writes and logs instead of persisting them. */
function harness(opts: {
  globals?: Record<string, unknown>;
  stored?: Record<string, Record<string, unknown>>;
} = {}) {
  const writes: Written[] = [];
  const logs: Logged[] = [];
  const stored = opts.stored ?? {};
  return {
    writes,
    logs,
    ctx: {
      globalArgs: model.globalArguments.parse(opts.globals ?? {}),
      signal: new AbortController().signal,
      logger: {
        info: (msg: string, props?: Record<string, unknown>) => {
          logs.push({ msg, props: props ?? {} });
        },
      },
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ spec, name, data });
        stored[name] = data;
        return Promise.resolve({ name });
      },
      readResource: (name: string) => Promise.resolve(stored[name] ?? null),
    },
  };
}

// deno-lint-ignore no-explicit-any
type Method = { arguments: any; execute: (a: any, c: any) => Promise<any> };

/** Parse through the method's own schema, so defaults are under test too. */
function run(name: keyof typeof model.methods, input: unknown, h: ReturnType<typeof harness>) {
  const method = model.methods[name] as unknown as Method;
  return method.execute(method.arguments.parse(input), h.ctx);
}

const DIRTY = "It's a robust solution; you should leverage it, ensuring uptime.";
const CLEAN = "The worker retries the job. It writes one record.";

// --- argument resolution ---------------------------------------------------

Deno.test("readSource: text and path are mutually exclusive", async () => {
  const h = harness();
  await assertRejects(
    () => run("lint", { text: CLEAN, path: "README.md" }, h),
    Error,
    "not both",
  );
});

Deno.test("readSource: one of text or path is required", async () => {
  const h = harness();
  await assertRejects(() => run("lint", {}, h), Error, "is required");
});

Deno.test("readSource: path is read and named as the source", async () => {
  const file = await Deno.makeTempFile({ suffix: ".md" });
  await Deno.writeTextFile(file, CLEAN);
  try {
    const h = harness();
    await run("lint", { path: file }, h);
    assertEquals(h.writes[0].data.source, file);
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("readSource: inline text gets a placeholder source", async () => {
  const h = harness();
  await run("lint", { text: CLEAN }, h);
  assertEquals(h.writes[0].data.source, "<inline>");
});

// --- session naming --------------------------------------------------------

Deno.test("session defaults to latest across every method", async () => {
  for (const [method, spec] of [
    ["lint", "findings"],
    ["normalize", "normalized"],
    ["start", "session"],
  ] as const) {
    const h = harness();
    await run(method, { text: CLEAN }, h);
    assertEquals(h.writes[0].name, `${spec}-latest`, `${method} default name`);
    assertEquals(h.writes[0].spec, spec, `${method} spec name`);
  }
});

Deno.test("session names the slot, so two drafts never collide", async () => {
  const h = harness();
  await run("lint", { text: CLEAN, session: "readme" }, h);
  await run("lint", { text: DIRTY, session: "changelog" }, h);
  assertEquals(h.writes.map((w) => w.name), [
    "findings-readme",
    "findings-changelog",
  ]);
});

// --- lint ------------------------------------------------------------------

Deno.test("lint: clean prose writes a clean, non-blocking artifact", async () => {
  const h = harness();
  await run("lint", { text: CLEAN }, h);
  const d = h.writes[0].data;
  assertEquals(d.clean, true);
  assertEquals(d.blockingCount, 0);
});

Deno.test("lint: the recon entry is present, resolved, and never blocks", async () => {
  const h = harness();
  await run("lint", { text: CLEAN }, h);
  const findings = h.writes[0].data.findings as Array<Record<string, unknown>>;
  assertEquals(findings[0].id, "STE-0");
  assertEquals(findings[0].category, "recon");
  assertEquals(findings[0].resolved, true);
  assertEquals(findings[0].severity, "low");
});

Deno.test("lint: dirty prose blocks and every finding carries a located id", async () => {
  const h = harness();
  await run("lint", { text: DIRTY }, h);
  const d = h.writes[0].data;
  assertEquals(d.clean, false);
  assertEquals((d.blockingCount as number) > 0, true);
  for (const f of (d.findings as Array<Record<string, string>>).slice(1)) {
    assertStringIncludes(f.id, "STE-");
    assertStringIncludes(f.description, "line ");
  }
});

Deno.test("lint: textType picks the sentence limit, and maxWords overrides it", async () => {
  const h = harness();
  await run("lint", { text: CLEAN }, h);
  assertEquals(h.writes[0].data.maxWords, 25);
  assertEquals(h.writes[0].data.textType, "descriptive");

  await run("lint", { text: CLEAN, textType: "procedural" }, h);
  assertEquals(h.writes[1].data.maxWords, 20);

  await run("lint", { text: CLEAN, maxWords: 8 }, h);
  assertEquals(h.writes[2].data.maxWords, 8);
});

Deno.test("lint: severity config decides what blocks", async () => {
  const h = harness({ globals: { blocking: ["critical"] } });
  await run("lint", { text: DIRTY }, h);
  // Every check defaults to high, and only critical blocks here.
  assertEquals(h.writes[0].data.blockingCount, 0);
  assertEquals(h.writes[0].data.clean, true);
  assertEquals((h.writes[0].data.findings as unknown[]).length > 1, true);
});

// --- normalize -------------------------------------------------------------

Deno.test("normalize: reports its fixes and re-lints the fixed text", async () => {
  const h = harness();
  await run("normalize", { text: "Use a cache, e.g. Redis. It's ready." }, h);
  const d = h.writes[0].data;
  assertEquals((d.fixCount as number) > 0, true);
  assertEquals((d.fixes as unknown[]).length, d.fixCount);
  assertStringIncludes(d.text as string, "for example");
  assertStringIncludes(d.text as string, "It is ready");
});

Deno.test("normalize: leaves text the linter already accepts alone", async () => {
  const h = harness();
  await run("normalize", { text: CLEAN }, h);
  assertEquals(h.writes[0].data.text, CLEAN);
  assertEquals(h.writes[0].data.fixCount, 0);
  assertEquals(h.writes[0].data.clean, true);
});

// --- rewrite ---------------------------------------------------------------

Deno.test("rewrite: a draft that already passes spawns nothing", async () => {
  const h = harness();
  await run("rewrite", { text: CLEAN }, h);
  const d = h.writes[0].data;
  assertEquals(h.writes[0].name, "rewrite-latest");
  assertEquals(d.attempts, 0);
  assertEquals(d.clean, true);
  assertEquals(d.text, CLEAN);
});

Deno.test("rewrite: the mechanical pass alone can clear the loop", async () => {
  const h = harness();
  // Latin abbreviation and contraction are both mechanically fixable, so
  // normalizeFirst clears the findings before the loop guard is evaluated.
  await run("rewrite", { text: "Use a cache, e.g. Redis. It's ready." }, h);
  const d = h.writes[0].data;
  assertEquals(d.attempts, 0);
  assertEquals(d.clean, true);
  assertStringIncludes(d.text as string, "for example");
});

// --- referee mode: start ---------------------------------------------------

Deno.test("start: a dirty draft opens at attempt 0 and asks for a rework", async () => {
  const h = harness();
  await run("start", { text: DIRTY }, h);
  const d = h.writes[0].data;
  assertEquals(d.phase, "reworking");
  assertEquals(d.attempt, 0);
  assertEquals(d.maxAttempts, 3);
  assertStringIncludes(d.nextAction as string, "record");
});

Deno.test("start: a clean draft opens already done", async () => {
  const h = harness();
  await run("start", { text: CLEAN }, h);
  assertEquals(h.writes[0].data.phase, "clean");
  assertStringIncludes(h.writes[0].data.nextAction as string, "Done");
});

Deno.test("start: maxAttempts overrides the global cap", async () => {
  const h = harness();
  await run("start", { text: DIRTY, maxAttempts: 1 }, h);
  assertEquals(h.writes[0].data.maxAttempts, 1);
  // One attempt allowed and none used yet, so it is still reworking.
  assertEquals(h.writes[0].data.phase, "reworking");
});

Deno.test("start: normalizeFirst can be turned off", async () => {
  const dirty = "Use a cache, e.g. Redis.";
  const on = harness();
  await run("start", { text: dirty }, on);
  assertStringIncludes(on.writes[0].data.text as string, "for example");

  const off = harness({ globals: { normalizeFirst: false } });
  await run("start", { text: dirty }, off);
  assertEquals(off.writes[0].data.text, dirty);
});

// --- referee mode: record --------------------------------------------------

Deno.test("record: refuses a session that was never started", async () => {
  const h = harness();
  await assertRejects(
    () => run("record", { text: CLEAN, session: "ghost" }, h),
    Error,
    'No session "ghost"',
  );
});

Deno.test("record: counts the attempt and re-lints the submission", async () => {
  const stored: Record<string, Record<string, unknown>> = {};
  const h = harness({ stored });
  await run("start", { text: DIRTY }, h);
  await run("record", { text: DIRTY }, h);

  const d = h.writes[1].data;
  assertEquals(h.writes[1].name, "session-latest");
  assertEquals(d.attempt, 1);
  assertEquals(d.phase, "reworking");
  assertEquals(d.clean, false);
});

Deno.test("record: a clean submission closes the session", async () => {
  const stored: Record<string, Record<string, unknown>> = {};
  const h = harness({ stored });
  await run("start", { text: DIRTY }, h);
  await run("record", { text: CLEAN }, h);
  assertEquals(h.writes[1].data.phase, "clean");
  assertEquals(h.writes[1].data.text, CLEAN);
});

Deno.test("record: refuses to reopen a clean session", async () => {
  const stored: Record<string, Record<string, unknown>> = {};
  const h = harness({ stored });
  await run("start", { text: CLEAN }, h);
  await assertRejects(
    () => run("record", { text: CLEAN }, h),
    Error,
    "already clean",
  );
});

Deno.test("record: the cap is a real gate, not advice", async () => {
  const stored: Record<string, Record<string, unknown>> = {};
  const h = harness({ stored });
  await run("start", { text: DIRTY, maxAttempts: 1 }, h);
  // The one permitted attempt, still dirty, exhausts the session.
  await run("record", { text: DIRTY }, h);
  assertEquals(h.writes[1].data.phase, "exhausted");
  assertEquals(h.writes[1].data.attempt, 1);

  await assertRejects(
    () => run("record", { text: DIRTY }, h),
    Error,
    "is exhausted",
  );
});

Deno.test("record: the session owns source and textType, not the submission", async () => {
  const file = await Deno.makeTempFile({ suffix: ".md" });
  await Deno.writeTextFile(file, DIRTY);
  try {
    const stored: Record<string, Record<string, unknown>> = {};
    const h = harness({ stored });
    await run("start", { path: file, textType: "procedural" }, h);
    // Submitting from a different place must not rename the session source
    // or silently change the sentence limit it is judged against.
    await run("record", { text: DIRTY }, h);
    assertEquals(h.writes[1].data.source, file);
    assertEquals(h.writes[1].data.textType, "procedural");
    assertEquals(h.writes[1].data.maxWords, 20);
  } finally {
    await Deno.remove(file);
  }
});

// --- published contract ----------------------------------------------------

Deno.test("every method writes a resource the model declares", async () => {
  const specs = Object.keys(model.resources);
  const h = harness({ stored: {} });
  for (const method of ["lint", "normalize", "rewrite", "start"] as const) {
    await run(method, { text: CLEAN }, h);
  }
  for (const w of h.writes) {
    assertEquals(specs.includes(w.spec), true, `undeclared spec: ${w.spec}`);
  }
});

Deno.test("written artifacts validate against their declared schemas", async () => {
  const h = harness({ stored: {} });
  // Dirty text exercises the populated-findings shape. `rewrite` stays on
  // clean text so the loop never reaches for `claude`.
  for (const method of ["lint", "normalize", "start"] as const) {
    await run(method, { text: DIRTY }, h);
  }
  await run("rewrite", { text: CLEAN }, h);
  await run("record", { text: CLEAN }, h);

  assertEquals(h.writes.length, 5);
  for (const w of h.writes) {
    const spec = model.resources[w.spec as keyof typeof model.resources];
    spec.schema.parse(w.data);
  }
});

Deno.test("every method logs, and only through structured placeholders", async () => {
  for (const method of ["lint", "normalize", "rewrite", "start"] as const) {
    const h = harness({ stored: {} });
    await run(method, { text: CLEAN }, h);
    assertEquals(h.logs.length > 0, true, `${method} logged nothing`);
    for (const { msg, props } of h.logs) {
      // Every {placeholder} must have a matching structured property, and no
      // value may be interpolated into the message itself.
      for (const [, key] of msg.matchAll(/\{(\w+)\}/g)) {
        assertEquals(key in props, true, `${method}: {${key}} has no property`);
      }
    }
  }
});

Deno.test("record logs the attempt count and the phase it landed in", async () => {
  const h = harness({ stored: {} });
  await run("start", { text: DIRTY, maxAttempts: 1 }, h);
  const before = h.logs.length;
  await run("record", { text: DIRTY }, h);
  const after = h.logs.slice(before);
  assertEquals(after.length > 0, true);
  const last = after[after.length - 1];
  assertEquals(last.props.phase, "exhausted");
  assertEquals(last.props.attempt, 1);
  assertEquals(last.props.cap, 1);
});

Deno.test("model type and version are the published identifiers", () => {
  assertEquals(model.type, "@skunk-ape/stef");
  assertEquals(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(model.version), true);
});
