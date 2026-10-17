import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  type CommandRule,
  type OptionSpec,
  type Policy,
  validate,
} from "./validate.ts";

// --- fixtures ------------------------------------------------------------

function policy(
  commands: CommandRule[],
  globalOptions: Record<string, OptionSpec> = {},
  tier = "read-safe",
): Policy {
  return {
    cli: "demo",
    name: `${tier === "read-safe" ? "safe" : tier}-demo`,
    tier,
    binary: "/usr/bin/demo",
    prependArgs: [],
    appendArgs: [],
    globalOptions,
    commands,
    env: { scrub: [], set: {} },
  };
}

const flag: OptionSpec = { arity: 0 };
const valued: OptionSpec = { arity: 1 };

/** Assert the verdict is an allow, reporting the refusal reason when it is not. */
function allows(p: Policy, argv: string[]): string[] {
  const v = validate(p, argv);
  assert(v.ok, `expected allow, got refusal: ${v.ok ? "" : v.reason}`);
  return v.command;
}

/** Assert the verdict is a refusal, and return the reason for further checks. */
function refuses(p: Policy, argv: string[]): string {
  const v = validate(p, argv);
  assert(!v.ok, `expected refusal, but "${argv.join(" ")}" was allowed`);
  return v.reason;
}

// --- command resolution --------------------------------------------------

Deno.test("permits an exactly-listed command", () => {
  const p = policy([{ path: ["pr", "list"], options: {} }]);
  assertEquals(allows(p, ["pr", "list"]), ["pr", "list"]);
});

Deno.test("refuses a command absent from the table", () => {
  const p = policy([{ path: ["pr", "list"], options: {} }]);
  assertStringIncludes(refuses(p, ["pr", "delete"]), "not a permitted");
});

Deno.test("refuses a prefix of a permitted command", () => {
  // `demo pr` is a real node in the tree but was never itself permitted.
  const p = policy([{ path: ["pr", "list"], options: {} }]);
  assertStringIncludes(refuses(p, ["pr"]), "prefix of one");
});

Deno.test("refuses the bare binary unless the empty path is listed", () => {
  assertStringIncludes(
    refuses(policy([{ path: ["pr"], options: {} }]), []),
    "on its own",
  );
  assertEquals(allows(policy([{ path: [], options: {} }]), []), []);
});

Deno.test("refuses an unknown leading word", () => {
  const p = policy([{ path: ["pr", "list"], options: {} }]);
  refuses(p, ["repo", "list"]);
});

// --- long options --------------------------------------------------------

Deno.test("permits an allowlisted flag and refuses an unlisted one", () => {
  const p = policy([{ path: ["list"], options: { "--json": flag } }]);
  allows(p, ["list", "--json"]);
  assertStringIncludes(
    refuses(p, ["list", "--web"]),
    '"--web" is not permitted',
  );
});

Deno.test("an arity-1 option consumes the following token", () => {
  const p = policy([{ path: ["list"], options: { "--limit": valued } }]);
  allows(p, ["list", "--limit", "5"]);
});

Deno.test("--opt=value is checked, not waved through", () => {
  const p = policy([{
    path: ["list"],
    options: { "--state": { arity: 1, valuePattern: "open|closed" } },
  }]);
  allows(p, ["list", "--state=open"]);
  assertStringIncludes(
    refuses(p, ["list", "--state=merged"]),
    "permitted pattern",
  );
});

Deno.test("a flag accepts an attached boolean but nothing else", () => {
  // `--flag=false` is how a cobra boolean is negated, so it must work.
  const p = policy([{ path: ["list"], options: { "--json": flag } }]);
  allows(p, ["list", "--json=false"]);
  allows(p, ["list", "--json=TRUE"]);
  assertStringIncludes(
    refuses(p, ["list", "--json=id,title"]),
    "takes no value",
  );
});

Deno.test("an arity-1 option at the end of argv is a refusal, not a crash", () => {
  const p = policy([{ path: ["list"], options: { "--limit": valued } }]);
  assertStringIncludes(refuses(p, ["list", "--limit"]), "needs a value");
});

// --- the option-shaped value bypass --------------------------------------

Deno.test("refuses an option-shaped value, which is the arity bypass", () => {
  // If our arity is wrong, we swallow `--ext-diff` as a value while the real
  // tool reads it as an option nobody checked. Refuse rather than guess.
  const p = policy([{ path: ["log"], options: { "--limit": valued } }]);
  assertStringIncludes(
    refuses(p, ["log", "--limit", "--ext-diff"]),
    "looks like an option",
  );
});

Deno.test("negative numbers and bare dash are values, not options", () => {
  const p = policy([{
    path: ["log"],
    options: { "--offset": valued, "--file": valued },
  }]);
  allows(p, ["log", "--offset", "-5"]);
  allows(p, ["log", "--offset", "-1.5"]);
  allows(p, ["log", "--file", "-"]);
});

Deno.test("allowOptionLikeValue opens the door only where asked", () => {
  const p = policy([{
    path: ["log"],
    options: { "--format": { arity: 1, allowOptionLikeValue: true } },
  }]);
  allows(p, ["log", "--format", "--oneline"]);
});

// --- short options -------------------------------------------------------

Deno.test("splits a cluster of flags", () => {
  const p = policy([{
    path: ["ls"],
    options: { "-a": flag, "-l": flag, "-h": flag },
  }]);
  allows(p, ["ls", "-alh"]);
});

Deno.test("refuses a cluster containing an unlisted flag", () => {
  const p = policy([{ path: ["ls"], options: { "-a": flag, "-l": flag } }]);
  assertStringIncludes(refuses(p, ["ls", "-alz"]), '"-z" is not permitted');
});

Deno.test("a valued short option takes the rest of its cluster as the value", () => {
  const p = policy([{ path: ["list"], options: { "-L": valued } }]);
  allows(p, ["list", "-L5"]);
});

Deno.test("a valued short option at the end of a cluster consumes the next token", () => {
  const p = policy([{ path: ["list"], options: { "-a": flag, "-L": valued } }]);
  allows(p, ["list", "-aL", "5"]);
  assertStringIncludes(
    refuses(p, ["list", "-aL", "--exec"]),
    "looks like an option",
  );
});

Deno.test("a cluster whose value swallows the rest does not re-check it as flags", () => {
  // `-Lz` is `-L` with value "z", so the unlisted `-z` must NOT be consulted.
  const p = policy([{ path: ["list"], options: { "-L": valued } }]);
  allows(p, ["list", "-Lz"]);
});

// --- the `--` terminator -------------------------------------------------

Deno.test("everything after -- is positional", () => {
  const p = policy([{ path: ["log"], options: {}, positionals: "any" }]);
  // A file genuinely named `--ext-diff` is not an option.
  allows(p, ["log", "--", "--ext-diff"]);
});

Deno.test("-- does not smuggle a positional past a none policy", () => {
  const p = policy([{ path: ["log"], options: {} }]);
  assertStringIncludes(
    refuses(p, ["log", "--", "--ext-diff"]),
    "no free arguments",
  );
});

Deno.test("-- stops subcommand matching too", () => {
  const p = policy([
    { path: ["pr"], options: {}, positionals: "any" },
    { path: ["pr", "list"], options: {} },
  ]);
  // `list` after `--` is an argument to `pr`, not the `pr list` command.
  assertEquals(allows(p, ["pr", "--", "list"]), ["pr"]);
});

// --- positionals ---------------------------------------------------------

Deno.test("positionals are denied by default", () => {
  const p = policy([{ path: ["api"], options: {} }]);
  assertStringIncludes(refuses(p, ["api", "/repos/o/r"]), "no free arguments");
});

Deno.test("an unadmitted subcommand is named, not called a free argument", () => {
  // The shape that produced this: git's root command is itself in the table, so
  // `fka-safe-git add .` found a rule at the root, took `add` for a stray
  // argument, and reported `"git " takes no free arguments` — a message that
  // names the wrong problem and trails a space where the command should be.
  const p = policy([
    { path: [], options: {} },
    { path: ["log"], options: {}, positionals: "any" },
  ]);
  const reason = refuses(p, ["add", "."]);
  assertStringIncludes(reason, '"demo add" is not a permitted command');
  assert(
    !reason.includes('"demo "'),
    `refusal should name the command, got: ${reason}`,
  );
});

Deno.test("a stray argument below the root still names its command", () => {
  const p = policy([{ path: [], options: {} }, { path: ["log"], options: {} }]);
  assertStringIncludes(refuses(p, ["log", "x"]), '"demo log" takes no free');
});

Deno.test("a positional pattern is anchored", () => {
  const p = policy([{
    path: ["api"],
    options: {},
    positionals: "any",
    positionalPattern: "/repos/[^/]+/[^/]+",
  }]);
  allows(p, ["api", "/repos/o/r"]);
  // Unanchored, "/repos/o/r/../../admin" would slip through on a prefix match.
  refuses(p, ["api", "/repos/o/r/../../admin"]);
});

Deno.test("maxPositionals is enforced", () => {
  const p = policy([{
    path: ["show"],
    options: {},
    positionals: "any",
    maxPositionals: 1,
  }]);
  allows(p, ["show", "a"]);
  assertStringIncludes(refuses(p, ["show", "a", "b"]), "at most 1");
});

Deno.test("a malformed pattern refuses rather than allowing", () => {
  const p = policy([{
    path: ["show"],
    options: {},
    positionals: "any",
    positionalPattern: "([unclosed",
  }]);
  refuses(p, ["show", "anything"]);
});

Deno.test("a bare word after a positional is another positional, not a subcommand", () => {
  const p = policy([
    { path: ["run"], options: {}, positionals: "any" },
    { path: ["run", "list"], options: {} },
  ]);
  // Matches how the tools resolve: subcommands bind at the front only.
  assertEquals(allows(p, ["run", "job", "list"]), ["run"]);
});

// --- option scoping ------------------------------------------------------

Deno.test("global options are accepted before the subcommand", () => {
  const p = policy([{ path: ["log"], options: {} }], { "-C": valued });
  allows(p, ["-C", "/tmp/repo", "log"]);
});

Deno.test("options are inherited from ancestor rules", () => {
  const p = policy([
    { path: ["pr"], options: { "--repo": valued } },
    { path: ["pr", "list"], options: { "--limit": valued } },
  ]);
  allows(p, ["pr", "list", "--repo", "o/r", "--limit", "5"]);
});

Deno.test("a child's options do not leak to its parent", () => {
  const p = policy([
    { path: ["pr"], options: {} },
    { path: ["pr", "list"], options: { "--limit": valued } },
  ]);
  assertStringIncludes(refuses(p, ["pr", "--limit", "5"]), "not permitted");
});

Deno.test("a subcommand's option is not accepted before the subcommand is named", () => {
  // Strict on purpose: the fix is to move the option to globalOptions, and the
  // failure is a legible refusal rather than an unchecked token.
  const p = policy([{ path: ["log"], options: { "--oneline": flag } }]);
  refuses(p, ["--oneline", "log"]);
});

// --- the scenarios that motivated the design ------------------------------

Deno.test("gh api cannot be turned into a mutation", () => {
  // `Bash(gh api:*)` would match this. The wrapper does not.
  const p = policy([{
    path: ["api"],
    options: { "--jq": valued },
    positionals: "any",
    maxPositionals: 1,
    positionalPattern: "/[A-Za-z0-9._/-]+",
  }]);
  allows(p, ["api", "/repos/o/r", "--jq", ".name"]);
  assertStringIncludes(
    refuses(p, ["api", "-X", "DELETE", "/repos/o/r"]),
    "not permitted",
  );
  refuses(p, ["api", "--method=POST", "/repos/o/r"]);
});

Deno.test("git log cannot reach an external diff driver", () => {
  const p = policy([{
    path: ["log"],
    options: { "--oneline": flag, "-n": valued },
  }]);
  allows(p, ["log", "--oneline", "-n", "20"]);
  assertStringIncludes(refuses(p, ["log", "--ext-diff"]), "not permitted");
});

Deno.test("a read-only-looking tool cannot be made to write", () => {
  // `sort -o` writes a file. It is not in the read-safe table, so it refuses.
  const p = policy([{
    path: [],
    options: { "-r": flag, "-n": flag },
    positionals: "any",
  }]);
  allows(p, ["-rn", "input.txt"]);
  assertStringIncludes(
    refuses(p, ["-n", "-o", "/etc/passwd", "input.txt"]),
    '"-o" is not permitted',
  );
});

Deno.test("refusal messages name the tier and never claim success", () => {
  const p = policy([{ path: ["list"], options: {} }], {}, "read-safe");
  assertStringIncludes(refuses(p, ["delete"]), "read-safe");
});
