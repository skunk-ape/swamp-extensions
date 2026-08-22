import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  looksLikeManPage,
  parseHelp,
  parseOptionLine,
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

// --- whole pages ---------------------------------------------------------

const GH_STYLE = `
Work with GitHub pull requests.

USAGE
  gh pr <command> [flags]

GENERAL COMMANDS:
  create:      Create a pull request
  list:        List pull requests in a repository
  status:      Show status of relevant pull requests

TARGETED COMMANDS:
  checkout:    Check out a pull request in git
  close:       Close a pull request
  merge:       Merge a pull request

FLAGS:
  -R, --repo [HOST/]OWNER/REPO   Select another repository
  -w, --web                      Open in the browser

INHERITED FLAGS:
  --help   Show help for command
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
