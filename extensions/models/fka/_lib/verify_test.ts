import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildCases, runCases, sampleCases, spawnCheck } from "./verify.ts";
import { ReviewSchema, wrapperName } from "./review.ts";
import type { Review } from "./review.ts";
import { REFUSED_EXIT, renderWrapper } from "./wrapper.ts";

function review(extra: Record<string, unknown> = {}): Review {
  return ReviewSchema.parse({
    cli: "demo",
    binary: "/bin/echo",
    emit: ["read-safe", "modify"],
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
    c.wrapper === "safe-demo" && c.argv.join(" ") === "list" &&
    c.expect === "permit"
  );
  assert(own, "safe-demo should be expected to permit list");
});

Deno.test("a command above a wrapper's tier is expected to be refused by it", () => {
  const cases = buildCases(review());
  const above = cases.find((c) =>
    c.wrapper === "safe-demo" && c.argv.join(" ") === "delete"
  );
  assertEquals(above?.expect, "refuse");
  assertStringIncludes(above?.about ?? "", "above read-safe");
});

Deno.test("an option above the tier gets its own refusal case", () => {
  const cases = buildCases(review());
  const escape = cases.find((c) =>
    c.wrapper === "safe-demo" && c.argv.includes("--exec")
  );
  assertEquals(escape?.expect, "refuse");
});

Deno.test("an option whose value is pattern-constrained is not asserted with a made-up value", () => {
  const r = review({
    commands: [{
      path: ["list"],
      tier: "read-safe",
      why: "reads",
      options: { "--limit": { arity: 1, valuePattern: "\\d+" } },
    }],
  });
  const cases = buildCases(r);
  // A refusal here would be the pattern working, indistinguishable from the
  // option being absent, so the case is left out rather than asserted wrongly.
  assert(!cases.some((c) => c.argv.includes("--limit")));
});

Deno.test("the bare tool name is expected to be refused", () => {
  const cases = buildCases(review());
  const bare = cases.find((c) =>
    c.wrapper === "safe-demo" && c.argv.length === 0
  );
  assertEquals(bare?.expect, "refuse");
});

Deno.test("no cases are built for a tier that was not emitted", () => {
  const cases = buildCases(review({ emit: ["read-safe"] }));
  assert(cases.every((c) => c.wrapper === "safe-demo"));
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
  assertEquals(new Set(picked.map((p) => p.wrapper)).size, 2);
  assert(picked.every((p) => p.expect === "refuse"));
});

Deno.test("a larger budget buys permits as well as refusals", () => {
  const results = runCases(review(), buildCases(review()));
  const picked = sampleCases(results, 4).filter((p) =>
    p.wrapper === "safe-demo"
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

    for (const tier of r.emit) {
      const path = `${dir}/${wrapperName(r.cli, tier)}`;
      await Deno.writeTextFile(
        path,
        renderWrapper(r, tier, source, Deno.execPath()),
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
    const ran = new Deno.Command(`${dir}/safe-demo`, {
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

    const refused = await new Deno.Command(`${dir}/safe-demo`, {
      args: ["delete"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(refused.code, REFUSED_EXIT);
    assertEquals(new TextDecoder().decode(refused.stdout), "");
    assertStringIncludes(
      new TextDecoder().decode(refused.stderr),
      "safe-demo: refused",
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
      emit: ["read-safe"],
      commands: [{
        path: ["list"],
        tier: "read-safe",
        why: "reads",
        options: {},
      }],
    });
    const path = `${dir}/safe-tool`;
    await Deno.writeTextFile(
      path,
      renderWrapper(r, "read-safe", source, Deno.execPath()),
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
      emit: ["read-safe"],
      env: { scrub: ["DEMO_PAGER"], set: {} },
      commands: [{
        path: ["list"],
        tier: "read-safe",
        why: "reads",
        options: {},
      }],
    });
    const path = `${dir}/safe-tool`;
    await Deno.writeTextFile(
      path,
      renderWrapper(r, "read-safe", source, Deno.execPath()),
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
