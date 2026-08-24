import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildCases, runCases, sampleCases, spawnCheck } from "./verify.ts";
import { ReviewSchema, wrapperName } from "./review.ts";
import type { Review } from "./review.ts";
import { REFUSED_EXIT, renderWrapper } from "./wrapper.ts";

function review(extra: Record<string, unknown> = {}): Review {
  return ReviewSchema.parse({
    cli: "demo",
    binary: "/bin/echo",
    wrappers: [
      {
        segment: "help",
        name: "demo",
        append: ["--help"],
        accepts: "path-only",
      },
      { segment: "safe", name: "demo", admits: { maxTier: "read-safe" } },
      { segment: "write", name: "demo", admits: { maxTier: "modify" } },
    ],
    commands: [
      {
        path: ["list"],
        tier: "read-safe",
        why: "reads",
        options: {
          "--limit": { arity: 1 },
          "--exec": { arity: 1, tier: "escape" },
        },
      },
      { path: ["delete"], tier: "modify", why: "writes" },
    ],
    ...extra,
  });
}

// --- the matrix ----------------------------------------------------------

Deno.test("every command is expected to pass its own tier's wrapper", () => {
  const cases = buildCases(review());
  const own = cases.find((c) =>
    c.wrapper === "fka-safe-demo" && c.argv.join(" ") === "list" &&
    c.expect === "permit"
  );
  assert(own, "safe-demo should be expected to permit list");
});

Deno.test("a command above a wrapper's tier is expected to be refused by it", () => {
  const cases = buildCases(review());
  const above = cases.find((c) =>
    c.wrapper === "fka-safe-demo" && c.argv.join(" ") === "delete"
  );
  assertEquals(above?.expect, "refuse");
  assertStringIncludes(above?.about ?? "", "outside fka-safe-demo");
});

Deno.test("an option above the tier gets its own refusal case", () => {
  const cases = buildCases(review());
  const escape = cases.find((c) =>
    c.wrapper === "fka-safe-demo" && c.argv.includes("--exec")
  );
  assertEquals(escape?.expect, "refuse");
});

Deno.test("a pattern-constrained option is asserted by what it must refuse", () => {
  const r = review({
    commands: [{
      path: ["list"],
      tier: "read-safe",
      why: "reads",
      options: { "--limit": { arity: 1, valuePattern: "\\d+" } },
    }],
  });
  const cases = buildCases(r);
  // Matched by prefix rather than equality: the attached spelling is the token
  // `--limit=…`, which an exact match would silently drop.
  const mine = cases.filter((c) =>
    c.wrapper === "fka-safe-demo" &&
    c.argv.some((a) => a === "--limit" || a.startsWith("--limit="))
  );

  // No permit case: a value that satisfies an arbitrary pattern cannot be
  // invented here, and asserting a permit with a made-up token would fail for
  // the pattern rather than for the rule under test.
  assert(!mine.some((c) => c.expect === "permit"));

  // A refusal is a different matter, and it is the half that was missing. A
  // value the pattern cannot match makes the refusal mean the pattern and
  // nothing else, which is what leaves a constrained option exercised rather
  // than skipped.
  const separated = mine.find((c) =>
    c.argv.some((a) => a === "--limit") && c.expect === "refuse"
  );
  assertEquals(separated?.expect, "refuse");
  assert(separated?.argv.some((a) => !/^\d+$/.test(a) && a !== "--limit"));

  // The attached spelling is a separate branch in the parser and gets its own
  // case, because `--limit=x` and `--limit x` reaching the same verdict is an
  // assumption rather than an observation.
  assert(
    mine.some((c) =>
      c.expect === "refuse" && c.argv.some((a) => a.startsWith("--limit="))
    ),
  );
  // The path-only alias is a different question and does assert it: there the
  // refusal is the point, not an ambiguity.
  assert(
    cases.some((c) =>
      c.wrapper === "fka-help-demo" && c.argv.includes("--limit") &&
      c.expect === "refuse"
    ),
  );
});

// --- argument syntax -----------------------------------------------------
//
// The command-and-option sweep builds one shape of argument vector, so it can
// be entirely green while the parser mishandles every other shape. These are
// the shapes, and each assertion below was a case the matrix did not contain.

Deno.test("the matrix exercises -- rather than assuming it", () => {
  const cases = buildCases(review()).filter((c) =>
    c.wrapper === "fka-safe-demo" && c.argv.includes("--")
  );
  assert(cases.length > 0, "no case exercises --");
  // `list` takes no positional, so everything after -- is refused however it
  // is spelled. The option-shaped one is the case worth having: it is the
  // difference between checking options and checking arguments.
  assert(cases.every((c) => c.expect === "refuse"));
  assert(
    cases.some((c) => c.argv.some((a) => a.startsWith("--") && a !== "--")),
    "no case puts an option-shaped token after --",
  );
});

Deno.test("the matrix exercises a positional where the table permits none", () => {
  const cases = buildCases(review()).filter((c) =>
    c.wrapper === "fka-safe-demo" &&
    c.argv.some((a) => a.includes("not-a-subcommand")) && !c.argv.includes("--")
  );
  assert(cases.length > 0, "no bare positional case");
  assert(cases.every((c) => c.expect === "refuse"));
});

Deno.test("a permitted positional is asserted where the table allows one", () => {
  const r = review({
    commands: [{
      path: ["list"],
      tier: "read-safe",
      why: "reads",
      positionals: "any",
      options: {},
    }],
  });
  const cases = buildCases(r).filter((c) =>
    c.wrapper === "fka-safe-demo" &&
    c.argv.some((a) => a.includes("not-a-subcommand"))
  );
  assert(cases.length > 0);
  assert(cases.every((c) => c.expect === "permit"));
});

Deno.test("a positional cap is asserted by exceeding it", () => {
  const r = review({
    commands: [{
      path: ["list"],
      tier: "read-safe",
      why: "reads",
      positionals: "any",
      maxPositionals: 2,
      options: {},
    }],
  });
  const over = buildCases(r).find((c) =>
    c.wrapper === "fka-safe-demo" &&
    c.argv.filter((a) => a.includes("not-a-subcommand")).length === 3
  );
  assertEquals(over?.expect, "refuse");
});

Deno.test("the attached spelling of an option is asserted separately", () => {
  // `--limit=x` and `--limit x` are different branches in the parser, and the
  // table cannot say whether they agree.
  const attached = buildCases(review()).find((c) =>
    c.wrapper === "fka-safe-demo" && c.argv.includes("--limit=value")
  );
  assertEquals(attached?.expect, "permit");
});

Deno.test("a flag refuses an attached value but accepts a negation", () => {
  const r = review({
    commands: [{
      path: ["list"],
      tier: "read-safe",
      why: "reads",
      options: { "--quiet": { arity: 0 } },
    }],
  });
  const cases = buildCases(r).filter((c) => c.wrapper === "fka-safe-demo");
  assertEquals(
    cases.find((c) => c.argv.includes("--quiet=false"))?.expect,
    "permit",
  );
  assert(
    cases.some((c) =>
      c.expect === "refuse" &&
      c.argv.some((a) => a.startsWith("--quiet=") && a !== "--quiet=false")
    ),
  );
});

Deno.test("an option-shaped value is asserted to be refused, not guessed", () => {
  const refused = buildCases(review()).find((c) =>
    c.wrapper === "fka-safe-demo" && c.argv.includes("--limit") &&
    c.argv.includes("--not-a-value")
  );
  assertEquals(refused?.expect, "refuse");
});

Deno.test("short clusters are asserted in both directions", () => {
  const r = review({
    commands: [{
      path: ["list"],
      tier: "read-safe",
      why: "reads",
      options: { "-a": { arity: 0 }, "-b": { arity: 0 } },
    }],
  });
  const cases = buildCases(r).filter((c) => c.wrapper === "fka-safe-demo");
  // A cluster of permitted flags is one token the parser has to take apart.
  assertEquals(cases.find((c) => c.argv.includes("-ab"))?.expect, "permit");
  // And a cluster carrying one unpermitted character is the bypass direction:
  // reading `-ac` as `-a` and stopping would let `c` through unexamined.
  assert(
    cases.some((c) =>
      c.expect === "refuse" &&
      c.argv.some((a) => /^-a[a-z]$/.test(a) && a !== "-ab")
    ),
  );
});

Deno.test("the bare tool name is expected to be refused", () => {
  const cases = buildCases(review());
  const bare = cases.find((c) =>
    c.wrapper === "fka-safe-demo" && c.argv.length === 0
  );
  assertEquals(bare?.expect, "refuse");
});

Deno.test("no cases are built for a tier that was not emitted", () => {
  const cases = buildCases(review({
    wrappers: [{
      segment: "safe",
      name: "demo",
      admits: { maxTier: "read-safe" },
    }],
  }));
  assert(cases.every((c) => c.wrapper === "fka-safe-demo"));
});

// --- running the matrix --------------------------------------------------

Deno.test("a coherent table passes every case", () => {
  const results = runCases(review(), buildCases(review()));
  const failures = results.filter((r) => !r.ok);
  assertEquals(
    failures.map((f) => `${f.wrapper} ${f.argv.join(" ")}: ${f.about}`),
    [],
  );
});

Deno.test("a table that lets a write command into the safe wrapper fails", () => {
  const honest = review();
  const cases = buildCases(honest);
  // Same cases, but the table now claims the destructive command is safe. The
  // expectations were built from the honest table, so the lie has to surface.
  const lying = review({
    commands: [
      { path: ["list"], tier: "read-safe", why: "reads", options: {} },
      { path: ["delete"], tier: "read-safe", why: "lied about", options: {} },
    ],
  });
  const failures = runCases(lying, cases).filter((r) => !r.ok);
  assert(
    failures.some((f) => f.argv.join(" ") === "delete" && f.got === "permit"),
  );
});

// --- sampling ------------------------------------------------------------

Deno.test("every wrapper gets at least one spawned case, refusal first", () => {
  const results = runCases(review(), buildCases(review()));
  const picked = sampleCases(results, 1);
  assertEquals(new Set(picked.map((p) => p.wrapper)).size, 3);
  assert(picked.every((p) => p.expect === "refuse"));
});

Deno.test("a larger budget buys permits as well as refusals", () => {
  const results = runCases(review(), buildCases(review()));
  const picked = sampleCases(results, 4).filter((p) =>
    p.wrapper === "fka-safe-demo"
  );
  assert(picked.some((p) => p.expect === "permit"));
  assert(picked.some((p) => p.expect === "refuse"));
  assert(picked.length <= 4);
});

// --- end to end ----------------------------------------------------------

/**
 * The only test that runs a generated wrapper as a program.
 *
 * `/bin/echo` stands in for the wrapped tool so that "permitted" can be
 * observed for real — the wrapper actually spawns it — without any command in
 * the suite doing something. Everything else runs in check mode, which never
 * execs at all.
 */
Deno.test("generated wrappers enforce the table when run as programs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "fka-" });
  try {
    const source = await Deno.readTextFile(
      new URL("./validate.ts", import.meta.url),
    );
    const r = review();

    for (const spec of r.wrappers) {
      const path = `${dir}/${wrapperName(r.prefix, spec.segment, spec.name)}`;
      await Deno.writeTextFile(
        path,
        renderWrapper(r, spec, source, Deno.execPath()),
      );
      await Deno.chmod(path, 0o755);
    }

    // Every case, spawned. The in-process sweep already agreed; this asks
    // whether the script on disk says the same thing.
    const results = runCases(r, buildCases(r));
    for (const c of results) {
      const { got, output } = await spawnCheck(
        `${dir}/${c.wrapper}`,
        c.argv,
        20_000,
      );
      assertEquals(
        got,
        c.expect,
        `${c.wrapper} ${c.argv.join(" ")} — ${c.about}\n${output}`,
      );
    }

    // Check mode must not have executed anything, and normal mode must.
    const ran = new Deno.Command(`${dir}/fka-safe-demo`, {
      args: ["list", "--limit", "3"],
      stdout: "piped",
      stderr: "piped",
    });
    const okRun = await ran.output();
    assertEquals(okRun.code, 0);
    assertEquals(
      new TextDecoder().decode(okRun.stdout).trim(),
      "list --limit 3",
    );

    const refused = await new Deno.Command(`${dir}/fka-safe-demo`, {
      args: ["delete"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(refused.code, REFUSED_EXIT);
    assertEquals(new TextDecoder().decode(refused.stdout), "");
    assertStringIncludes(
      new TextDecoder().decode(refused.stderr),
      "fka-safe-demo: refused",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("check mode never executes the wrapped tool", async () => {
  const dir = await Deno.makeTempDir({ prefix: "fka-" });
  try {
    const source = await Deno.readTextFile(
      new URL("./validate.ts", import.meta.url),
    );
    // The wrapped "tool" writes a file. If check mode ever execs, the file
    // appears and the test fails — which is the guarantee `verify` depends on.
    const marker = `${dir}/executed`;
    const tool = `${dir}/tool`;
    await Deno.writeTextFile(tool, `#!/bin/sh\ntouch ${marker}\n`);
    await Deno.chmod(tool, 0o755);

    const r = ReviewSchema.parse({
      cli: "tool",
      binary: tool,
      wrappers: [{
        segment: "safe",
        name: "tool",
        admits: { maxTier: "read-safe" },
      }],
      commands: [{
        path: ["list"],
        tier: "read-safe",
        why: "reads",
        options: {},
      }],
    });
    const path = `${dir}/fka-safe-tool`;
    await Deno.writeTextFile(
      path,
      renderWrapper(r, r.wrappers[0], source, Deno.execPath()),
    );
    await Deno.chmod(path, 0o755);

    const { got } = await spawnCheck(path, ["list"], 20_000);
    assertEquals(got, "permit");
    assertEquals(
      await Deno.stat(marker).then(() => true).catch(() => false),
      false,
    );

    // Without check mode the same command does run it, so the marker proves
    // the check-mode result was a real "would permit" rather than a no-op.
    await new Deno.Command(path, { args: ["list"] }).output();
    assertEquals(
      await Deno.stat(marker).then(() => true).catch(() => false),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the wrapper scrubs a hook variable before the tool sees it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "fka-" });
  try {
    const source = await Deno.readTextFile(
      new URL("./validate.ts", import.meta.url),
    );
    const tool = `${dir}/tool`;
    await Deno.writeTextFile(
      tool,
      `#!/bin/sh\necho "PAGER=[$DEMO_PAGER] KEPT=[$DEMO_KEPT]"\n`,
    );
    await Deno.chmod(tool, 0o755);

    const r = ReviewSchema.parse({
      cli: "tool",
      binary: tool,
      wrappers: [{
        segment: "safe",
        name: "tool",
        admits: { maxTier: "read-safe" },
      }],
      env: { scrub: ["DEMO_PAGER"], set: {} },
      commands: [{
        path: ["list"],
        tier: "read-safe",
        why: "reads",
        options: {},
      }],
    });
    const path = `${dir}/fka-safe-tool`;
    await Deno.writeTextFile(
      path,
      renderWrapper(r, r.wrappers[0], source, Deno.execPath()),
    );
    await Deno.chmod(path, 0o755);

    const out = await new Deno.Command(path, {
      args: ["list"],
      env: { DEMO_PAGER: "/bin/sh", DEMO_KEPT: "yes" },
      stdout: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout).trim();
    assertEquals(text, "PAGER=[] KEPT=[yes]");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
