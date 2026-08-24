import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  checkAgainstSurface,
  defaultWrappers,
  fromYaml,
  helpOptionsOf,
  pruneProblems,
  ReviewSchema,
  sortCommands,
  surfaceOf,
  tierRank,
  toPolicy,
  toYaml,
  wrapperName,
} from "./review.ts";
import type { Review, ReviewCommand, WrapperSpec } from "./review.ts";
import type { CrawlNode } from "./help.ts";
import { effectiveArgv, validate } from "./validate.ts";

// --- fixtures ------------------------------------------------------------

function command(
  path: string[],
  tier: ReviewCommand["tier"],
  options: ReviewCommand["options"] = {},
  extra: Partial<ReviewCommand> = {},
): ReviewCommand {
  return { path, tier, summary: "", why: "", options, dropped: {}, ...extra };
}

/** One alias spec, with the boilerplate filled in. */
function spec(
  segment: WrapperSpec["segment"],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { segment, name: "demo", ...extra };
}

function review(
  commands: ReviewCommand[],
  extra: Record<string, unknown> = {},
): Review {
  return ReviewSchema.parse({
    cli: "demo",
    binary: "/usr/bin/demo",
    binaryVersion: "demo 1.0",
    wrappers: [
      spec("safe", { admits: { maxTier: "read-safe" } }),
      spec("private", { admits: { maxTier: "read-private" } }),
      spec("write", { admits: { maxTier: "modify" } }),
    ],
    commands,
    ...extra,
  });
}

/** The spec a review carries for one segment. */
function at(r: Review, segment: WrapperSpec["segment"]): WrapperSpec {
  const found = r.wrappers.find((s) => s.segment === segment);
  if (!found) throw new Error(`no ${segment} alias in this fixture`);
  return found;
}

/** Shorthand for the policy one segment's alias enforces. */
function policyFor(r: Review, segment: WrapperSpec["segment"]) {
  return toPolicy(r, at(r, segment));
}

// --- tier ordering -------------------------------------------------------

Deno.test("tiers are ordered least to most dangerous", () => {
  assert(tierRank("read-safe") < tierRank("read-private"));
  assert(tierRank("read-private") < tierRank("modify"));
  assert(tierRank("modify") < tierRank("escape"));
});

// --- naming --------------------------------------------------------------

Deno.test("a wrapper is named prefix, segment, then tool", () => {
  assertEquals(wrapperName("fka", "safe", "gh"), "fka-safe-gh");
  assertEquals(wrapperName("fka", "help", "gh-pr"), "fka-help-gh-pr");
});

Deno.test("one rule per segment covers every tool that segment ever wraps", () => {
  // The point of the shared prefix. `Bash(fka-safe:*)` is a prefix of every
  // safe alias for every tool, so wrapping another CLI needs no new rule.
  for (const tool of ["gh", "git", "swamp"]) {
    assert(wrapperName("fka", "safe", tool).startsWith("fka-safe"));
  }
});

Deno.test("a segment rule cannot reach across into another segment", () => {
  // The containment that makes one allow rule safe to write.
  assert(!wrapperName("fka", "write", "gh").startsWith("fka-safe"));
  assert(!wrapperName("fka", "help", "gh").startsWith("fka-safe"));
});

Deno.test("granting one tool does not grant a tool whose name extends it", () => {
  // `fka-safe-gh` is a prefix of `fka-safe-ghi`, so the narrower rule
  // over-matches. Both are safe aliases, which is what makes that survivable.
  const gh = wrapperName("fka", "safe", "gh");
  assert(wrapperName("fka", "safe", "ghi").startsWith(gh));
  assert(!wrapperName("fka", "write", "ghi").startsWith(gh));
});

// --- policy derivation ---------------------------------------------------

Deno.test("an alias admits its own tier and everything below it", () => {
  const r = review([
    command(["list"], "read-safe"),
    command(["whoami"], "read-private"),
    command(["delete"], "modify"),
  ]);

  assertEquals(policyFor(r, "safe").commands.map((c) => c.path.join(" ")), [
    "list",
  ]);
  assertEquals(
    policyFor(r, "write").commands.map((c) => c.path.join(" ")).sort(),
    ["delete", "list", "whoami"],
  );
});

Deno.test("an escape command is absent from every alias below escape", () => {
  const r = review([command(["config"], "escape")]);
  for (const segment of ["safe", "private", "write"] as const) {
    assertEquals(policyFor(r, segment).commands, []);
  }
});

Deno.test("an option is tiered apart from its command", () => {
  // `git log` is safe to run unattended; `git log --ext-diff` runs a program
  // of the caller's choosing.
  const r = review([
    command(["log"], "read-safe", {
      "--oneline": { arity: 0 },
      "--ext-diff": { arity: 0, tier: "escape" },
    }),
  ]);
  const safe = policyFor(r, "safe");
  assertEquals(Object.keys(safe.commands[0].options), ["--oneline"]);
  assert(validate(safe, ["log", "--oneline"]).ok);
  assert(!validate(safe, ["log", "--ext-diff"]).ok);
});

Deno.test("an untiered option inherits its command's tier", () => {
  const r = review([command(["push"], "modify", { "--force": { arity: 0 } })]);
  assertEquals(Object.keys(policyFor(r, "write").commands[0].options), [
    "--force",
  ]);
  assertEquals(policyFor(r, "safe").commands.length, 0);
});

Deno.test("global options are filtered by tier too", () => {
  const r = review([command(["list"], "read-safe")], {
    globalOptions: {
      "--no-color": { arity: 0, tier: "read-safe" },
      "--config": { arity: 1, tier: "escape" },
    },
  });
  assertEquals(Object.keys(policyFor(r, "safe").globalOptions), ["--no-color"]);
});

Deno.test("positionals stay denied unless the table says otherwise", () => {
  const r = review([
    command(["list"], "read-safe"),
    command(["view"], "read-safe", {}, {
      positionals: "any",
      maxPositionals: 1,
    }),
  ]);
  const safe = policyFor(r, "safe");
  assert(!validate(safe, ["list", "anything"]).ok);
  assert(validate(safe, ["view", "thing"]).ok);
  assert(!validate(safe, ["view", "one", "two"]).ok);
});

Deno.test("the policy carries the alias's own name into refusal messages", () => {
  assertEquals(
    policyFor(review([command(["list"], "read-safe")]), "safe").name,
    "fka-safe-demo",
  );
});

// --- pinned aliases ------------------------------------------------------

Deno.test("a help alias reaches every command, whatever its tier", () => {
  const r = review([
    command(["list"], "read-safe"),
    command(["delete"], "modify"),
    command(["config"], "escape"),
  ], {
    wrappers: [
      spec("help", { append: ["--help"], accepts: "path-only" }),
      spec("safe", { admits: { maxTier: "read-safe" } }),
    ],
  });
  const help = policyFor(r, "help");
  assertEquals(help.commands.map((c) => c.path.join(" ")).sort(), [
    "config",
    "delete",
    "list",
  ]);
  // Wider in coverage than the safe alias, and narrower in what it can do.
  assert(validate(help, ["delete", "--help"]).ok);
});

Deno.test("a pinned flag is permitted without anyone allowlisting it", () => {
  // The pin and its permission are derived together, so they cannot disagree.
  const r = review([command(["delete"], "modify")], {
    wrappers: [spec("help", { append: ["--help"], accepts: "path-only" })],
  });
  const help = policyFor(r, "help");
  assertEquals(help.appendArgs, ["--help"]);
  assertEquals(help.globalOptions["--help"], { arity: 0 });
});

Deno.test("a pinned option that takes a value is given arity 1", () => {
  const r = review([command(["list"], "read-safe")], {
    wrappers: [spec("safe", { append: ["--format", "json"] })],
  });
  assertEquals(policyFor(r, "safe").globalOptions["--format"], { arity: 1 });
});

Deno.test("path-only refuses every option and positional the table allows", () => {
  const r = review([
    command(["delete"], "modify", { "-f": { arity: 0 } }, {
      positionals: "any",
    }),
  ], {
    wrappers: [spec("help", { append: ["--help"], accepts: "path-only" })],
  });
  const help = policyFor(r, "help");
  assert(validate(help, ["delete", "--help"]).ok);
  assert(!validate(help, ["delete", "-f", "--help"]).ok);
  assert(!validate(help, ["delete", "thing", "--help"]).ok);
});

Deno.test("a prepended subcommand becomes part of the effective vector", () => {
  const r = review([
    command(["pr", "list"], "read-safe"),
    command(["issue", "list"], "read-safe"),
  ], {
    wrappers: [
      spec("safe", { name: "demo-pr", prepend: ["pr"] }),
    ],
  });
  const policy = toPolicy(r, r.wrappers[0]);
  assertEquals(policy.name, "fka-safe-demo-pr");
  assertEquals(policy.prependArgs, ["pr"]);
  // The caller types `list`; the pin supplies `pr`.
  assertEquals(effectiveArgv(policy, ["list"]), ["pr", "list"]);
  assert(validate(policy, effectiveArgv(policy, ["list"])).ok);
  // And cannot reach out of the subtree, because the pin is not theirs to drop.
  assert(!validate(policy, effectiveArgv(policy, ["issue", "list"])).ok);
});

Deno.test("an explicit path list narrows an alias below its tier", () => {
  const r = review([
    command(["list"], "read-safe"),
    command(["view"], "read-safe"),
  ], {
    wrappers: [
      spec("safe", { admits: { maxTier: "read-safe", paths: [["list"]] } }),
    ],
  });
  assertEquals(policyFor(r, "safe").commands.map((c) => c.path.join(" ")), [
    "list",
  ]);
});

// --- the default plan ----------------------------------------------------

Deno.test("the default plan is three tiers and a help alias", () => {
  const plan = defaultWrappers("gh", "--help");
  assertEquals(plan.map((s) => s.segment), [
    "help",
    "safe",
    "private",
    "write",
  ]);
  // No escape alias: a wrapper for the commands that hand over execution is
  // something an operator asks for, not something a default hands out.
  assert(!plan.some((s) => s.segment === "escape"));
});

Deno.test("the default help alias pins the flag and takes a path only", () => {
  const help = defaultWrappers("gh", "-h")[0];
  assertEquals(help.append, ["-h"]);
  assertEquals(help.accepts, "path-only");
});

Deno.test("no help alias is planned when no help flag was proven", () => {
  const plan = defaultWrappers("gh", "");
  assert(!plan.some((s) => s.segment === "help"));
});

// --- checking the plan ---------------------------------------------------

Deno.test("two aliases with the same name are rejected", () => {
  const r = review([command(["list"], "read-safe")], {
    wrappers: [spec("safe"), spec("safe")],
  });
  const problems = checkAgainstSurface(r, surfaceOf(crawled));
  assert(
    problems.some((p) =>
      p.kind === "bad-wrapper" && p.message.includes("both called")
    ),
  );
});

Deno.test("an alias that admits nothing is rejected, not shipped", () => {
  // A wrapper that refuses everything is not fail-closed, it is a mistake
  // somebody will spend an afternoon on.
  const r = review([command(["delete"], "modify")], {
    wrappers: [spec("safe", { admits: { maxTier: "read-safe" } })],
  });
  const problems = checkAgainstSurface(r, surfaceOf(crawled));
  assert(
    problems.some((p) =>
      p.kind === "bad-wrapper" && p.message.includes("admits no command")
    ),
  );
});

Deno.test("an alias pinning a command the crawl never saw is rejected", () => {
  const r = review([command(["list"], "read-safe")], {
    wrappers: [spec("safe", { name: "demo-nope", prepend: ["nope"] })],
  });
  const problems = checkAgainstSurface(r, surfaceOf(crawled));
  assert(
    problems.some((p) =>
      p.kind === "bad-wrapper" && p.message.includes("pins the command")
    ),
  );
});

// The pinned-option checks below all guard one hole. `toPolicy` assigns pinned
// options after the tier filter, deliberately — an alias has to be able to run
// its own pin — so a pin is the only way an option enters a policy without
// passing that filter. While nothing checked pins, `append` was an unbounded
// grant: any option, any tier, at every command the alias admits.

Deno.test("an alias pinning an option above its own ceiling is rejected", () => {
  const r = review([command(["list"], "read-safe")], {
    globalOptions: { "--no-color": { arity: 1, tier: "modify" } },
    wrappers: [
      spec("safe", {
        admits: { maxTier: "read-safe" },
        append: ["--no-color", "/tmp/evil"],
      }),
    ],
  });
  const problems = checkAgainstSurface(r, surfaceOf(crawled));
  assert(
    problems.some((p) =>
      p.kind === "bad-wrapper" && p.message.includes("pins the option") &&
      p.message.includes("above this alias's ceiling")
    ),
  );
});

Deno.test("a pinned option is checked wherever it is pinned", () => {
  // prepend and append are the same grant by a different route, so a check
  // that only reads one of them is not a check.
  for (const where of ["prepend", "append"] as const) {
    const r = review([command(["list"], "read-safe")], {
      globalOptions: { "--no-color": { arity: 0, tier: "modify" } },
      wrappers: [
        spec("safe", {
          admits: { maxTier: "read-safe" },
          [where]: ["--no-color"],
        }),
      ],
    });
    const problems = checkAgainstSurface(r, surfaceOf(crawled));
    assert(
      problems.some((p) =>
        p.kind === "bad-wrapper" && p.message.includes("pins the option")
      ),
      `a pinned option in ${where} was not checked`,
    );
  }
});

Deno.test("an alias pinning an option the table does not tier is rejected", () => {
  // Absent from the table is refused, which for a pin has to mean refused at
  // check time: there is no tier to compare, so there is nothing to permit.
  const r = review([command(["list"], "read-safe")], {
    wrappers: [
      spec("safe", {
        admits: { maxTier: "read-safe" },
        append: ["--upload-pack", "/tmp/evil"],
      }),
    ],
  });
  const problems = checkAgainstSurface(r, surfaceOf(crawled));
  assert(
    problems.some((p) =>
      p.kind === "bad-wrapper" && p.message.includes("does not tier")
    ),
  );
});

Deno.test("an alias may pin an option at or below its ceiling", () => {
  const r = review([command(["list"], "read-safe")], {
    globalOptions: { "--no-color": { arity: 0, tier: "read-safe" } },
    wrappers: [
      spec("safe", {
        admits: { maxTier: "read-safe" },
        append: ["--no-color"],
      }),
    ],
  });
  assertEquals(checkAgainstSurface(r, surfaceOf(crawled)), []);
});

Deno.test("a help alias may pin a help spelling, which sits outside the ladder", () => {
  // The one pin that must keep working: a help alias is built by appending the
  // tool's own help flag, and help is a mode rather than a tier.
  const r = review([command(["list"], "read-safe")], {
    helpOptions: ["--help"],
    wrappers: [spec("help", { append: ["--help"], accepts: "path-only" })],
  });
  assertEquals(checkAgainstSurface(r, surfaceOf(crawled)), []);
});

Deno.test("a rejected alias is pruned out of the plan", () => {
  // Nothing is read-safe here, so the safe alias admits nothing and goes. The
  // write alias keeps `delete` and stays — tiers are cumulative downward, so a
  // wider alias is never the empty one.
  const r = review([command(["delete"], "modify")], {
    wrappers: [
      spec("safe", { admits: { maxTier: "read-safe" } }),
      spec("write", { admits: { maxTier: "modify" } }),
    ],
  });
  const pruned = pruneProblems(r, checkAgainstSurface(r, surfaceOf(crawled)));
  assertEquals(pruned.wrappers.map((s) => s.segment), ["write"]);
});

// --- reading help ---------------------------------------------------------

/** A crawled page listing one option, and by default naming no proven flag. */
function helpNode(
  path: string[],
  names: string[],
  arity: 0 | 1 = 0,
  helpFlagUsed = "",
): CrawlNode {
  return {
    path,
    ok: true,
    error: "",
    helpText: "",
    helpFlagUsed,
    parsed: {
      usage: "",
      subcommands: [],
      options: [{ names, arity, valueHint: "", summary: "", source: "" }],
    },
  };
}

Deno.test("help spellings are taken from the tool, anchored on --help", () => {
  assertEquals(helpOptionsOf([helpNode([], ["-h", "--help"])]), [
    "--help",
    "-h",
  ]);
});

Deno.test("the flag the crawl actually used counts as proof", () => {
  // git never lists --help among its options; it appears only inside the usage
  // line. But the crawl ran `git --help` and git answered, which settles it.
  assertEquals(helpOptionsOf([helpNode([], ["--version"], 0, "--help")]), [
    "--help",
  ]);
});

Deno.test("a fallback flag that worked is proof for that page", () => {
  // `git log --help` opens man and `git log -h` prints usage, so -h is the
  // proven spelling there even though nothing lists it.
  assertEquals(
    helpOptionsOf([
      helpNode([], ["--version"], 0, "--help"),
      helpNode(["log"], ["--oneline"], 0, "-h"),
    ]),
    ["--help", "-h"],
  );
});

Deno.test("a bare -h is never assumed to mean help", () => {
  // `sort -h` compares human-readable numbers and `du -h` prints sizes. Taking
  // -h as help wherever it appears mis-models the option rather than
  // allowlisting one, which is the arity bug in a different costume.
  assertEquals(helpOptionsOf([helpNode([], ["-h"])]), []);
});

Deno.test("a help flag that takes a value is not treated as help", () => {
  assertEquals(helpOptionsOf([helpNode([], ["--help"], 1)]), []);
});

// --- checking against the crawl -----------------------------------------

function node(path: string[], options: string[][]): CrawlNode {
  return {
    path,
    ok: true,
    error: "",
    helpText: "",
    helpFlagUsed: "--help",
    parsed: {
      usage: "",
      subcommands: [],
      options: options.map((names) => ({
        names,
        arity: 0 as const,
        valueHint: "",
        summary: "",
        source: "",
      })),
    },
  };
}

const crawled = [
  node([], [["--no-color"], ["--help"]]),
  node(["list"], [["--limit"]]),
  node(["delete"], []),
];

Deno.test("a command the crawl never saw is rejected", () => {
  const r = review([
    command(["list"], "read-safe"),
    command(["nuke"], "read-safe"),
  ]);
  const problems = checkAgainstSurface(r, surfaceOf(crawled));
  assertEquals(problems.length, 1);
  assertEquals(problems[0].kind, "unknown-command");
  assertStringIncludes(problems[0].message, "demo nuke");
});

Deno.test("an option the crawl never saw on that command is rejected", () => {
  const r = review([
    command(["list"], "read-safe", { "--sneaky": { arity: 0 } }),
  ]);
  const problems = checkAgainstSurface(r, surfaceOf(crawled));
  assertEquals(problems.length, 1);
  assertEquals(problems[0].kind, "unknown-option");
});

Deno.test("root options are legal at every command, because persistent flags are", () => {
  const r = review([
    command(["list"], "read-safe", { "--no-color": { arity: 0 } }),
  ]);
  assertEquals(checkAgainstSurface(r, surfaceOf(crawled)), []);
});

Deno.test("a duplicated command is rejected rather than silently merged", () => {
  const r = review([
    command(["list"], "read-safe"),
    command(["list"], "modify"),
  ]);
  const problems = checkAgainstSurface(r, surfaceOf(crawled));
  assertEquals(problems.map((p) => p.kind), ["duplicate-command"]);
});

Deno.test("a pattern that will not compile is reported", () => {
  const r = review([
    command(["list"], "read-safe", {}, { positionalPattern: "([" }),
  ]);
  const problems = checkAgainstSurface(r, surfaceOf(crawled));
  assertEquals(problems.map((p) => p.kind), ["bad-pattern"]);
});

Deno.test("a failed crawl node contributes nothing to the legal surface", () => {
  const broken: CrawlNode = {
    ...node(["ghost"], []),
    ok: false,
    error: "no help",
  };
  const r = review([command(["ghost"], "read-safe")]);
  const problems = checkAgainstSurface(r, surfaceOf([...crawled, broken]));
  assertEquals(problems.map((p) => p.kind), ["unknown-command"]);
});

// --- pruning -------------------------------------------------------------

Deno.test("pruning deletes the invented entries rather than repairing them", () => {
  const r = review([
    command(["list"], "read-safe", {
      "--limit": { arity: 1 },
      "--sneaky": { arity: 0 },
    }),
    command(["nuke"], "read-safe"),
  ], { globalOptions: { "--phantom": { arity: 0, tier: "read-safe" } } });

  const pruned = pruneProblems(r, checkAgainstSurface(r, surfaceOf(crawled)));

  assertEquals(pruned.commands.map((c) => c.path.join(" ")), ["list"]);
  assertEquals(Object.keys(pruned.commands[0].options), ["--limit"]);
  assertEquals(Object.keys(pruned.globalOptions), []);
  // What was removed has to stay visible, or the reviewer cannot tell the
  // difference between "considered and rejected" and "never looked at".
  assertStringIncludes(pruned.commands[0].dropped["--sneaky"], "never seen");
});

Deno.test("pruning leaves a clean proposal untouched", () => {
  const r = review([
    command(["list"], "read-safe", { "--limit": { arity: 1 } }),
  ]);
  const pruned = pruneProblems(r, checkAgainstSurface(r, surfaceOf(crawled)));
  assertEquals(pruned.commands.length, 1);
  assertEquals(Object.keys(pruned.commands[0].options), ["--limit"]);
});

Deno.test("a pruned review admits nothing the crawl did not show", () => {
  const r = review([command(["nuke"], "read-safe")]);
  const pruned = pruneProblems(r, checkAgainstSurface(r, surfaceOf(crawled)));
  assert(!validate(policyFor(pruned, "safe"), ["nuke"]).ok);
});

// --- the review file -----------------------------------------------------

Deno.test("the review file round-trips through YAML", () => {
  const r = review([
    command(["list"], "read-safe", {
      "--limit": { arity: 1, valuePattern: "\\d+" },
    }),
    command(["delete"], "modify", {}, {
      positionals: "any",
      maxPositionals: 1,
    }),
  ], { env: { scrub: ["DEMO_PAGER"], set: {} } });

  const back = fromYaml(toYaml(r));
  assertEquals(back.commands.length, 2);
  assertEquals(back.env.scrub, ["DEMO_PAGER"]);
  assertEquals(policyFor(back, "safe"), policyFor(r, "safe"));
});

Deno.test("read-safe is written first, because it is the block that must be read", () => {
  const r = review([
    command(["delete"], "modify"),
    command(["list"], "read-safe"),
  ]);
  const yaml = toYaml(r);
  assert(yaml.indexOf("list") < yaml.indexOf("delete"));
  assertEquals(sortCommands(r.commands)[0].path, ["list"]);
});

Deno.test("the file says what it is and what editing it does", () => {
  const yaml = toYaml(review([command(["list"], "read-safe")]));
  assertStringIncludes(yaml, "proposal from a language model");
  assertStringIncludes(yaml, "read-safe");
  assertStringIncludes(yaml, "--- read-safe ---");
});

Deno.test("a review is unapproved until a person says otherwise", () => {
  // The default is the whole gate. A proposal and an approved table are the
  // same file, so if `approved` defaulted to true — or were absent and read as
  // missing rather than false — `generate` could not tell them apart.
  assertEquals(review([command(["list"], "read-safe")]).approved, false);
  assertEquals(fromYaml("cli: demo\nbinary: /usr/bin/demo").approved, false);
  assert(
    !toYaml(review([command(["list"], "read-safe")])).includes(
      "approved: true",
    ),
  );
});

Deno.test("approval survives the round trip, and only when it was written", () => {
  const approved = fromYaml(
    toYaml(review([command(["list"], "read-safe")], { approved: true })),
  );
  assertEquals(approved.approved, true);
  assertThrows(
    () => fromYaml("cli: demo\nbinary: /usr/bin/demo\napproved: yes please"),
    Error,
    "does not match",
  );
});

Deno.test("the file says how to approve it and what approving does", () => {
  const yaml = toYaml(review([command(["list"], "read-safe")]));
  assertStringIncludes(yaml, "approved");
  assertStringIncludes(yaml, "grants nothing");
  // The wrappers block is where a pinned option hides, so the header has to
  // send the reader there rather than telling them to skim it.
  assertStringIncludes(yaml, "wrappers");
});

Deno.test("an edited file that is no longer valid is an error, never a default", () => {
  assertThrows(() => fromYaml("commands: []"), Error, "does not match");
  assertThrows(() => fromYaml(""), Error, "empty");
  // Deleting the tier from an entry must not quietly resolve to the safe one.
  assertThrows(
    () =>
      fromYaml(
        "cli: demo\nbinary: /usr/bin/demo\ncommands:\n  - path: [list]\n",
      ),
    Error,
    "tier",
  );
});

Deno.test("an arity a person mistypes is rejected instead of coerced", () => {
  assertThrows(
    () =>
      fromYaml(
        "cli: demo\nbinary: /usr/bin/demo\ncommands:\n  - path: [list]\n    tier: read-safe\n    options:\n      --limit: {arity: 2}\n",
      ),
    Error,
    "arity",
  );
});

Deno.test("a global option with no tier is rejected, since it has none to inherit", () => {
  assertThrows(
    () =>
      fromYaml(
        "cli: demo\nbinary: /usr/bin/demo\nglobalOptions:\n  --config: {arity: 1}\ncommands: []\n",
      ),
    Error,
    "tier",
  );
});
