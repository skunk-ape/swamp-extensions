import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  crawl,
  looksLikeManPage,
  parseHelp,
  parseOptionLine,
  resolveBinary,
  sectionKind,
  stripAnsi,
} from "./help.ts";

// --- option lines --------------------------------------------------------

Deno.test("cobra: a typed flag is arity 1, an untyped one is arity 0", () => {
  const valued = parseOptionLine(
    "  -L, --limit int      Maximum number of items to fetch",
  )!;
  assertEquals(valued.names, ["-L", "--limit"]);
  assertEquals(valued.arity, 1);
  assertEquals(valued.valueHint, "int");

  const flag = parseOptionLine("  -w, --web            Open in the browser")!;
  assertEquals(flag.names, ["-w", "--web"]);
  assertEquals(flag.arity, 0);
});

Deno.test("an ALL-CAPS word in a description is not read as a placeholder", () => {
  // The two-space gap is what says "the rest is prose". Without this rule,
  // `--json` would be recorded as taking a `JSON` argument and the wrapper
  // would swallow the following token unchecked.
  const opt = parseOptionLine("  --json   JSON output of the given fields")!;
  assertEquals(opt.arity, 0);
});

Deno.test("clap and click placeholders are recognised", () => {
  assertEquals(
    parseOptionLine("      --limit <LIMIT>          How many")!.arity,
    1,
  );
  assertEquals(
    parseOptionLine("  -o, --output <FILE>          Where to write")!.arity,
    1,
  );
  assertEquals(
    parseOptionLine("  --name TEXT                  The name")!.arity,
    1,
  );
  assertEquals(
    parseOptionLine("  --count INTEGER              How many")!.arity,
    1,
  );
});

Deno.test("an attached placeholder states arity outright", () => {
  const opt = parseOptionLine("  --state=<open|closed>   Filter by state")!;
  assertEquals(opt.arity, 1);
  assertEquals(opt.valueHint, "<open|closed>");
});

Deno.test("a bare flag with no description is arity 0", () => {
  assertEquals(parseOptionLine("  --verbose")!.arity, 0);
});

Deno.test("an ambiguous single-spaced token yields unknown arity, not a guess", () => {
  // "Show" is neither a placeholder nor separated as a description. Unknown
  // means the option is dropped from the allowlist unless the classifier
  // repairs it, which is the safe direction to fail.
  const opt = parseOptionLine("  --show Show the thing and more words")!;
  assertEquals(opt.arity, null);
});

Deno.test("non-option lines are rejected", () => {
  assertEquals(parseOptionLine("  list    List the things"), null);
  assertEquals(parseOptionLine(""), null);
});

Deno.test("every option keeps its source line for the classifier to repair", () => {
  const opt = parseOptionLine("  -L, --limit int      Maximum number")!;
  assert(opt.source.includes("--limit int"));
});

// --- section headings ----------------------------------------------------

Deno.test("section headings are classified by keyword, not exact match", () => {
  assertEquals(sectionKind("Available Commands"), "commands");
  assertEquals(sectionKind("CORE COMMANDS"), "commands");
  assertEquals(sectionKind("GitHub Actions commands"), "commands");
  assertEquals(sectionKind("Flags"), "options");
  assertEquals(sectionKind("Global Flags"), "options");
  assertEquals(sectionKind("Options"), "options");
  assertEquals(sectionKind("Examples"), "other");
});

Deno.test("a heading naming both wins for options", () => {
  // jq heads its flag list "Command options:". Reading that as a command
  // section costs every option jq has, and jq has no subcommands to gain.
  assertEquals(sectionKind("Command options"), "options");
  assertEquals(sectionKind("Options for commands"), "options");
});

// --- whole pages ---------------------------------------------------------

// Real `gh pr --help`, abridged. Its headings carry no colon at all, which an
// earlier version of this fixture got wrong — it added colons, so the suite
// passed while `gh --help` yielded exactly one of gh's forty commands.
const GH_STYLE = `
Work with GitHub pull requests.

USAGE
  gh pr <command> [flags]

GENERAL COMMANDS
  create:      Create a pull request
  list:        List pull requests in a repository
  status:      Show status of relevant pull requests

TARGETED COMMANDS
  checkout:    Check out a pull request in git
  close:       Close a pull request
  merge:       Merge a pull request

FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository
  -w, --web                      Open in the browser

INHERITED FLAGS
  --help   Show help for command

LEARN MORE
  Use \`gh <command> [subcommand] --help\` for more information about a command.
`;

Deno.test("parses a multi-section cobra page", () => {
  const p = parseHelp(GH_STYLE);
  const names = p.subcommands.map((c) => c.name);
  // Commands from both command sections, and none from the flag sections.
  assertEquals(names, [
    "create",
    "list",
    "status",
    "checkout",
    "close",
    "merge",
  ]);
  const opts = p.options.map((o) => o.names.join(","));
  assert(opts.includes("-R,--repo"));
  assert(opts.includes("-w,--web"));
  assert(opts.includes("--help"));
  assertEquals(p.options.find((o) => o.names.includes("-w"))!.arity, 0);
});

const CLAP_STYLE = `
Usage: tool [OPTIONS] <COMMAND>

Commands:
  build    Build the project
  test     Run the tests
  help     Print this message

Options:
  -j, --jobs <N>      Number of parallel jobs
  -v, --verbose       Use verbose output
  -h, --help          Print help
`;

Deno.test("parses a clap page", () => {
  const p = parseHelp(CLAP_STYLE);
  assertEquals(p.subcommands.map((c) => c.name), ["build", "test", "help"]);
  assertEquals(p.options.find((o) => o.names.includes("-j"))!.arity, 1);
  assertEquals(p.options.find((o) => o.names.includes("-v"))!.arity, 0);
});

const ARGPARSE_STYLE = `
usage: tool [-h] [--verbose] {list,create,delete} ...

positional arguments:
  {list,create,delete}

options:
  -h, --help  show this help message and exit
  --verbose   be chatty
`;

Deno.test("recovers argparse subcommands from the usage line", () => {
  // argparse prints no command section at all; the tree is inside `{a,b,c}`.
  const p = parseHelp(ARGPARSE_STYLE);
  assertEquals(p.subcommands.map((c) => c.name), ["list", "create", "delete"]);
});

Deno.test("records command aliases", () => {
  const p = parseHelp(`
Commands:
  ls, list, l     List things
`);
  assertEquals(p.subcommands[0].name, "ls");
  assertEquals(p.subcommands[0].aliases, ["list", "l"]);
});

Deno.test("a duplicated command or option is recorded once", () => {
  const p = parseHelp(`
Commands:
  list   List things

More commands:
  list   List things again

Flags:
  --json   As json

Global flags:
  --json   As json
`);
  assertEquals(p.subcommands.length, 1);
  assertEquals(p.options.length, 1);
});

Deno.test("strips ANSI colouring before parsing", () => {
  const coloured = "Commands:\n  [1;32mlist[0m    List things\n";
  assertEquals(stripAnsi(coloured).includes(""), false);
  assertEquals(parseHelp(coloured).subcommands.map((c) => c.name), ["list"]);
});

Deno.test("an empty page yields empty results rather than throwing", () => {
  const p = parseHelp("");
  assertEquals(p.subcommands, []);
  assertEquals(p.options, []);
});

// `git --help`, abridged. One commands section, divided by unindented
// sub-headings that do not end in a colon. Reading those as the end of the
// section — which is what an unindented line usually means — loses every
// command git has, so this page is kept as a regression fixture.
const GIT_HELP = `usage: git [-v | --version] [-h | --help] [-C <path>]
           <command> [<args>]

These are common Git commands used in various situations:

start a working area (see also: git help tutorial)
   clone      Clone a repository into a new directory
   init       Create an empty Git repository

examine the history and state (see also: git help revisions)
   log        Show commit logs
   status     Show the working tree status

'git help -a' and 'git help -g' list available subcommands.
See 'git help <command>' to read about a specific subcommand.
`;

Deno.test("a sub-heading inside a commands section does not end it", () => {
  const p = parseHelp(GIT_HELP);
  assertEquals(p.subcommands.map((c) => c.name), [
    "clone",
    "init",
    "log",
    "status",
  ]);
});

Deno.test("trailing prose after the last command is not read as a command", () => {
  const p = parseHelp(GIT_HELP);
  // Both trailing lines are unindented; one opens with a quote and the other
  // is single-spaced prose, and neither should reach the table.
  assertEquals(p.subcommands.some((c) => c.name === "See"), false);
  assertEquals(p.usage.startsWith("usage: git"), true);
});

Deno.test("git's negatable shorthand expands into both spellings", () => {
  // Dropping the line for its brackets would cost most of git's surface, and
  // recording only `--decorate` would refuse `--no-decorate` for no reason.
  const opt = parseOptionLine("    --[no-]source         show source");
  assertEquals(opt?.names, ["--source", "--no-source"]);
  assertEquals(opt?.arity, 0);

  const valued = parseOptionLine("    --[no-]decorate-refs <pattern>");
  assertEquals(valued?.names, ["--decorate-refs", "--no-decorate-refs"]);
  assertEquals(valued?.arity, 1);
});

Deno.test("a negatable pair in a cluster keeps the short spelling too", () => {
  const opt = parseOptionLine("    -q, --[no-]quiet      suppress diff output");
  assertEquals(opt?.names, ["-q", "--quiet", "--no-quiet"]);
  assertEquals(opt?.arity, 0);
});

Deno.test("an optional-value option stays unknown rather than being guessed", () => {
  // `--[no-]decorate[=...]` takes a value or does not. Either arity is wrong
  // some of the time, so it is dropped instead.
  const opt = parseOptionLine("    --[no-]decorate[=...] decorate options");
  assertEquals(opt?.arity, null);
});

Deno.test("a man page is recognised and never parsed as help text", () => {
  const page =
    `GIT-LOG(1)                         Git Manual                        GIT-LOG(1)

NAME
     git-log - Show commit logs

SYNOPSIS
     git log [<options>] [<revision-range>]

OPTIONS
     --decorate-refs-exclude=<pattern>
         Do not decorate refs.
`;
  assertEquals(looksLikeManPage(page), true);
  assertEquals(looksLikeManPage(GIT_HELP), false);
  assertEquals(looksLikeManPage(""), false);
});

Deno.test("a help page that merely mentions NAME is not a man page", () => {
  const page = `Usage: demo [options]

Options:
  --name NAME    The NAME to use
`;
  assertEquals(looksLikeManPage(page), false);
});

Deno.test("a heading with no colon still opens a section", () => {
  const p = parseHelp(GH_STYLE);
  // USAGE and LEARN MORE are shaped exactly like CORE COMMANDS. Only the
  // latter is followed by something that parses as an entry.
  assertEquals(p.subcommands.map((c) => c.name), [
    "create",
    "list",
    "status",
    "checkout",
    "close",
    "merge",
  ]);
  assert(!p.subcommands.some((c) => c.name === "Use"));
  assert(!p.subcommands.some((c) => c.name === "gh"));
});

Deno.test("jq's flag list survives its heading", () => {
  const page = `jq - commandline JSON processor [version 1.8.2]

Usage:\tjq [options] <jq filter> [file...]

Command options:
  -n, --null-input          use \`null\` as the single input value;
  -r, --raw-output          output strings without escapes and quotes;
      --indent n            use n spaces for indentation (max 7 spaces);
      --arg name value      set $name to the string value;
`;
  const p = parseHelp(page);
  const names = p.options.flatMap((o) => o.names);
  assert(names.includes("--null-input"));
  assert(names.includes("--raw-output"));
  assertEquals(p.options.find((o) => o.names.includes("-n"))?.arity, 0);
  assertEquals(p.subcommands, []);

  // `--indent n` names its value with a single lowercase letter, which is
  // shaped exactly like the first word of a description. Unknown, so it is
  // dropped rather than guessed.
  assertEquals(
    p.options.find((o) => o.names.includes("--indent"))?.arity,
    null,
  );

  // `--arg name value` takes two values, which a 0-or-1 arity cannot express
  // at all. Recording it as 1 would leave the second token unchecked.
  assertEquals(p.options.find((o) => o.names.includes("--arg"))?.arity, null);
});

Deno.test("a real section heading still ends a commands section", () => {
  const page = `Commands:
  list    List things

group of things
  show    Show a thing

Options:
  --json    Output JSON
`;
  const p = parseHelp(page);
  assertEquals(p.subcommands.map((c) => c.name), ["list", "show"]);
  assertEquals(p.options.map((o) => o.names[0]), ["--json"]);
});

// --- crawling ------------------------------------------------------------
//
// Everything above is fed text. `crawl` is the part that decides which text to
// go and get: how deep to descend, when to stop, what to skip, and what to do
// with a command whose help fails. None of that can be tested with a fixture
// string, and none of it can be tested reliably against a real tool either —
// asserting on `git --help` is asserting on whichever git is installed, so the
// test would break when git changes rather than when fka does.
//
// Hence a fake CLI, which is the only way to get a known depth, a known
// command count, and a command that fails on demand. The last test uses a real
// binary, for the one claim a fake cannot make.

/** A cobra-shaped page listing `commands` as subcommands. */
function cobraPage(name: string, commands: string[]): string {
  const lines = ["Usage:", `  ${name} [command]`, ""];
  if (commands.length > 0) {
    lines.push("Available Commands:");
    for (const c of commands) lines.push(`  ${c}    the ${c} command`);
    lines.push("");
  }
  lines.push("Flags:", "  -v, --verbose   be loud");
  return lines.join("\n");
}

/** A `printf` reproducing `text` exactly, quoted for sh. */
function shq(text: string): string {
  return `printf '%s\\n' '${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * A CLI whose tree we chose: three subtrees, one four deep, one that fails.
 *
 *   demo ├── alpha ── one ── deep
 *        │      └── two
 *        ├── beta
 *        └── broken   (exits non-zero, prints nothing)
 */
async function fakeCli(): Promise<{ binary: string; dir: string }> {
  const dir = await Deno.makeTempDir();
  const binary = `${dir}/demo`;
  const script = `#!/bin/sh
case "$*" in
  "--help") ${shq(cobraPage("demo", ["alpha", "beta", "broken"]))} ;;
  "alpha --help") ${shq(cobraPage("demo alpha", ["one", "two"]))} ;;
  "alpha one --help") ${shq(cobraPage("demo alpha one", ["deep"]))} ;;
  "alpha one deep --help") ${shq(cobraPage("demo alpha one deep", []))} ;;
  "alpha two --help") ${shq(cobraPage("demo alpha two", []))} ;;
  "beta --help") ${shq(cobraPage("demo beta", []))} ;;
  *) exit 1 ;;
esac
`;
  await Deno.writeTextFile(binary, script);
  await Deno.chmod(binary, 0o755);
  return { binary, dir };
}

function crawlOpts(binary: string, over: Record<string, unknown> = {}) {
  return {
    binary,
    helpFlag: "--help",
    fallbackHelpFlag: "",
    maxDepth: 3,
    maxCommands: 100,
    timeoutMs: 5000,
    include: [],
    exclude: [],
    maxHelpBytes: 100_000,
    listCommand: [],
    ...over,
  };
}

Deno.test("a crawl walks the whole tree it is given", async () => {
  const { binary, dir } = await fakeCli();
  try {
    const nodes = await crawl(crawlOpts(binary));
    assertEquals(
      nodes.map((n) => n.path.join(" ")).sort(),
      [
        "",
        "alpha",
        "alpha one",
        "alpha one deep",
        "alpha two",
        "beta",
        "broken",
      ],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("maxDepth stops the descent without stopping the crawl", async () => {
  const { binary, dir } = await fakeCli();
  try {
    const nodes = await crawl(crawlOpts(binary, { maxDepth: 1 }));
    // Depth 1 is still read; its children are never queued.
    assertEquals(
      nodes.map((n) => n.path.join(" ")).sort(),
      ["", "alpha", "beta", "broken"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("maxCommands is a hard ceiling on how often the tool runs", async () => {
  const { binary, dir } = await fakeCli();
  try {
    assertEquals(
      (await crawl(crawlOpts(binary, { maxCommands: 3 }))).length,
      3,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exclude prunes the subtree, not just the command naming it", async () => {
  const { binary, dir } = await fakeCli();
  try {
    const nodes = await crawl(crawlOpts(binary, { exclude: ["alpha"] }));
    assert(!nodes.some((n) => n.path[0] === "alpha"));
    assert(nodes.some((n) => n.path.join(" ") === "beta"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("include scopes the crawl to the subtrees named", async () => {
  const { binary, dir } = await fakeCli();
  try {
    const nodes = await crawl(crawlOpts(binary, { include: ["beta"] }));
    assertEquals(nodes.map((n) => n.path.join(" ")).sort(), ["", "beta"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a command whose help fails is recorded, not dropped and not fatal", async () => {
  // Recorded so the reviewer learns the crawl could not see it, and
  // contributing nothing to the surface — a command nobody could read is not a
  // command anybody should allowlist.
  const { binary, dir } = await fakeCli();
  try {
    const nodes = await crawl(crawlOpts(binary));
    const broken = nodes.find((n) => n.path.join(" ") === "broken");
    assertEquals(broken?.ok, false);
    assert((broken?.error ?? "") !== "");
    assertEquals(broken?.parsed.subcommands, []);
    // And the crawl completed around it.
    assert(nodes.some((n) => n.path.join(" ") === "alpha one deep"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an aborted crawl stops early rather than running to completion", async () => {
  const { binary, dir } = await fakeCli();
  const controller = new AbortController();
  try {
    const nodes = await crawl(
      crawlOpts(binary, {
        signal: controller.signal,
        onNode: () => controller.abort(),
      }),
    );
    assertEquals(nodes.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * The one claim a fake CLI cannot make.
 *
 * Everything above proves the crawl does what the crawl was told. It cannot
 * prove that a real tool's real output survives the round trip, because the
 * fake prints pages this repository wrote — a parser that only ever reads its
 * own fixtures is agreeing with itself.
 *
 * `git` is the right witness rather than `swamp`, for two reasons. It is on
 * more machines, including a bare CI where someone pulls this extension and
 * runs `deno test`. And it is the tool the man-page fallback exists for:
 * `git log --help` runs `man git-log`, so this asserts the documented retry
 * actually fires against the actual program, which is the part most likely to
 * rot quietly. The assertions stay structural — a count, a flag — so a new git
 * release rewording its help does not fail this.
 */
const gitBinary = await resolveBinary("git").catch(() => "");

Deno.test({
  name: "a real tool crawls, and git's man page triggers the documented retry",
  ignore: gitBinary === "",
  fn: async () => {
    const nodes = await crawl(crawlOpts(gitBinary, {
      fallbackHelpFlag: "-h",
      maxDepth: 1,
      maxCommands: 4,
      include: ["log"],
      timeoutMs: 15_000,
    }));

    const root = nodes.find((n) => n.path.length === 0);
    assertEquals(root?.ok, true);
    assertEquals(root?.helpFlagUsed, "--help");
    assert((root?.parsed.subcommands.length ?? 0) > 0);

    // `git log --help` is roff. The crawl must notice and ask again with -h,
    // because a man page read as help text yields confident nonsense — an
    // option that takes a value coming back as a flag is the arity bypass the
    // wrapper exists to prevent.
    const log = nodes.find((n) => n.path.join(" ") === "log");
    assertEquals(log?.ok, true);
    assertEquals(log?.helpFlagUsed, "-h");
    assert((log?.parsed.options.length ?? 0) > 0);
  },
});

Deno.test("resolveBinary takes a path as given and refuses one that is not there", async () => {
  const { binary, dir } = await fakeCli();
  try {
    assertEquals(await resolveBinary(binary), await Deno.realPath(binary));
    let threw = "";
    await resolveBinary(`${binary}-nope`).catch((e) => {
      threw = e instanceof Error ? e.message : String(e);
    });
    assert(threw.includes("no such binary"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- wrapped help lines ----------------------------------------------------
//
// Cliff-style help wraps a long description onto a deeper-indented line. The
// continuation belongs to the entry above it; parsing it as an entry invents
// commands the tool does not have — `issues.` from `...vault compatibility
// issues.` was a real crawl result before this existed.

Deno.test("a wrapped command description continues the entry, not a phantom", () => {
  const text = [
    "Commands:",
    "",
    "  audit       - Verify that the audit integration is healthy.",
    "  datastores  - Check that the datastore is healthy and flag any vault compatibility",
    "                issues.",
    "  install     - Check installation health: binary ownership, writability, autoupdate",
    "                status.",
  ].join("\n");
  const parsed = parseHelp(text);
  assertEquals(
    parsed.subcommands.map((s) => s.name),
    ["audit", "datastores", "install"],
  );
  const ds = parsed.subcommands.find((s) => s.name === "datastores");
  assert(ds !== undefined && ds.summary.includes("vault compatibility issues."));
});

Deno.test("a wrapped option description continues the option", () => {
  const text = [
    "Options:",
    "  --version-suffix <type>  - Override version micro segment: 'epoch' uses a Unix timestamp (e.g.",
    "                             2026.06.18.1750263600)",
  ].join("\n");
  const parsed = parseHelp(text);
  assertEquals(parsed.options.length, 1);
  assert(parsed.options[0].summary.includes("2026.06.18.1750263600)"));
});

Deno.test("listCommand replaces the root help as the crawl's enumeration", async () => {
  const dir = await Deno.makeTempDir();
  const binary = `${dir}/demo`;
  const script = `#!/bin/sh
case "$*" in
  "--help") ${shq(cobraPage("demo", ["alpha"]))} ;;
  "list-all") ${shq(cobraPage("demo", ["alpha", "hidden"]))} ;;
  "alpha --help") ${shq(cobraPage("demo alpha", []))} ;;
  "hidden --help") ${shq(cobraPage("demo hidden", []))} ;;
  *) exit 1 ;;
esac
`;
  await Deno.writeTextFile(binary, script);
  await Deno.chmod(binary, 0o755);
  try {
    const full = await crawl(crawlOpts(binary, { listCommand: ["list-all"] }));
    assert(full.map((n) => n.path.join(" ")).includes("hidden"));
    const plain = await crawl(crawlOpts(binary));
    assert(!plain.map((n) => n.path.join(" ")).includes("hidden"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a listCommand the tool does not have leaves the root enumeration standing", async () => {
  const { binary, dir } = await fakeCli();
  try {
    const nodes = await crawl(crawlOpts(binary, { listCommand: ["no-such"] }));
    assert(nodes.map((n) => n.path.join(" ")).includes("beta"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
