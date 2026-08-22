import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  checkAgainstSurface,
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
import type { Review, ReviewCommand } from "./review.ts";
import type { CrawlNode } from "./help.ts";
import { validate } from "./validate.ts";

// --- fixtures ------------------------------------------------------------

function command(
  path: string[],
  tier: ReviewCommand["tier"],
  options: ReviewCommand["options"] = {},
  extra: Partial<ReviewCommand> = {},
): ReviewCommand {
  return { path, tier, summary: "", why: "", options, dropped: {}, ...extra };
}

function review(
  commands: ReviewCommand[],
  extra: Partial<Review> = {},
): Review {
  return ReviewSchema.parse({
    cli: "demo",
    binary: "/usr/bin/demo",
    binaryVersion: "demo 1.0",
    emit: ["read-safe", "read-private", "modify"],
    commands,
    ...extra,
  });
}

// --- tier ordering -------------------------------------------------------

Deno.test("tiers are ordered least to most dangerous", () => {
  assert(tierRank("read-safe") < tierRank("read-private"));
  assert(tierRank("read-private") < tierRank("modify"));
  assert(tierRank("modify") < tierRank("escape"));
});

// --- naming --------------------------------------------------------------

Deno.test("the tier leads the wrapper name, so a deny on the tool cannot match it", () => {
  const safe = wrapperName("gh", "read-safe");
  assertEquals(safe, "safe-gh");
  // The whole reason for the ordering: Bash rules match by string prefix, so a
  // name starting with the tool's own name would be caught by a deny on it.
  assert(!safe.startsWith("gh"));
});

Deno.test("a prefix collision between wrappers can only reach the same tier", () => {
  // `safe-gh` is a prefix of `safe-ghi`, so an allow rule on the first also
  // matches the second. Both are safe wrappers, which is what makes that
  // survivable — the collision cannot cross into write or private.
  assert(
    wrapperName("ghi", "read-safe").startsWith(wrapperName("gh", "read-safe")),
  );
  assert(
    !wrapperName("ghi", "modify").startsWith(wrapperName("gh", "read-safe")),
  );
});

Deno.test("a path is reduced to the tool's own name", () => {
  assertEquals(wrapperName("/opt/homebrew/bin/gh", "modify"), "write-gh");
});

// --- policy derivation ---------------------------------------------------

Deno.test("a wrapper admits its own tier and everything below it", () => {
  const r = review([
    command(["list"], "read-safe"),
    command(["whoami"], "read-private"),
    command(["delete"], "modify"),
  ]);

  const safe = toPolicy(r, "read-safe");
  assertEquals(safe.commands.map((c) => c.path.join(" ")), ["list"]);

  const write = toPolicy(r, "modify");
  assertEquals(write.commands.map((c) => c.path.join(" ")).sort(), [
    "delete",
    "list",
    "whoami",
  ]);
});

Deno.test("an escape command is absent from every wrapper below escape", () => {
  const r = review([command(["config"], "escape")]);
  for (const tier of ["read-safe", "read-private", "modify"] as const) {
    assertEquals(toPolicy(r, tier).commands, []);
  }
  assertEquals(toPolicy(r, "escape").commands.length, 1);
});

Deno.test("an option is tiered apart from its command", () => {
  // The case the whole option-tier field exists for: `git log` is safe to run
  // unattended, and `git log --ext-diff` runs a program of the caller's choosing.
  const r = review([
    command(["log"], "read-safe", {
      "--oneline": { arity: 0 },
      "--ext-diff": { arity: 0, tier: "escape" },
    }),
  ], { emit: ["read-safe", "escape"] });

  const safe = toPolicy(r, "read-safe");
  assertEquals(Object.keys(safe.commands[0].options), ["--oneline"]);
  assert(validate(safe, ["log", "--oneline"]).ok);
  assert(!validate(safe, ["log", "--ext-diff"]).ok);

  const escape = toPolicy(r, "escape");
  assert(validate(escape, ["log", "--ext-diff"]).ok);
});

Deno.test("an untiered option inherits its command's tier", () => {
  const r = review([command(["push"], "modify", { "--force": { arity: 0 } })]);
  assertEquals(Object.keys(toPolicy(r, "modify").commands[0].options), [
    "--force",
  ]);
  assertEquals(toPolicy(r, "read-safe").commands.length, 0);
});

Deno.test("global options are filtered by tier too", () => {
  const r = review([command(["list"], "read-safe")], {
    globalOptions: {
      "--no-color": { arity: 0, tier: "read-safe" },
      "--config": { arity: 1, tier: "escape" },
    },
  });
  assertEquals(Object.keys(toPolicy(r, "read-safe").globalOptions), [
    "--no-color",
  ]);
});

Deno.test("positionals stay denied unless the table says otherwise", () => {
  const r = review([
    command(["list"], "read-safe"),
    command(["view"], "read-safe", {}, {
      positionals: "any",
      maxPositionals: 1,
    }),
  ]);
  const safe = toPolicy(r, "read-safe");
  assert(!validate(safe, ["list", "anything"]).ok);
  assert(validate(safe, ["view", "thing"]).ok);
  assert(!validate(safe, ["view", "one", "two"]).ok);
});

Deno.test("the policy carries the wrapper's own name into refusal messages", () => {
  const r = review([command(["list"], "read-safe")]);
  assertEquals(toPolicy(r, "read-safe").name, "safe-demo");
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
  assert(!validate(toPolicy(pruned, "read-safe"), ["nuke"]).ok);
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
  assertEquals(toPolicy(back, "read-safe"), toPolicy(r, "read-safe"));
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
