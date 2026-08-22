/**
 * Reading a CLI's command tree out of its own `--help` output.
 *
 * This is the only stage with access to ground truth, so it is the only stage
 * permitted to decide what the command names and option spellings actually are.
 * The classifier downstream may re-tier a command or correct an arity, but it
 * may not invent a subcommand that never appeared here.
 *
 * Help text is not a data format, so the parser is frankly heuristic. It is
 * built to be *conservative rather than complete*: where the shape of a line is
 * ambiguous it reports `null` arity rather than guessing, and an option with
 * unknown arity is dropped from the allowlist rather than admitted on a coin
 * flip. Every parsed option keeps its source line so the classifier can repair
 * what the heuristics could not settle.
 */

// deno-lint-ignore no-explicit-any
declare const Deno: any;

export interface ParsedOption {
  /** Every spelling of this option, e.g. `["-L", "--limit"]`. */
  names: string[];
  /** 0 for a flag, 1 for a valued option, null when the text did not say. */
  arity: 0 | 1 | null;
  /** The value placeholder as written, e.g. `int` or `<LIMIT>`. */
  valueHint: string;
  summary: string;
  /** The line this came from, kept so the classifier can correct a bad parse. */
  source: string;
}

export interface ParsedSubcommand {
  name: string;
  /** Alternative spellings the tool accepts for the same command. */
  aliases: string[];
  summary: string;
}

export interface ParsedHelp {
  usage: string;
  subcommands: ParsedSubcommand[];
  options: ParsedOption[];
}

export interface CrawlNode {
  /** Path below the binary. Empty for the root invocation. */
  path: string[];
  /** Whether the help invocation produced usable output. */
  ok: boolean;
  error: string;
  /** Raw help text, ANSI-stripped and truncated. */
  helpText: string;
  parsed: ParsedHelp;
}

export interface CrawlOptions {
  /** Absolute path to the binary. Resolved by the caller, never taken from PATH here. */
  binary: string;
  /** How the tool is asked for help. `--help` for almost everything. */
  helpFlag: string;
  /**
   * Flag to retry with when the help flag produced a man page. Empty disables.
   *
   * `git log --help` runs `man git-log`, and a roff page parsed by these
   * heuristics yields confident nonsense — `--decorate-refs-exclude` comes back
   * as a flag when it takes a value, which is the arity bypass the wrapper
   * exists to prevent. Detecting the man page and asking again with the short
   * flag is narrow: it only ever fires for a tool that has already shown it
   * routes `--help` to `man`.
   */
  fallbackHelpFlag: string;
  /** How deep below the root to descend. */
  maxDepth: number;
  /** Hard ceiling on help invocations, so a large tool cannot run for an hour. */
  maxCommands: number;
  /** Per-invocation wall-clock cap in milliseconds. */
  timeoutMs: number;
  /** If non-empty, only these top-level subtrees are crawled. */
  include: string[];
  /** Subtrees never crawled, matched as a path prefix. */
  exclude: string[];
  /** Bytes of help text kept per node. */
  maxHelpBytes: number;
  signal?: AbortSignal;
  /** Called for each node as it completes, for progress logging. */
  onNode?: (node: CrawlNode) => void;
}

// --- text handling -------------------------------------------------------

const ANSI = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*" +
    "(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007|" +
    "(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])",
  "g",
);

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/**
 * Value placeholders that mean "this option takes a value".
 *
 * The cobra type names are the load-bearing half: cobra prints the type for
 * every non-boolean flag and prints nothing at all for booleans, which makes
 * its output the most reliably machine-readable of the families here.
 */
const TYPE_WORDS = new Set([
  "string",
  "strings",
  "stringslice",
  "stringarray",
  "stringtostring",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "ints",
  "intslice",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uints",
  "float",
  "float32",
  "float64",
  "floats",
  "duration",
  "durations",
  "count",
  "bytes",
  "byteshex",
  "base64",
  "ip",
  "ipmask",
  "ipnet",
  "ipslice",
  "text",
  "integer",
  "number",
  "num",
  "path",
  "file",
  "dir",
  "directory",
  "url",
  "uri",
  "name",
  "value",
  "key",
  "date",
  "time",
  "regex",
  "pattern",
]);

/** Does this token read as a value placeholder rather than the start of prose? */
function isValueHint(token: string): boolean {
  if (/^[<\[{].*[>\]}]$/.test(token)) return true;
  // ALL-CAPS placeholders like TEXT or FILE. Requires 2+ chars so a stray "A"
  // starting a description does not read as a placeholder.
  if (/^[A-Z][A-Z0-9_-]+$/.test(token)) return true;
  return TYPE_WORDS.has(token.toLowerCase());
}

/** One option spelling, including git's `--[no-]foo` shorthand for a pair. */
const OPTION_NAME = "-{1,2}(?:\\[no-\\])?[A-Za-z0-9][A-Za-z0-9._-]*";

const OPTION_CLUSTER = new RegExp(
  `^((?:${OPTION_NAME})(?:\\s*,\\s*(?:${OPTION_NAME}))*)(.*)$`,
);

/**
 * Expand `--[no-]decorate` into the two options it stands for.
 *
 * git's parse-options prints negatable flags this way, and dropping the line
 * because of the brackets would cost most of git's surface. Both spellings are
 * real and both need to be in the table, or `--no-decorate` is refused while
 * `--decorate` is allowed.
 */
function expandNegatable(name: string): string[] {
  const m = name.match(/^(-{1,2})\[no-\](.+)$/);
  if (!m) return [name];
  return [`${m[1]}${m[2]}`, `${m[1]}no-${m[2]}`];
}

/**
 * Parse one option line into names, arity, and summary.
 *
 * The arity heuristic leans on a formatting convention every one of these
 * frameworks follows: a value placeholder is separated from the option by a
 * *single* space, while the description is separated by two or more. That is
 * what stops `--json   JSON output` from reading as an option taking a `JSON`
 * argument — the two spaces say the rest is prose.
 */
export function parseOptionLine(line: string): ParsedOption | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("-")) return null;

  const m = trimmed.match(OPTION_CLUSTER);
  if (!m) return null;

  const names = m[1].split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap(expandNegatable);
  if (names.length === 0) return null;
  let rest = m[2];

  let arity: 0 | 1 | null = null;
  let valueHint = "";

  // `--limit=<N>` states its arity outright.
  const attached = rest.match(/^=\s*(\S+)/);
  if (attached) {
    arity = 1;
    valueHint = attached[1];
    rest = rest.slice(attached[0].length);
  } else {
    // One space, one token, then the description gap (or end of line).
    const hint = rest.match(/^ (\S+)(?=\s\s|\s*$)/);
    if (hint && isValueHint(hint[1])) {
      arity = 1;
      valueHint = hint[1];
      rest = rest.slice(hint[0].length);
    } else if (/^(?:\s{2,}|\s*$)/.test(rest)) {
      // The description gap, or end of line: nothing sits between the option
      // and its prose, so it takes no value.
      arity = 0;
    } else {
      // Single-spaced text that is not a recognisable placeholder. This is
      // genuinely ambiguous — `--opt VALUE some description` and `--opt Some
      // description` have the same shape — and guessing is exactly the arity
      // bypass the wrapper exists to avoid. Unknown, so the option is dropped
      // unless the classifier repairs it from the source line.
      arity = null;
    }
  }

  return {
    names,
    arity,
    valueHint,
    summary: rest.trim(),
    source: trimmed,
  };
}

const COMMAND_LINE =
  /^([a-zA-Z0-9][a-zA-Z0-9._:-]*)((?:\s*,\s*[a-zA-Z0-9][a-zA-Z0-9._:-]*)*)(?:\s{2,}(.*))?$/;

/**
 * A trailing colon is punctuation, not part of the name.
 *
 * `gh` lists its commands as `list:      List pull requests`. An interior colon
 * is left alone, because it is a real naming convention — `composer` and
 * `symfony` genuinely have `namespace:command` subcommands.
 */
function trimName(name: string): string {
  return name.replace(/:+$/, "");
}

export function parseSubcommandLine(line: string): ParsedSubcommand | null {
  const trimmed = line.trim();
  const m = trimmed.match(COMMAND_LINE);
  if (!m) return null;
  const name = trimName(m[1]);
  if (!name) return null;
  const aliases = (m[2] ?? "").split(",")
    .map((s) => trimName(s.trim()))
    .filter(Boolean);
  return { name, aliases, summary: (m[3] ?? "").trim() };
}

type SectionKind = "commands" | "options" | "other";

/**
 * What kind of section a heading introduces.
 *
 * Matching on keywords rather than exact strings covers the whole spread of
 * headings in the wild — "Available Commands", "Core commands", "GitHub Actions
 * commands", "Flags", "Global Flags", "Inherited Flags", "Options".
 *
 * Options are tested first, and that order is not arbitrary. `jq` heads its
 * flag list "Command options:", which under the other order reads as a command
 * section and swallows every option jq has. A section that lists commands is
 * essentially never titled with the word "options" or "flags"; a section that
 * lists options is quite often titled "Command options".
 */
export function sectionKind(heading: string): SectionKind {
  const h = heading.toLowerCase();
  if (/\b(?:flags?|options?|switches)\b/.test(h)) return "options";
  if (/\b(?:sub)?commands?\b/.test(h)) return "commands";
  return "other";
}

/**
 * Parse a whole help page.
 *
 * Sections are delimited structurally rather than by matching a fixed list of
 * headings, because the set of headings is open and every tool spells them
 * differently. An unindented line ending in `:` opens a section. So does an
 * unindented line with no colon at all, if entries follow it — `gh` writes
 * `CORE COMMANDS` and `FLAGS` bare, and requiring the colon found exactly one
 * of gh's forty commands.
 */
export function parseHelp(text: string): ParsedHelp {
  const lines = stripAnsi(text).split("\n");
  let usage = "";
  const subcommands: ParsedSubcommand[] = [];
  const options: ParsedOption[] = [];
  const seenCommands = new Set<string>();
  const seenOptions = new Set<string>();

  let kind: SectionKind = "other";

  /**
   * Is the next non-blank line an indented entry — a command or an option?
   *
   * This is what tells a heading from a sentence when there is no colon to go
   * by. Looking at what follows beats looking at the line itself: `USAGE` and
   * `CORE COMMANDS` are shaped identically, and only the first is followed by
   * something that parses as an entry.
   */
  const entryFollows = (start: number): boolean => {
    for (let j = start + 1; j < lines.length; j++) {
      const next = lines[j];
      if (next.trim() === "") continue;
      if (!/^\s/.test(next)) return false;
      return parseSubcommandLine(next) !== null || parseOptionLine(next) !== null;
    }
    return false;
  };

  /** Short, and not punctuated like a sentence. Cheap guard against prose. */
  const headingShaped = (line: string): boolean => {
    const t = line.trim();
    return t.length > 0 && t.length <= 60 && !/[.!?,]$/.test(t);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    if (line.trim() === "") continue;

    const indented = /^\s/.test(line);

    if (!indented) {
      if (/:\s*$/.test(line)) {
        kind = sectionKind(line.replace(/:\s*$/, ""));
        continue;
      }
      if (/^usage:/i.test(line)) {
        if (!usage) usage = line.trim();
        continue;
      }
      // An unindented, non-heading line ends the previous section — except for
      // an option line, since some tools list flags flush left.
      if (!line.trim().startsWith("-")) {
        if (headingShaped(line) && entryFollows(i)) {
          const named = sectionKind(line.trim());
          if (named !== "other") {
            kind = named;
            continue;
          }
          // A heading this function cannot name, sitting inside a command
          // list that plainly continues below it, is a group divider. `git`
          // splits its commands with "examine the history and state (see
          // also: git help revisions)"; ending the section there loses every
          // command git has.
          if (kind === "commands") continue;
        }
        kind = "other";
        continue;
      }
    }

    if (!usage && /^\s*usage:/i.test(line)) usage = line.trim();

    if (
      kind === "options" || (kind !== "commands" && line.trim().startsWith("-"))
    ) {
      const opt = parseOptionLine(line);
      if (opt) {
        const id = opt.names.join(",");
        if (!seenOptions.has(id)) {
          seenOptions.add(id);
          options.push(opt);
        }
      }
      continue;
    }

    if (kind === "commands") {
      const cmd = parseSubcommandLine(line);
      if (cmd && !seenCommands.has(cmd.name)) {
        seenCommands.add(cmd.name);
        subcommands.push(cmd);
      }
    }
  }

  // argparse and friends never print a command section; the subcommands appear
  // as `{list,create,delete}` inside the usage line instead.
  if (subcommands.length === 0 && usage) {
    const braced = usage.match(/\{([a-zA-Z0-9._:-]+(?:,[a-zA-Z0-9._:-]+)+)\}/);
    if (braced) {
      for (const name of braced[1].split(",")) {
        if (!seenCommands.has(name)) {
          seenCommands.add(name);
          subcommands.push({ name, aliases: [], summary: "" });
        }
      }
    }
  }

  return { usage, subcommands, options };
}

// --- crawling ------------------------------------------------------------

/**
 * Is this a man page rather than a help screen?
 *
 * The distinction is not cosmetic. Help text lists options in a column with a
 * description gap, which is what every heuristic above relies on; a man page
 * writes them into prose. Parsing one with the other's rules does not fail
 * loudly — it produces a table full of plausible, wrong arities, and a wrong
 * arity is a bypass. So a man page is refused rather than read.
 *
 * The signature is the running header roff leaves at the top and bottom
 * (`GIT-LOG(1)`), together with the flush-left capitalised section names.
 */
export function looksLikeManPage(text: string): boolean {
  const lines = stripAnsi(text).split("\n").slice(0, 40);
  const header = lines.some((l) =>
    /^[A-Z][A-Z0-9_.+-]*\(\d[a-z]?\)/.test(l.trim())
  );
  const sections = ["NAME", "SYNOPSIS", "DESCRIPTION", "OPTIONS"]
    .filter((s) => lines.some((l) => l.trimEnd() === s)).length;
  return header && sections >= 2;
}

/**
 * Run one help invocation.
 *
 * Spawned through argv, never a shell, so nothing in a command name can be
 * interpreted. Help goes to stdout on some tools and stderr on others, and a
 * non-zero exit is routine for `--help`, so both streams are captured and the
 * exit code is not treated as failure on its own.
 */
async function runHelp(
  o: CrawlOptions,
  path: string[],
  flag: string = o.helpFlag,
): Promise<{ ok: boolean; text: string; error: string }> {
  const args = [...path, flag];
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(o.binary, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      // A help crawl has no business reading the caller's terminal settings or
      // pager. Forcing a dumb, unpaged, uncoloured environment keeps output
      // parseable and stops the tool blocking on a pager nobody is watching.
      env: {
        TERM: "dumb",
        NO_COLOR: "1",
        PAGER: "cat",
        GH_PAGER: "cat",
        GIT_PAGER: "cat",
      },
    }).spawn();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      text: "",
      error: `could not run ${o.binary}: ${reason}`,
    };
  }

  let timedOut = false;
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, o.timeoutMs);
  o.signal?.addEventListener("abort", kill, { once: true });

  try {
    const { stdout, stderr } = await child.output();
    clearTimeout(timer);
    if (timedOut) {
      return {
        ok: false,
        text: "",
        error: `help timed out after ${o.timeoutMs}ms`,
      };
    }
    const dec = new TextDecoder();
    const text = stripAnsi(dec.decode(stdout) + "\n" + dec.decode(stderr))
      .slice(
        0,
        o.maxHelpBytes,
      );
    if (text.trim() === "") {
      return { ok: false, text: "", error: "help produced no output" };
    }
    return { ok: true, text, error: "" };
  } catch (error) {
    clearTimeout(timer);
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, text: "", error: reason };
  }
}

/**
 * Read help for one node, refusing a man page rather than misreading it.
 *
 * The retry fires only after the primary flag has already produced roff, so a
 * tool that answers `--help` properly is never asked anything else.
 */
async function readHelp(
  o: CrawlOptions,
  path: string[],
): Promise<{ ok: boolean; text: string; error: string }> {
  const first = await runHelp(o, path);
  if (!first.ok || !looksLikeManPage(first.text)) return first;

  const name = [".", ...path].join(" ").slice(2);
  const what = name ? `"${name}"` : "the root command";
  if (!o.fallbackHelpFlag) {
    return {
      ok: false,
      text: "",
      error:
        `${o.helpFlag} on ${what} opened a man page, which cannot be parsed for option arity`,
    };
  }

  const second = await runHelp(o, path, o.fallbackHelpFlag);
  if (second.ok && !looksLikeManPage(second.text)) return second;
  return {
    ok: false,
    text: "",
    error:
      `${o.helpFlag} on ${what} opened a man page and ${o.fallbackHelpFlag} did not help; ` +
      `set helpFlag to whatever prints this tool's short usage`,
  };
}

function excluded(path: string[], exclude: string[]): boolean {
  return exclude.some((prefix) => {
    const parts = prefix.split(/\s+/).filter(Boolean);
    return parts.every((p, i) => path[i] === p) && parts.length <= path.length;
  });
}

/**
 * Walk the command tree breadth-first, reading help at every node.
 *
 * Breadth-first on purpose: when `maxCommands` cuts the crawl short, what
 * survives is a complete picture of the shallow commands rather than one
 * exhaustively explored branch and nothing else.
 */
export async function crawl(o: CrawlOptions): Promise<CrawlNode[]> {
  const nodes: CrawlNode[] = [];
  const queue: string[][] = [[]];
  const seen = new Set<string>([""]);

  while (queue.length > 0 && nodes.length < o.maxCommands) {
    const path = queue.shift()!;
    if (o.signal?.aborted) break;

    const { ok, text, error } = await readHelp(o, path);
    const parsed = ok
      ? parseHelp(text)
      : { usage: "", subcommands: [], options: [] };
    const node: CrawlNode = { path, ok, error, helpText: text, parsed };
    nodes.push(node);
    o.onNode?.(node);

    if (!ok || path.length >= o.maxDepth) continue;

    for (const sub of parsed.subcommands) {
      const child = [...path, sub.name];
      // `include` scopes the crawl to named top-level subtrees, which is how a
      // tool with thousands of operations stays reviewable by a person.
      if (
        o.include.length > 0 && child.length === 1 &&
        !o.include.includes(sub.name)
      ) {
        continue;
      }
      if (excluded(child, o.exclude)) continue;
      const id = child.join(" ");
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(child);
    }
  }

  return nodes;
}

/** Resolve a bare tool name to an absolute path, so `PATH` cannot be re-aimed later. */
export async function resolveBinary(cli: string): Promise<string> {
  if (cli.includes("/")) {
    const stat = await Deno.stat(cli).catch(() => null);
    if (!stat?.isFile) throw new Error(`no such binary: ${cli}`);
    return await Deno.realPath(cli);
  }
  const pathEnv = Deno.env.get("PATH") ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/${cli}`;
    const stat = await Deno.stat(candidate).catch(() => null);
    if (stat?.isFile) return await Deno.realPath(candidate);
  }
  throw new Error(
    `"${cli}" is not on PATH — fka wraps a CLI you already have`,
  );
}

/**
 * Find the Deno the generated wrappers should run under.
 *
 * `Deno.execPath()` is the obvious answer and the wrong one here: inside a
 * swamp model it returns the swamp binary, which produced wrappers whose
 * launcher read `swamp run --quiet …` and fell through to `/bin/sh`. A wrapper
 * that fails to start is not a safe wrapper, so this resolves deliberately and
 * refuses rather than guessing.
 *
 * The bundled runtime is preferred over whatever is on PATH, because it is the
 * one swamp itself keeps working across upgrades.
 */
export async function resolveDeno(override: string): Promise<string> {
  const candidates = override ? [override] : [];
  const home = Deno.env.get("HOME");
  if (!override) {
    if (home) candidates.push(`${home}/.swamp/deno/deno`);
    const self = Deno.execPath();
    if (/(^|\/)deno$/.test(self)) candidates.push(self);
  }

  for (const candidate of candidates) {
    const stat = await Deno.stat(candidate).catch(() => null);
    if (stat?.isFile) return await Deno.realPath(candidate);
  }
  if (!override) {
    const found = await resolveBinary("deno").catch(() => null);
    if (found) return found;
  }

  throw new Error(
    `could not find the Deno runtime the wrappers need. Looked at ` +
      `${
        candidates.join(", ") || "PATH"
      }. Set the denoPath global argument to ` +
      `its full path — "swamp doctor extensions --json" reports it as denoPath.`,
  );
}

/** Capture the tool's version string, so `verify` can report drift after an upgrade. */
export async function binaryVersion(
  binary: string,
  timeoutMs: number,
): Promise<string> {
  for (const flag of ["--version", "version", "-V"]) {
    const r = await runHelp(
      {
        binary,
        helpFlag: flag,
        fallbackHelpFlag: "",
        maxDepth: 0,
        maxCommands: 1,
        timeoutMs,
        include: [],
        exclude: [],
        maxHelpBytes: 2000,
      },
      [],
    );
    if (r.ok) return r.text.trim().split("\n")[0].slice(0, 200);
  }
  return "";
}
