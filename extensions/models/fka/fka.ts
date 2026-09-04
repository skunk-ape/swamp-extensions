// @skunk-ape/fka — wrap a CLI in the permission tier it deserves.
//
// Take a command-line tool the agent already has, work out which of its
// commands are safe to run unattended, and generate a wrapper that enforces
// that answer. The wrapper is named for the tool and the tier it allows:
// `gh` becomes `safe-gh`, `private-gh`, `write-gh`. The tier moves out of the
// argument list and into the command name, which is the one part of a shell
// command a permission rule can match cheaply and exactly.
//
// Four methods and one person, in that order, and a fifth that undoes them:
//
//   discover   Recursively read `<cli> --help` and record the command tree.
//              Deterministic. The only stage with ground truth, and therefore
//              the only one allowed to decide what the commands are called.
//
//   classify   A model session proposes a tier per command, an option
//              allowlist, and an environment scrub list. Its output is checked
//              back against the crawl, so it can re-tier what discover found
//              but never invent anything, and it is written to a review file.
//
//   [a person edits the review file and approves the workflow step]
//
//   generate   Read back the EDITED file and render the wrappers, the
//              permission snippet, and the skill snippet from it. One method,
//              because they are three views of one fact.
//
//   verify     Prove every wrapper enforces its tier, using a check mode that
//              never executes the wrapped tool.
//
//   remove     Stop wrapping a tool: take its wrappers off PATH, and with
//              purge delete the review file as well. Separate from the four
//              because retiring a tool is a decision, not a stage.
//
// Nothing here writes settings.json. The thing that proposes a permission
// policy must not also be able to put it into force, so the last step is
// always a person pasting the snippet in.
//
// Two more, apart from that chain: tally reads Claude Code transcripts and
// emits a per-tool usage profile, ranked by frequency, so a person can scope
// discover's `include`/`exclude` to what is actually run rather than a
// tool's whole surface — tally orders before discover in the workflow, but
// neither discover nor classify reads the profile automatically; scoping is
// still a manual step for whoever drives the run. score measures an approved
// review against that same corpus —
// false refusals, the babysitting number, and leakage, which must be zero —
// by reusing _lib/validate.ts, never a second engine that could disagree
// with it. Both are deterministic and spawn nothing.

import { z } from "npm:zod@4";
import {
  binaryVersion,
  crawl,
  resolveBinary,
  resolveDeno,
} from "./_lib/help.ts";
import type { CrawlNode } from "./_lib/help.ts";
import {
  baseName,
  checkAgainstSurface,
  fromYaml,
  helpOptionsOf,
  pruneProblems,
  ReviewSchema,
  SEGMENTS,
  surfaceOf,
  tierCounts,
  toPolicy,
  toYaml,
} from "./_lib/review.ts";
import type { Review } from "./_lib/review.ts";
import { addUsage, spawnAsk, zeroUsage } from "./_lib/ask.ts";
import { classifyAll } from "./_lib/classify.ts";
import { renderSettings, renderSkill, renderWrapper } from "./_lib/wrapper.ts";
import {
  buildCases,
  type CaseResult,
  runCases,
  sampleCases,
  spawnCheck,
} from "./_lib/verify.ts";
import {
  buildCorpus,
  defaultTranscriptRoot,
  rankByTool,
  rankDenials,
} from "./_lib/corpus.ts";
import type { Invocation } from "./_lib/corpus.ts";
import {
  agreement,
  falseRefusals,
  leakage,
  type SettingsRuleset,
  wouldPrompt,
} from "./_lib/score.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  /**
   * Where the workspaces live. Empty means `$XDG_CONFIG_HOME/fka`, falling
   * back to `~/.config/fka`.
   *
   * The default is the user's home rather than the repository, because a
   * wrapper is invoked by bare name and so lives in the machine's namespace,
   * not a project's. Two repos wrapping `gh` would each render an executable
   * called `fka-safe-gh`, and only one of them can be on PATH. The rest of the
   * design already assumed this — one permission rule per segment, written
   * once for every tool ever wrapped — and this was the last part that did not.
   *
   * An absolute path is used as given. A relative one is resolved against the
   * repository root, which is the escape hatch for anyone who wants a
   * project-local workspace and accepts that the alias names are still global.
   */
  workRoot: z.string().default(""),

  // --- discover ------------------------------------------------------------
  /** How the tool is asked for help. `--help` for almost everything. */
  helpFlag: z.string().default("--help"),
  /**
   * Flag to retry with when `helpFlag` produced a man page. Empty disables.
   *
   * `git log --help` runs `man git-log`, and a roff page read by a help-text
   * parser yields confident nonsense rather than an obvious failure. The retry
   * fires only for a tool that has already shown it routes `--help` to `man`.
   */
  fallbackHelpFlag: z.string().default("-h"),
  /**
   * An argv suffix, whitespace-split, that enumerates the tool's full command
   * list. A root help sometimes names only the common commands — `git --help`
   * lists 25 of ~200 — while an enumeration subcommand lists them all, like
   * `git help -a`. When set, discover parses that output and uses it as the
   * crawl's level-1 command list; the root help is still the page kept and
   * tiered.
   */
  listCommand: z.string().default(""),
  /** How deep below the root to descend. */
  maxDepth: z.number().int().min(0).max(6).default(3),
  /** Hard ceiling on help invocations, so a large tool cannot run for an hour. */
  maxCommands: z.number().int().min(1).max(5000).default(400),
  /** Per-invocation wall-clock cap. */
  helpTimeoutMs: z.number().int().positive().default(10_000),
  /** Bytes of help text kept per node. */
  maxHelpBytes: z.number().int().positive().default(200_000),

  // --- classify ------------------------------------------------------------
  /** Path or command name for the Claude Code binary. */
  claudePath: z.string().default("claude"),
  /**
   * Model the classifier's spawned `claude -p` sessions run on. Empty — the
   * default — inherits the caller's Claude Code default: the child process
   * receives the caller's environment and saved model, and no `--model` flag
   * is passed. Set it to pin a model for every classify this definition runs,
   * e.g. `claude-sonnet-5`.
   */
  model: z.string().default(""),
  /**
   * Whether the classifier may read documentation off the network.
   *
   * Help text often does not say whether an operation is billable or reaches a
   * private resource, and the docs do. The cost is a session that reads
   * attacker-influenceable pages while holding a network capability. `none`
   * turns it off for operators who would rather classify blind.
   */
  docsMode: z.enum(["none", "web"]).default("none"),
  /** Commands per model call. Smaller prompts get more careful answers. */
  batchSize: z.number().int().min(1).max(60).default(20),
  /** Hard ceiling for a single model call. */
  wallTimeoutMs: z.number().int().positive().default(300_000),
  /**
   * Variables set for the classifier's spawned sessions and nowhere else.
   *
   * The reason to want this is routing: `ANTHROPIC_BASE_URL` and
   * `ANTHROPIC_AUTH_TOKEN` pointed at a proxy put one classify run on a
   * cheaper model without moving the caller's own Claude Code session onto it.
   * Setting those in your shell would move both.
   *
   * Empty by default, and worth being clear about what filling it costs: a
   * proxy needs a token, and a token is a stored credential, which is the
   * property `DESIGN.md` otherwise claims this model does not have.
   */
  askEnv: z.record(z.string(), z.string()).default({}),
  /**
   * Working directory for the classifier's spawned sessions.
   *
   * Empty — the default — uses the tool's own workspace, which is chosen for
   * what is *not* in it: Claude Code reads a `CLAUDE.md` from its working
   * directory upwards, and a repository's instructions are pure cost in a
   * session whose only job is to tier a command list. Every batch pays for
   * them again.
   */
  askCwd: z.string().default(""),

  // --- generate ------------------------------------------------------------
  /**
   * Deno runtime the wrappers launch under. Empty resolves it automatically.
   *
   * Resolution prefers swamp's bundled runtime, then a `deno` on PATH. Set this
   * when neither is what you want the wrappers pinned to — the path is baked
   * into every wrapper, so moving the runtime later breaks them.
   */
  denoPath: z.string().default(""),
  /**
   * The first word of every generated alias.
   *
   * Shared across every tool, so one set of permission rules keyed on
   * `<prefix>-<segment>` covers everything you ever wrap. Change it only if
   * `fka` collides with something already on your `PATH`.
   */
  prefix: z.string().regex(/^[a-z][a-z0-9-]*$/).default("fka"),
  /**
   * Variables every wrapper scrubs, on top of whatever the classifier named.
   *
   * These are the ones that hook a program into a tool that never mentions them
   * in its own help, so no per-tool classification would find them.
   */
  envScrub: z.array(z.string()).default([
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "PERL5OPT",
    "PYTHONSTARTUP",
    "BASH_ENV",
    "ENV",
  ]),

  // --- verify --------------------------------------------------------------
  /** Cases per wrapper that are re-checked by spawning the real script. */
  spawnSamples: z.number().int().min(1).max(200).default(6),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Every method names the tool it is working on. That is the shared spine. */
const CliArg = z.string().min(1);

const DiscoverArgs = z.object({
  cli: CliArg,
  /** If non-empty, only these top-level subtrees are crawled. */
  include: z.array(z.string()).default([]),
  /** Subtrees never crawled, matched as a path prefix. */
  exclude: z.array(z.string()).default([]),
});
type DiscoverArgs = z.infer<typeof DiscoverArgs>;

const ClassifyArgs = z.object({ cli: CliArg });
type ClassifyArgs = z.infer<typeof ClassifyArgs>;

const GenerateArgs = z.object({
  cli: CliArg,
  /** Read a review file from somewhere other than the workspace. */
  reviewPath: z.string().optional(),
});
type GenerateArgs = z.infer<typeof GenerateArgs>;

const VerifyArgs = z.object({ cli: CliArg });
type VerifyArgs = z.infer<typeof VerifyArgs>;

const RemoveArgs = z.object({
  cli: CliArg,
  /**
   * Also delete the tool's workspace — the review file, the crawl, the
   * snippets.
   *
   * Off by default, and the asymmetry is deliberate. Taking the wrappers off
   * PATH is the part that changes what an agent can do, and it is recoverable:
   * the table that produced them is still there, so `generate` rebuilds them.
   * The review file is the record of what a person approved and why, marked
   * `infinite` for that reason, and nothing regenerates it — `classify` would
   * write a fresh proposal, not the judgement someone made about the last one.
   * So the reversible half happens on request and the unrecoverable half needs
   * asking for.
   */
  purge: z.boolean().default(false),
});
type RemoveArgs = z.infer<typeof RemoveArgs>;

const TallyArgs = z.object({
  /**
   * Where to read transcripts from. Empty defaults to this project's own
   * transcript directory under `~/.claude/projects`.
   *
   * `tally` reads every command an agent has ever run, which is categorically
   * wider than fka's other methods — those execute a named binary or write
   * wrapper files, this reads history across however many sessions ever
   * touched this repository. Defaulting to the current project rather than
   * every project on the machine keeps that widening deliberate: seeing
   * another project's commands takes setting this explicitly.
   */
  root: z.string().default(""),
  /** How many days back to read, from the moment tally runs. */
  windowDays: z.number().int().positive().default(14),
  /**
   * Tally only these tools (matched by basename). Empty tallies every binary
   * the corpus contains and writes a usage profile for each.
   */
  tools: z.array(z.string()).default([]),
});
type TallyArgs = z.infer<typeof TallyArgs>;

const ScoreArgs = z.object({
  cli: CliArg,
  /**
   * A `settings.json`-shaped file, read either as `{ allow, ask, deny }`
   * directly or as `{ permissions: { allow, ask, deny } }`, matching a real
   * settings file. Two different uses:
   *
   * - It decides "unattended" for `falseRefusalCount`: a wrapper only counts
   *   as unattended when this file's `allow` actually grants its full name
   *   (and `deny` does not revoke it) — real permission data, not a guess
   *   from the wrapper's segment name. Omit it and `falseRefusals` falls back
   *   to the coarser segment-bucket guess; `falseRefusalMode` on the result
   *   says which one ran.
   * - It also drives `promptEstimate`, a coarse, deliberately conservative
   *   aid — see `_lib/score.ts`'s `wouldPrompt` — never the sole metric that
   *   decides whether a wrapper is safe. `leakage`, built on the exact
   *   validator the wrappers run, is unaffected either way and is always
   *   reported.
   */
  settingsPath: z.string().default(""),
});
type ScoreArgs = z.infer<typeof ScoreArgs>;

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const SurfaceSchema = z.object({
  cli: z.string(),
  binary: z.string(),
  binaryVersion: z.string(),
  discoveredAt: z.string(),
  commandCount: z.number(),
  optionCount: z.number(),
  /** Options whose arity the help text did not state. These cannot be allowlisted. */
  unknownArityCount: z.number(),
  failedCount: z.number(),
  truncated: z.boolean(),
  surfacePath: z.string(),
  commands: z.array(z.string()),
});

const ProposalSchema = z.object({
  cli: z.string(),
  reviewPath: z.string(),
  classifiedAt: z.string(),
  docsMode: z.string(),
  counts: z.record(z.string(), z.number()),
  /** Problems found by checking the proposal back against the crawl. */
  rejected: z.array(z.string()),
  notes: z.array(z.string()),
  /**
   * What producing this proposal cost, and which model produced it.
   *
   * `models` is the part a reviewer needs rather than the accountant: a table
   * proposed by a cheap model is a weaker starting point than one from a
   * strong model, and the reviewer cannot tell by reading the table. Recording
   * it means nobody has to remember which run used what.
   *
   * `costUsd` is the CLI's list price. On a subscription that is not what the
   * run was billed, so it compares runs rather than stating money owed.
   */
  usage: z.object({
    calls: z.number(),
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheCreation: z.number(),
    costUsd: z.number(),
    models: z.array(z.string()),
  }),
  nextAction: z.string(),
});

const GeneratedSchema = z.object({
  cli: z.string(),
  generatedAt: z.string(),
  binDir: z.string(),
  settingsPath: z.string(),
  skillPath: z.string(),
  wrappers: z.array(z.object({
    segment: z.string(),
    name: z.string(),
    purpose: z.string(),
    path: z.string(),
    commandCount: z.number(),
  })),
  /**
   * Wrappers this run deleted from `bin/` because the table no longer names
   * them. Recorded because it is the one destructive thing `generate` does,
   * and a grant that disappeared should be as visible as one that appeared.
   */
  removed: z.array(z.string()),
  settingsSnippet: z.string(),
  skillSnippet: z.string(),
  nextAction: z.string(),
});

const RemovedSchema = z.object({
  cli: z.string(),
  removedAt: z.string(),
  binDir: z.string(),
  /** Wrapper names taken off PATH. */
  wrappers: z.array(z.string()),
  /** The workspace directory, when `purge` deleted it. Empty when it was kept. */
  purgedWorkspace: z.string(),
  nextAction: z.string(),
});

const VerificationSchema = z.object({
  cli: z.string(),
  verifiedAt: z.string(),
  ok: z.boolean(),
  caseCount: z.number(),
  failureCount: z.number(),
  spawnedCount: z.number(),
  spawnMismatchCount: z.number(),
  versionAtGenerate: z.string(),
  versionNow: z.string(),
  drifted: z.boolean(),
  failures: z.array(z.object({
    wrapper: z.string(),
    command: z.string(),
    expected: z.string(),
    got: z.string(),
    about: z.string(),
    detail: z.string(),
  })),
});

const CorpusResultSchema = z.object({
  generatedAt: z.string(),
  root: z.string(),
  windowDays: z.number(),
  transcriptsScanned: z.number(),
  linesScanned: z.number(),
  linesUnparsed: z.number(),
  /** Bash commands seen but not confidently tokenised, and therefore dropped. */
  refusedCount: z.number(),
  /**
   * How many invocations hit the subcommand-path deriver's one generous
   * depth guard, rather than stopping because a token looked like an
   * argument. Zero on every real corpus this project has read so far; a
   * nonzero count here is a reported bound, not a silent truncation — see
   * `_lib/corpus.ts`'s module doc.
   */
  pathBoundHits: z.number(),
  invocationCount: z.number(),
  denialCount: z.number(),
  toolsSeen: z.array(z.string()),
  corpusPath: z.string(),
  /** See `TRUNCATION_BIAS_NOTE` — disclosed here, not just in `nextAction`. */
  truncationBiasNote: z.string(),
  nextAction: z.string(),
});

const UsageProfileSchema = z.object({
  cli: z.string(),
  generatedAt: z.string(),
  windowDays: z.number(),
  /** Distinct subcommand paths seen for this tool. */
  commandCount: z.number(),
  totalInvocations: z.number(),
  denialCount: z.number(),
  profilePath: z.string(),
  /** The ranked queue, most-used first, capped for the resource record. */
  top: z.array(z.object({ path: z.array(z.string()), count: z.number() })),
  nextAction: z.string(),
});

const ScoreResultSchema = z.object({
  cli: z.string(),
  scoredAt: z.string(),
  corpusInvocationCount: z.number(),
  /**
   * Which method decided "unattended" for this run: `"settings"` when
   * `settingsPath` was supplied and a wrapper's real permission grant decided
   * the answer, `"segment-bucket"` when it fell back to the `help`/`safe`
   * segment name because no settings file was given. The two can disagree —
   * see `_lib/score.ts`'s `FalseRefusalsResult` doc — so a reader needs to
   * know which one produced the count below.
   */
  falseRefusalMode: z.enum(["settings", "segment-bucket"]),
  /**
   * `true` only in `"settings"` mode, and only when `settingsPath` grants
   * not a single non-`help` wrapper by name. A distinct condition from every
   * wrapper being legitimately `ask`/`deny`'d — see `_lib/score.ts`'s
   * `FalseRefusalsResult.grantsNoWrapper` doc. When `true`, treat
   * `falseRefusalCount`/`falseRefusalOccurrences` as "settings mode
   * recognised nothing", not as "the table admits nothing safely" — check
   * `settingsPath` before editing the review file in response.
   */
  settingsGrantsNoWrapper: z.boolean(),
  /** See `TRUNCATION_BIAS_NOTE` — disclosed here, not just in `nextAction`. */
  truncationBiasNote: z.string(),
  /** The babysitting number, as distinct command **shapes**: corpus invocations no unattended wrapper admits. */
  falseRefusalCount: z.number(),
  /**
   * The same commands, weighted by how many times each actually ran
   * (`Invocation.count`). A shape run once and one run fifty times both count
   * once toward `falseRefusalCount`; this is the number that answers "how
   * many prompts did this actually cost".
   */
  falseRefusalOccurrences: z.number(),
  falseRefusalSamples: z.array(
    z.object({ command: z.string(), count: z.number() }),
  ),
  /** A wrapper admitting a command tiered above its own segment's ceiling. Must be zero. */
  leakageCount: z.number(),
  leakageSamples: z.array(z.object({
    wrapper: z.string(),
    command: z.string(),
    commandTier: z.string(),
    segmentCeiling: z.string(),
  })),
  /**
   * A coarse, deliberately conservative estimate of whether a supplied
   * `settings.json`-shaped ruleset would prompt for each corpus invocation —
   * see `_lib/score.ts`'s `wouldPrompt` doc for exactly what it does and does
   * not model. Never the metric that decides whether a wrapper is safe; that
   * is `falseRefusalCount`/`falseRefusalOccurrences` and `leakageCount`,
   * above, both built on the same validator every wrapper runs.
   */
  promptEstimate: z.object({
    used: z.boolean(),
    certainlyAllowedCount: z.number(),
    wouldPromptCount: z.number(),
  }),
  agreement: z.object({
    total: z.number(),
    scored: z.number(),
    scoredOptions: z.number(),
    agreed: z.number(),
    mismatches: z.array(z.object({
      path: z.array(z.string()),
      option: z.string().optional(),
      labelledTier: z.string(),
      reviewTier: z.string(),
      /** Why the fixture labels it this way — the rationale a reviewer checks. */
      note: z.string().optional(),
    })),
    missing: z.array(z.object({
      path: z.array(z.string()),
      option: z.string().optional(),
      tier: z.string(),
    })),
  }),
  nextAction: z.string(),
});

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

type Logger = {
  info: (msg: string, props?: Record<string, unknown>) => void;
  warning: (msg: string, props?: Record<string, unknown>) => void;
};
type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;
type FileWriter = {
  writeText: (text: string) => Promise<{ name: string }>;
};
type CreateFileWriter = (specName: string, name: string) => FileWriter;

/**
 * Name one piece of data.
 *
 * Data instance names are unique across specs within a run, so the spec has to
 * be part of the name — `generate` writes a settings file and a skill file in
 * the same breath, and both are about the same tool. Reading the spec back out
 * of the name also means `swamp data get fka-gh proposal-gh` says what it
 * fetches without anyone consulting the model definition.
 */
function dataName(spec: string, cli: string): string {
  return `${spec}-${baseName(cli)}`;
}

/**
 * The root every workspace hangs off.
 *
 * Defaults to the user's config directory, because what a wrapper encodes is a
 * judgement about a binary installed on this machine — `git log` is read-safe
 * in every repository you own — and because the wrapper has to reach PATH,
 * which no per-project directory does.
 */
export function workRoot(repoDir: string, g: GlobalArgs): string {
  if (g.workRoot.startsWith("/")) return g.workRoot;
  if (g.workRoot !== "") return `${repoDir}/${g.workRoot}`;

  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  if (xdg && xdg.startsWith("/")) return `${xdg}/fka`;
  const home = Deno.env.get("HOME");
  if (home) return `${home}/.config/fka`;

  throw new Error(
    "could not find a home directory for the fka workspace — set the " +
      "workRoot global argument to an absolute path.",
  );
}

/** The per-tool workspace. Holds the crawl and the review file for one CLI. */
function workspace(repoDir: string, g: GlobalArgs, cli: string): string {
  return `${workRoot(repoDir, g)}/${baseName(cli)}`;
}

/**
 * Where a classifier session runs.
 *
 * Defaults to the tool's own workspace, chosen for what is *not* under it.
 * Claude Code walks up from its working directory collecting `CLAUDE.md`, so a
 * session spawned inside a repository loads that repository's instructions
 * before it sees a single command name — dead weight in a session whose only
 * job is to tier a command list, and paid for again on every batch. The
 * workspace holds the crawl and the review file for one CLI and nothing that
 * addresses an agent.
 *
 * An explicit `askCwd` wins, for the operator who knows better.
 */
export function askCwdFor(g: GlobalArgs, workspaceDir: string): string {
  return g.askCwd !== "" ? g.askCwd : workspaceDir;
}

/**
 * Where every wrapper for every tool is written.
 *
 * Shared rather than per-tool, and that is the whole ergonomic point. The
 * permission rules are one per segment no matter how many tools you wrap; a
 * per-tool `bin` would have made PATH grow by one entry per tool anyway, which
 * gives back what the segment-keyed rules just bought. One directory, one PATH
 * line, forever.
 */
function binDirFor(repoDir: string, g: GlobalArgs): string {
  return `${workRoot(repoDir, g)}/bin`;
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

/**
 * Tighten `path`'s permission bits, warning rather than silently swallowing
 * a real failure.
 *
 * The prior version of every one of these call sites caught every error the
 * same way, with a comment claiming Windows — no POSIX mode bits — was the
 * only cause. That is true for `Deno.errors.NotSupported`, but a real POSIX
 * `EPERM` (a read-only filesystem, an unexpected owner) matches the same
 * blanket `catch` and leaves the file or directory at its wider default
 * mode with nothing in the output to say so (finding N7).
 */
async function tightenPerms(
  path: string,
  mode: number,
  logger: Logger,
  what: string,
): Promise<void> {
  try {
    await Deno.chmod(path, mode);
  } catch (error) {
    if (error instanceof Deno.errors.NotSupported) {
      return; // Windows has no POSIX mode bits; nothing to tighten.
    }
    logger.warning(
      "could not tighten permissions on {path} to {mode}: {reason} — " +
        "{what} may be more readable than intended",
      {
        path,
        mode: mode.toString(8),
        reason: error instanceof Error ? error.message : String(error),
        what,
      },
    );
  }
}

async function readJson<T>(path: string, what: string): Promise<T> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    throw new Error(`no ${what} at ${path} — run the earlier method first.`);
  }
  return JSON.parse(text) as T;
}

/**
 * Write an executable so no caller ever sees it half-written.
 *
 * A wrapper sits on PATH and can be invoked at any moment, including during
 * the write that replaces it. Written in place, the window between truncation
 * and the last byte is a file that parses as nothing — the wrapper exits on a
 * syntax error rather than on a verdict, which is a confusing failure at best
 * and, for anything reading exit codes, an ambiguous one. Rendering to a
 * neighbour and renaming makes the swap atomic: a caller gets the old policy or
 * the new one. The mode goes on the temp, because after the rename it is too
 * late to be the file's first mode.
 */
export async function writeExecutable(
  path: string,
  content: string,
): Promise<void> {
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await Deno.writeTextFile(tmp, content);
    await Deno.chmod(tmp, 0o755);
    await Deno.rename(tmp, path);
  } catch (error) {
    await Deno.remove(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Disclosed in both `tally`'s and `score`'s `nextAction`, and carried as its
 * own field on both resources (finding F3): only the leading command of a
 * compound transcript line is ever tallied — `_lib/corpus.ts`'s module doc
 * measured 74% of this project's own distinct invocations containing an
 * unquoted separator or newline. That under-represents anything that mostly
 * runs second in a chain, and biases `falseRefusals`/`wouldPrompt`
 * optimistic in exactly the same way: a compound line no wrapper could run
 * at all still records as its (wrapper-admitted) leading command. Not
 * structurally fixed here — this is a disclosure, not a remedy.
 */
const TRUNCATION_BIAS_NOTE =
  "Known bias: only the leading command of a compound transcript line " +
  "(a && b, a | b, a; b) is ever tallied, so a command that mostly runs " +
  "second in a chain is under-represented in this corpus, and a compound " +
  "line no wrapper could actually run in full still scores as its " +
  "(wrapper-admitted) leading command — see _lib/corpus.ts's module doc.";

/** The marker every rendered wrapper carries, and nothing else does. */
const WRAPPER_MARKER = "generated by @skunk-ape/fka";

/**
 * Wrappers on disk that belong to this tool.
 *
 * Ownership is decided by name, and the naming is deliberately unforgiving
 * about one case: `fka-safe-gh` is a prefix of `fka-safe-ghi`, which is a
 * different tool. So the segment is matched against the closed set and the
 * remainder must equal the tool's own base name or begin with it followed by a
 * hyphen — `gh` and `gh-pr` are ours, `ghi` is somebody else's.
 *
 * The marker check is the second half. This function's callers delete what it
 * returns, and `bin/` is a directory the operator put on their PATH; a name
 * collision with something they wrote themselves must not be resolved by
 * removing their file.
 */
export async function ownedWrappers(
  binDir: string,
  prefix: string,
  cli: string,
): Promise<string[]> {
  const base = baseName(cli);
  const owned: string[] = [];
  try {
    // The loop is inside the try because `Deno.readDir` does not throw when it
    // is called — it returns an iterator that throws on its first step. A catch
    // around the call alone looks like it handles a missing directory and does
    // not, which is how the first version of this got it wrong.
    for await (const entry of Deno.readDir(binDir)) {
      if (!entry.isFile) continue;
      const segment = SEGMENTS.find((s) =>
        entry.name.startsWith(`${prefix}-${s}-`)
      );
      if (!segment) continue;
      const name = entry.name.slice(`${prefix}-${segment}-`.length);
      if (name !== base && !name.startsWith(`${base}-`)) continue;
      try {
        const body = await Deno.readTextFile(`${binDir}/${entry.name}`);
        if (!body.includes(WRAPPER_MARKER)) continue;
      } catch {
        continue;
      }
      owned.push(entry.name);
    }
  } catch {
    // No bin directory yet, which is the ordinary state before a first
    // generate. Nothing on disk means nothing of ours on disk.
    return owned;
  }
  return owned;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * Analyse a CLI's command tree, tier every command, and generate wrappers that
 * enforce the result.
 *
 * `discover` and `generate` are deterministic. `classify` spawns `claude -p`
 * and needs Claude Code on PATH. `verify` runs every wrapper in a check mode
 * that never executes the wrapped tool.
 */
export const model = {
  type: "@skunk-ape/fka",
  version: "2026.09.02.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "surface": {
      description:
        "What the help crawl found: the command tree and its option spellings.",
      schema: SurfaceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    "proposal": {
      description:
        "The classifier's tier proposal, and where to edit it before generating.",
      schema: ProposalSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    "generated": {
      description:
        "The wrappers, the permission snippet, and the skill snippet.",
      schema: GeneratedSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "removed": {
      description:
        "What unwrapping a tool took off PATH, and whether its workspace went with it.",
      schema: RemovedSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "verification": {
      description:
        "Proof that each wrapper permits its own tier and nothing above it.",
      schema: VerificationSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
    "corpus": {
      description:
        "What tally read out of Claude Code transcripts: counts, coverage, and where the shared corpus.json landed.",
      schema: CorpusResultSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    "usageProfile": {
      description:
        "One tool's ranked queue of commands actually run, and its denials, derived from the shared corpus.",
      schema: UsageProfileSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
    "score": {
      description:
        "False refusals and leakage measured against the tallied corpus, plus classifier agreement against the labelled fixture.",
      schema: ScoreResultSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
  },
  files: {
    "review": {
      description: "The tier table, as commented YAML for a person to edit.",
      contentType: "text/yaml",
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "settings": {
      description:
        "Permission rules to merge into .claude/settings.json by hand.",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "skill": {
      description: "Instructions telling an agent to use the wrappers.",
      contentType: "text/markdown",
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    // -----------------------------------------------------------------------
    discover: {
      description:
        "Recursively read `<cli> --help` and record the command tree, option spellings, and each option's arity. Deterministic — runs the tool only with its help flag.",
      arguments: DiscoverArgs,
      execute: async (
        args: DiscoverArgs,
        ctx: {
          globalArgs: GlobalArgs;
          repoDir: string;
          logger: Logger;
          signal: AbortSignal;
          writeResource: WriteResource;
        },
      ) => {
        const g = ctx.globalArgs;
        const binary = await resolveBinary(args.cli);
        const version = await binaryVersion(binary, g.helpTimeoutMs);
        ctx.logger.info("Crawling {cli} at {binary}", {
          cli: args.cli,
          binary,
        });

        let seen = 0;
        const nodes = await crawl({
          binary,
          helpFlag: g.helpFlag,
          fallbackHelpFlag: g.fallbackHelpFlag,
          maxDepth: g.maxDepth,
          maxCommands: g.maxCommands,
          timeoutMs: g.helpTimeoutMs,
          include: args.include,
          exclude: args.exclude,
          maxHelpBytes: g.maxHelpBytes,
          listCommand: g.listCommand.trim() === ""
            ? []
            : g.listCommand.trim().split(/\s+/),
          signal: ctx.signal,
          onNode: (node) => {
            seen++;
            if (seen % 25 === 0) {
              ctx.logger.info("Read help for {count} commands", {
                count: seen,
              });
            }
            if (!node.ok) {
              ctx.logger.warning("No help for {command}: {error}", {
                command: [args.cli, ...node.path].join(" "),
                error: node.error,
              });
            }
          },
        });

        const dir = workspace(ctx.repoDir, g, args.cli);
        await ensureDir(dir);
        const surfacePath = `${dir}/surface.json`;
        await Deno.writeTextFile(
          surfacePath,
          JSON.stringify(
            { cli: args.cli, binary, binaryVersion: version, nodes },
            null,
            2,
          ),
        );

        let optionCount = 0;
        let unknownArity = 0;
        for (const node of nodes) {
          for (const opt of node.parsed.options) {
            optionCount++;
            if (opt.arity === null) unknownArity++;
          }
        }
        const failed = nodes.filter((n) => !n.ok).length;
        const truncated = nodes.length >= g.maxCommands;
        if (truncated) {
          ctx.logger.warning(
            "Stopped at the {max}-command ceiling; scope the crawl with include or raise maxCommands",
            { max: g.maxCommands },
          );
        }

        ctx.logger.info(
          "Found {commands} command(s), {options} option(s), {unknown} of unknown arity",
          {
            commands: nodes.length,
            options: optionCount,
            unknown: unknownArity,
          },
        );

        const handle = await ctx.writeResource(
          "surface",
          dataName("surface", args.cli),
          {
            cli: args.cli,
            binary,
            binaryVersion: version,
            discoveredAt: new Date().toISOString(),
            commandCount: nodes.length,
            optionCount,
            unknownArityCount: unknownArity,
            failedCount: failed,
            truncated,
            surfacePath,
            commands: nodes.map((n) => [args.cli, ...n.path].join(" ")),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    classify: {
      description:
        "Propose a tier, an option allowlist, and an environment scrub list for every discovered command, then write the review file a person edits. Spawns `claude -p`.",
      arguments: ClassifyArgs,
      execute: async (
        args: ClassifyArgs,
        ctx: {
          globalArgs: GlobalArgs;
          repoDir: string;
          logger: Logger;
          signal: AbortSignal;
          writeResource: WriteResource;
          createFileWriter: CreateFileWriter;
        },
      ) => {
        const g = ctx.globalArgs;
        const dir = workspace(ctx.repoDir, g, args.cli);
        const crawled = await readJson<{
          cli: string;
          binary: string;
          binaryVersion: string;
          nodes: CrawlNode[];
        }>(`${dir}/surface.json`, "discovered surface");

        ctx.logger.info("Classifying {count} command(s) with docs {mode}", {
          count: crawled.nodes.length,
          mode: g.docsMode,
        });

        // Summed across every batch. The tally lives here rather than inside
        // classifyAll because what a run cost is a fact about the run, not an
        // input to any classification decision.
        let usage = zeroUsage();
        let calls = 0;

        const result = await classifyAll({
          cli: baseName(args.cli),
          nodes: crawled.nodes,
          batchSize: g.batchSize,
          docsMode: g.docsMode,
          helpFlag: helpOptionsOf(crawled.nodes)[0] ?? "",
          ask: spawnAsk({
            claudePath: g.claudePath,
            model: g.model,
            wallTimeoutMs: g.wallTimeoutMs,
            docsMode: g.docsMode,
            signal: ctx.signal,
            env: g.askEnv,
            cwd: askCwdFor(g, dir),
            onUsage: (u) => {
              usage = addUsage(usage, u);
              calls++;
            },
          }),
          onProgress: (done, total) =>
            ctx.logger.info("Classified {done} of {total}", { done, total }),
        });

        const scrub = [...new Set([...g.envScrub, ...result.envScrub])].sort();
        const proposed: Review = ReviewSchema.parse({
          // Stated rather than left to the schema default, because this is the
          // one field `classify` must never be able to set. It is not drawn
          // from `result`, so nothing the model session returns can reach it.
          approved: false,
          cli: baseName(args.cli),
          binary: crawled.binary,
          binaryVersion: crawled.binaryVersion,
          helpFlag: g.helpFlag,
          fallbackHelpFlag: g.fallbackHelpFlag,
          generatedAt: new Date().toISOString(),
          env: { scrub, set: {} },
          // Taken from the crawl rather than from the classifier: what the
          // tool calls its help flag is ground truth, not a judgement.
          helpOptions: helpOptionsOf(crawled.nodes),
          prefix: g.prefix,
          wrappers: result.wrappers,
          globalOptions: result.globalOptions,
          commands: result.commands,
        });

        // The proposal is checked against the crawl before anyone reads it, so
        // a reviewer is never asked to notice that a plausible-looking command
        // does not exist. An invented entry is dropped, not corrected.
        const problems = checkAgainstSurface(
          proposed,
          surfaceOf(crawled.nodes),
        );
        const review = pruneProblems(proposed, problems);
        if (problems.length > 0) {
          ctx.logger.warning("Discarded {count} entry(s) the crawl never saw", {
            count: problems.length,
          });
        }

        await ensureDir(dir);
        const reviewPath = `${dir}/review.yaml`;
        const yaml = toYaml(review);
        await Deno.writeTextFile(reviewPath, yaml);
        const fileHandle = await ctx.createFileWriter(
          "review",
          dataName("review", args.cli),
        )
          .writeText(yaml);

        const counts = tierCounts(review);
        ctx.logger.info(
          "Proposed {safe} read-safe, {private} read-private, {modify} modify, {escape} escape",
          {
            safe: counts["read-safe"],
            private: counts["read-private"],
            modify: counts["modify"],
            escape: counts["escape"],
          },
        );
        ctx.logger.info(
          "Cost {calls} call(s): {input} in, {output} out, {cacheRead} cache-read, {cacheCreation} cache-write, {cost} USD list, on {models}",
          {
            calls,
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheCreation: usage.cacheCreation,
            cost: usage.costUsd.toFixed(4),
            models: usage.models.join(", ") || "the caller's default",
          },
        );

        const handle = await ctx.writeResource(
          "proposal",
          dataName("proposal", args.cli),
          {
            cli: baseName(args.cli),
            reviewPath,
            classifiedAt: new Date().toISOString(),
            docsMode: g.docsMode,
            counts,
            rejected: problems.map((p) => p.message),
            notes: result.notes,
            usage: { ...usage, calls },
            nextAction:
              `Read ${reviewPath}. The read-safe block is the part that needs real ` +
              `attention: it is the only tier that runs with nobody watching. Read ` +
              `the wrappers block too — it is short, and a pinned option there ` +
              `applies at every command its alias admits. Edit freely, then set ` +
              `approved: true in that file. generate refuses to render anything ` +
              `while it is false.`,
          },
        );
        return { dataHandles: [handle, fileHandle] };
      },
    },

    // -----------------------------------------------------------------------
    generate: {
      description:
        "Render the wrappers, the permission snippet, and the skill snippet from the edited review file. Deterministic — writes executable files, writes no settings.",
      arguments: GenerateArgs,
      execute: async (
        args: GenerateArgs,
        ctx: {
          globalArgs: GlobalArgs;
          repoDir: string;
          logger: Logger;
          writeResource: WriteResource;
          createFileWriter: CreateFileWriter;
          extensionFile: (path: string) => string;
        },
      ) => {
        const g = ctx.globalArgs;
        const dir = workspace(ctx.repoDir, g, args.cli);
        const reviewPath = args.reviewPath ?? `${dir}/review.yaml`;

        let text: string;
        try {
          text = await Deno.readTextFile(reviewPath);
        } catch {
          throw new Error(
            `no review file at ${reviewPath} — run classify first.`,
          );
        }
        const review = fromYaml(text);

        // The human gate, and the only thing enforcing it. `classify` writes
        // this file with approved: false and cannot write anything else; every
        // other check in this model asks whether the table is internally
        // coherent, which a proposal nobody read passes just as easily as one
        // someone approved. Refusing here is what makes the difference between
        // those two visible to the machine.
        if (!review.approved) {
          throw new Error(
            `${reviewPath} is not approved, so nothing was rendered. Read it — ` +
              `the read-safe block and the wrappers block especially — then set ` +
              `approved: true at the top of that file and run generate again. ` +
              `Everything below read-safe stops at a prompt when it runs; ` +
              `read-safe does not, and a pinned option in wrappers applies at ` +
              `every command its alias admits.`,
          );
        }

        // Re-checked against the crawl here, and not only in `classify`.
        // Between those two methods sits the one step this design asks a human
        // to perform — editing this file — so the table that gets rendered is
        // never the table that was checked. An edit can invent a command, or
        // pin an option nothing tiered, exactly as a model session can; the
        // difference is that a person doing it means it, and still wants to be
        // told when the tool no longer has the command they just typed.
        const surface = await readJson<{ nodes: CrawlNode[] }>(
          `${dir}/surface.json`,
          "discovered surface",
        );
        const problems = checkAgainstSurface(review, surfaceOf(surface.nodes));
        if (problems.length > 0) {
          throw new Error(
            `${reviewPath} does not match what discover saw, so nothing was ` +
              `rendered:\n${
                problems.map((p) => `  - ${p.message}`).join("\n")
              }\nFix those entries and run generate again.`,
          );
        }

        // The parser that guards an allow rule is pasted into every wrapper
        // from this exact file, so the code enforcing the policy on disk is the
        // code this repository's test suite exercises. Only the data differs.
        const validateSource = await Deno.readTextFile(
          ctx.extensionFile("_lib/validate.ts"),
        );

        const denoPath = await resolveDeno(g.denoPath);
        ctx.logger.info("Wrappers will run under {deno}", { deno: denoPath });

        const binDir = binDirFor(ctx.repoDir, g);
        await ensureDir(binDir);

        const wrappers: {
          segment: string;
          name: string;
          purpose: string;
          path: string;
          commandCount: number;
        }[] = [];
        for (const spec of review.wrappers) {
          const policy = toPolicy(review, spec);
          const path = `${binDir}/${policy.name}`;
          await writeExecutable(
            path,
            renderWrapper(review, spec, validateSource, denoPath),
          );
          wrappers.push({
            segment: spec.segment,
            name: policy.name,
            purpose: spec.purpose,
            path,
            commandCount: policy.commands.length,
          });
          ctx.logger.info("Wrote {name} covering {count} command(s)", {
            name: policy.name,
            count: policy.commands.length,
          });
        }

        // An alias dropped from the review file has to be dropped from PATH,
        // and this is the only place that can happen. `bin/` is shared by every
        // wrapped tool, so nothing else ever enumerates it; a wrapper deleted
        // from the table but left on disk keeps enforcing the policy it was
        // rendered with, and the permission rule that grants its segment still
        // matches its name. That is the one way this model can leave a grant
        // standing that its own table no longer describes.
        const rendered = new Set(wrappers.map((w) => w.name));
        const removed: string[] = [];
        for (
          const name of await ownedWrappers(binDir, g.prefix, review.cli)
        ) {
          if (rendered.has(name)) continue;
          await Deno.remove(`${binDir}/${name}`);
          removed.push(name);
          ctx.logger.warning(
            "Removed {name}, which is no longer in the review file",
            { name },
          );
        }

        const settingsSnippet = renderSettings(review);
        const skillSnippet = renderSkill(review, binDir);
        const settingsPath = `${dir}/settings.snippet.json`;
        const skillPath = `${dir}/SKILL.snippet.md`;
        await Deno.writeTextFile(settingsPath, settingsSnippet);
        await Deno.writeTextFile(skillPath, skillSnippet);

        const settingsHandle = await ctx
          .createFileWriter("settings", dataName("settings", review.cli))
          .writeText(settingsSnippet);
        const skillHandle = await ctx
          .createFileWriter("skill", dataName("skill", review.cli))
          .writeText(skillSnippet);

        const handle = await ctx.writeResource(
          "generated",
          dataName("generated", review.cli),
          {
            cli: review.cli,
            generatedAt: new Date().toISOString(),
            binDir,
            settingsPath,
            skillPath,
            wrappers,
            removed,
            settingsSnippet,
            skillSnippet,
            nextAction:
              `Run verify, then hand the contents of ${settingsPath} to the person ` +
              `driving this and let them merge it into .claude/settings.json. ` +
              `Nothing here edits that file. If ${binDir} is not already on PATH, ` +
              `add it once — every wrapper for every tool is written there, so no ` +
              `later run asks for another PATH entry.`,
          },
        );
        return { dataHandles: [handle, settingsHandle, skillHandle] };
      },
    },

    // -----------------------------------------------------------------------
    verify: {
      description:
        "Prove every wrapper permits its own tier and refuses everything above it, using a check mode that never executes the wrapped tool.",
      arguments: VerifyArgs,
      execute: async (
        args: VerifyArgs,
        ctx: {
          globalArgs: GlobalArgs;
          repoDir: string;
          logger: Logger;
          writeResource: WriteResource;
        },
      ) => {
        const g = ctx.globalArgs;
        const dir = workspace(ctx.repoDir, g, args.cli);
        const reviewPath = `${dir}/review.yaml`;
        let review: Review;
        try {
          review = fromYaml(await Deno.readTextFile(reviewPath));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`could not read ${reviewPath}: ${reason}`);
        }

        const cases = buildCases(review);
        const results = runCases(review, cases);
        ctx.logger.info("Checked {count} case(s) in process", {
          count: results.length,
        });

        // The spawned sample asks a different question from the in-process
        // sweep: not "is the table coherent" but "does the script on disk agree
        // with it". A disagreement means the rendering lost something.
        const sample = sampleCases(results, g.spawnSamples);
        let mismatches = 0;
        const spawnFailures: CaseResult[] = [];
        for (const c of sample) {
          const path = `${binDirFor(ctx.repoDir, g)}/${c.wrapper}`;
          try {
            const { got, output } = await spawnCheck(
              path,
              c.argv,
              g.helpTimeoutMs,
            );
            if (got !== c.expect) {
              mismatches++;
              spawnFailures.push({
                ...c,
                got,
                ok: false,
                detail: `spawned: ${output}`,
              });
            }
          } catch (error) {
            mismatches++;
            const reason = error instanceof Error
              ? error.message
              : String(error);
            spawnFailures.push({
              ...c,
              ok: false,
              detail: `spawned: ${reason}`,
            });
          }
        }

        const versionNow = await binaryVersion(review.binary, g.helpTimeoutMs);
        const drifted = review.binaryVersion !== "" && versionNow !== "" &&
          versionNow !== review.binaryVersion;
        if (drifted) {
          ctx.logger.warning(
            "{cli} is now {now} but the table was built against {then}; new subcommands are absent and will be refused",
            { cli: review.cli, now: versionNow, then: review.binaryVersion },
          );
        }

        const failed = [...results.filter((r) => !r.ok), ...spawnFailures];
        const ok = failed.length === 0;
        if (ok) {
          ctx.logger.info(
            "Every wrapper enforces its tier ({count} cases, {spawned} spawned)",
            {
              count: results.length,
              spawned: sample.length,
            },
          );
        } else {
          ctx.logger.warning("{count} case(s) failed", {
            count: failed.length,
          });
        }

        const handle = await ctx.writeResource(
          "verification",
          dataName("verification", review.cli),
          {
            cli: review.cli,
            verifiedAt: new Date().toISOString(),
            ok,
            caseCount: results.length,
            failureCount: failed.length,
            spawnedCount: sample.length,
            spawnMismatchCount: mismatches,
            versionAtGenerate: review.binaryVersion,
            versionNow,
            drifted,
            failures: failed.slice(0, 100).map((f) => ({
              wrapper: f.wrapper,
              command: [f.wrapper, ...f.argv].join(" "),
              expected: f.expect,
              got: f.got,
              about: f.about,
              detail: f.detail,
            })),
          },
        );
        if (!ok) {
          throw new Error(
            `${failed.length} of ${results.length} verification case(s) failed; ` +
              `see the verification data for details. The wrappers were not removed — ` +
              `fix ${reviewPath} and run generate again before trusting them.`,
          );
        }
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    remove: {
      description:
        "Stop wrapping a tool: take its wrappers off PATH, and with purge also delete its review file and crawl. The permission rules are keyed on the segment rather than the tool, so they need no edit.",
      arguments: RemoveArgs,
      execute: async (
        args: RemoveArgs,
        ctx: {
          globalArgs: GlobalArgs;
          repoDir: string;
          logger: Logger;
          writeResource: WriteResource;
        },
      ) => {
        const g = ctx.globalArgs;
        const dir = workspace(ctx.repoDir, g, args.cli);
        const binDir = binDirFor(ctx.repoDir, g);

        // The same ownership rule `generate` prunes with, for the same reason:
        // bin/ is a directory on the operator's PATH holding every tool's
        // wrappers, so "this tool's" has to mean the closed segment set, an
        // exact or hyphen-qualified name, and the generator's own marker.
        const names = await ownedWrappers(binDir, g.prefix, args.cli);
        for (const name of names) {
          await Deno.remove(`${binDir}/${name}`);
          ctx.logger.info("Removed {name}", { name });
        }
        if (names.length === 0) {
          ctx.logger.warning(
            "No wrappers for {cli} were found in {binDir}, so nothing was taken off PATH",
            { cli: baseName(args.cli), binDir },
          );
        }

        let purgedWorkspace = "";
        if (args.purge) {
          try {
            await Deno.remove(dir, { recursive: true });
            purgedWorkspace = dir;
            ctx.logger.warning(
              "Purged {dir}, including the review file — the judgement is gone, not just the wrappers",
              { dir },
            );
          } catch {
            // Already absent is the state purge wanted, so it is not a failure.
            ctx.logger.info("No workspace at {dir} to purge", { dir });
          }
        }

        const handle = await ctx.writeResource(
          "removed",
          dataName("removed", args.cli),
          {
            cli: baseName(args.cli),
            removedAt: new Date().toISOString(),
            binDir,
            wrappers: names,
            purgedWorkspace,
            nextAction: purgedWorkspace
              ? `${
                baseName(args.cli)
              } is fully unwrapped. Running the workflow ` +
                `again starts from discover, and the tiers will be a fresh ` +
                `proposal rather than the table you approved before.`
              : `${baseName(args.cli)} is off PATH. ${dir} still holds the ` +
                `review file, so generate rebuilds the wrappers from the table ` +
                `you already approved — no reclassification, no second review.`,
          },
        );

        // Worth saying rather than leaving to be noticed: the settings snippet
        // grants `Bash(fka-safe:*)` and its siblings, which name the segment and
        // never the tool. Unwrapping one tool leaves those rules correct, and
        // they go on covering every other tool that is still wrapped.
        ctx.logger.info(
          "Removed {count} wrapper(s). The permission rules key on the segment, not the tool, so settings.json needs no edit",
          { count: names.length },
        );
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    tally: {
      description:
        "Read Claude Code transcripts and emit a per-tool usage profile: a ranked queue of the commands actually run, plus denials tallied separately. Deterministic — reads no CLI, spawns no model session.",
      arguments: TallyArgs,
      execute: async (
        args: TallyArgs,
        ctx: {
          globalArgs: GlobalArgs;
          repoDir: string;
          logger: Logger;
          writeResource: WriteResource;
        },
      ) => {
        const g = ctx.globalArgs;
        const root = args.root !== ""
          ? args.root
          : defaultTranscriptRoot(Deno.env.get("HOME") ?? "", ctx.repoDir);

        ctx.logger.info(
          "Reading transcripts under {root} over the last {days} day(s)",
          { root, days: args.windowDays },
        );
        const corpus = await buildCorpus(root, args.windowDays);
        if (corpus.transcriptsScanned === 0) {
          // An empty corpus is a LEGITIMATE state — a tool nobody has run
          // here yet — not a configuration mistake, so this warns rather
          // than throwing (finding N5). Throwing here used to abort
          // `swamp workflow run @skunk-ape/fka` at the very first step on a
          // fresh clone, a CI checkout, or any project Claude Code has not
          // been run in, even though discover, classify and generate never
          // read the profile tally produces.
          ctx.logger.warning(
            "no .jsonl transcripts found under {root} (resolved from " +
              "this project's directory) — continuing with an empty " +
              "corpus rather than failing the workflow at this step. If " +
              "Claude Code HAS actually been run here, check that path " +
              "exists first — a stale slug is the usual cause, not a " +
              "missing history. Only pass root explicitly once you have " +
              "confirmed transcripts really do live somewhere else: it " +
              "reads every command an agent has ever run, so widening it " +
              "to another project should stay a deliberate, rare choice.",
            { root },
          );
        }
        ctx.logger.info(
          "Scanned {n} transcript(s), {lines} line(s) ({unparsed} unparsed); " +
            "{refused} command(s) could not be confidently tokenised and were dropped" +
            "{boundNote}",
          {
            n: corpus.transcriptsScanned,
            lines: corpus.linesScanned,
            unparsed: corpus.linesUnparsed,
            refused: corpus.refusedCount,
            boundNote: corpus.pathBoundHits > 0
              ? `; ${corpus.pathBoundHits} invocation(s) hit the subcommand-path bound (reported, not silently truncated)`
              : "",
          },
        );

        const root2 = workRoot(ctx.repoDir, g);
        await ensureDir(root2);
        // corpus.json carries verbatim argv, raw command text, and denial
        // samples — real tokens and private paths can appear in any of them —
        // so both the directory and the file are tightened past ensureDir's
        // and writeTextFile's defaults (0755/0644, world-readable).
        await tightenPerms(root2, 0o700, ctx.logger, "the workspace root");
        const corpusPath = `${root2}/corpus.json`;
        // `mode` at creation closes the write-then-chmod race for a
        // brand-new file — it never exists at the wider default even for
        // the instant between write and chmod. It does NOT change the mode
        // of a file that already exists (a stale 0666 corpus.json from
        // before this fix, say), which is exactly why the explicit
        // `tightenPerms` call still follows it (finding N7).
        await Deno.writeTextFile(corpusPath, JSON.stringify(corpus, null, 2), {
          mode: 0o600,
        });
        await tightenPerms(corpusPath, 0o600, ctx.logger, "corpus.json");

        const ranked = rankByTool(corpus.invocations);
        const toolsSeen = [...ranked.keys()].sort();
        const wanted = args.tools.length > 0
          ? [...new Set(args.tools.map(baseName))]
          : toolsSeen;

        const handles = [
          await ctx.writeResource("corpus", "corpus", {
            generatedAt: corpus.generatedAt,
            root: corpus.root,
            windowDays: corpus.windowDays,
            transcriptsScanned: corpus.transcriptsScanned,
            linesScanned: corpus.linesScanned,
            linesUnparsed: corpus.linesUnparsed,
            refusedCount: corpus.refusedCount,
            pathBoundHits: corpus.pathBoundHits,
            invocationCount: corpus.invocations.length,
            denialCount: corpus.denials.length,
            toolsSeen,
            corpusPath,
            truncationBiasNote: TRUNCATION_BIAS_NOTE,
            nextAction:
              `Corpus written to ${corpusPath}, shared across every tool this ` +
              `machine has run — a later tally re-reads transcripts, but a ` +
              `later score does not. Run score once a tool has a review.yaml.` +
              (corpus.pathBoundHits > 0
                ? ` ${corpus.pathBoundHits} invocation(s) hit the ` +
                  `subcommand-path bound — a reported condition, not a ` +
                  `silent truncation, but worth reading before trusting the ` +
                  `ranked queue for those tools.`
                : "") + ` ${TRUNCATION_BIAS_NOTE}`,
          }),
        ];

        for (const tool of wanted) {
          const entries = ranked.get(tool) ?? [];
          const denials = rankDenials(corpus.denials, tool);
          const dir = workspace(ctx.repoDir, g, tool);
          await ensureDir(dir);
          // Command paths here can carry attacker-influenced free text past
          // N3's own mitigation (a whitespace-bearing token is excluded, but
          // an unquoted argument-shaped one is not) — tightened past
          // ensureDir's and writeTextFile's defaults for the same reason
          // corpus.json is (finding N7).
          await tightenPerms(dir, 0o700, ctx.logger, `${tool}'s workspace`);
          const profilePath = `${dir}/usage-profile.json`;
          await Deno.writeTextFile(
            profilePath,
            JSON.stringify(
              {
                cli: tool,
                generatedAt: corpus.generatedAt,
                windowDays: corpus.windowDays,
                commands: entries,
                denials,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
          await tightenPerms(
            profilePath,
            0o600,
            ctx.logger,
            "usage-profile.json",
          );
          const totalInvocations = entries.reduce((s, e) => s + e.count, 0);
          ctx.logger.info(
            "{tool}: {commands} distinct command(s), {total} invocation(s), {denied} denied",
            {
              tool,
              commands: entries.length,
              total: totalInvocations,
              denied: denials.length,
            },
          );
          handles.push(
            await ctx.writeResource(
              "usageProfile",
              dataName("usage-profile", tool),
              {
                cli: tool,
                generatedAt: corpus.generatedAt,
                windowDays: corpus.windowDays,
                commandCount: entries.length,
                totalInvocations,
                denialCount: denials.length,
                profilePath,
                top: entries.slice(0, 25),
                nextAction:
                  `${profilePath} is ${tool}'s usage queue, ranked by ` +
                  `frequency — scope discover and classify to it rather than ` +
                  `the tool's whole surface. Frequency is a coarse proxy, not ` +
                  `a priority ranking: a command run once that blocks an ` +
                  `unattended run may matter more than one run fifty times ` +
                  `interactively.`,
              },
            ),
          );
        }

        return { dataHandles: handles };
      },
    },

    // -----------------------------------------------------------------------
    score: {
      description:
        "Score an approved review file against the tallied corpus: false refusals (the babysitting number), leakage (a wrapper exceeding its own segment's ceiling), an optional coarse settings.json prompt estimate, and classifier agreement against the hand-labelled fixture. Deterministic — spawns nothing, runs nothing.",
      arguments: ScoreArgs,
      execute: async (
        args: ScoreArgs,
        ctx: {
          globalArgs: GlobalArgs;
          repoDir: string;
          logger: Logger;
          writeResource: WriteResource;
          extensionFile: (path: string) => string;
        },
      ) => {
        const g = ctx.globalArgs;
        const dir = workspace(ctx.repoDir, g, args.cli);
        const reviewPath = `${dir}/review.yaml`;
        let review: Review;
        try {
          review = fromYaml(await Deno.readTextFile(reviewPath));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`could not read ${reviewPath}: ${reason}`);
        }

        const corpus = await readJson<{ invocations: Invocation[] }>(
          `${workRoot(ctx.repoDir, g)}/corpus.json`,
          "corpus — run tally first",
        );
        const name = baseName(review.cli);
        const scoped = corpus.invocations.filter((i) => i.binary === name);

        // Read settings once, up front: it decides both which wrappers
        // `falseRefusals` treats as unattended (Decision A — a real ruleset
        // beats guessing from the segment name) and the coarse `wouldPrompt`
        // estimate below. A missing or malformed file is a config mistake,
        // not an internal error, so it gets a message naming the path and
        // the reason rather than a bare NotFound or SyntaxError.
        let settingsRuleset: SettingsRuleset | undefined;
        if (args.settingsPath !== "") {
          // The unwrap used to sit outside this try/catch — a settings file
          // whose content parses to valid JSON that is not an object (`null`,
          // a bare number, an array) threw a bare, uncaught TypeError from
          // `raw.permissions`, exactly what this block exists to prevent
          // (finding N8). Reading `raw` as `unknown` and narrowing inside the
          // same try closes that.
          try {
            const raw: unknown = JSON.parse(
              await Deno.readTextFile(args.settingsPath),
            );
            const asObject = raw && typeof raw === "object"
              ? raw as { permissions?: SettingsRuleset } & SettingsRuleset
              : undefined;
            settingsRuleset = asObject?.permissions ?? asObject;
          } catch (error) {
            const reason = error instanceof Error
              ? error.message
              : String(error);
            throw new Error(
              `could not read settings from ${args.settingsPath}: ${reason}`,
            );
          }
        }

        const { mode: falseRefusalMode, refusals, grantsNoWrapper } =
          falseRefusals(
            review,
            corpus.invocations,
            settingsRuleset,
          );
        const leaks = leakage(review, corpus.invocations);
        const refusalOccurrences = refusals.reduce(
          (sum, r) => sum + r.invocation.count,
          0,
        );

        let promptEstimate = {
          used: false,
          certainlyAllowedCount: 0,
          wouldPromptCount: 0,
        };
        if (settingsRuleset) {
          const estimates = wouldPrompt(settingsRuleset, scoped);
          promptEstimate = {
            used: true,
            certainlyAllowedCount: estimates.filter((e) =>
              e.certainlyAllowed
            ).length,
            wouldPromptCount: estimates.filter((e) =>
              !e.certainlyAllowed
            ).length,
          };
        }

        const labelled = await readJson<
          { entries: Parameters<typeof agreement>[1] }
        >(
          ctx.extensionFile("testdata/labelled.json"),
          "labelled fixture",
        );
        const agreementResult = agreement(review, labelled.entries);

        ctx.logger.info(
          "{cli}: {refusals} false refusal(s) ({occurrences} occurrence(s), " +
            "{mode} mode), {leaks} leak(s) out of {n} corpus invocation(s)",
          {
            cli: review.cli,
            refusals: refusals.length,
            occurrences: refusalOccurrences,
            mode: falseRefusalMode,
            leaks: leaks.length,
            n: scoped.length,
          },
        );
        if (leaks.length > 0) {
          ctx.logger.warning(
            "{count} invocation(s) are admitted by a wrapper above its " +
              "segment's own ceiling — the failure fail-closed exists to prevent",
            { count: leaks.length },
          );
        }
        if (agreementResult.mismatches.length > 0) {
          ctx.logger.warning(
            "{count} labelled command(s) are tiered differently than the fixture says",
            { count: agreementResult.mismatches.length },
          );
        }

        const handle = await ctx.writeResource(
          "score",
          dataName("score", review.cli),
          {
            cli: review.cli,
            scoredAt: new Date().toISOString(),
            corpusInvocationCount: scoped.length,
            falseRefusalMode,
            settingsGrantsNoWrapper: grantsNoWrapper,
            truncationBiasNote: TRUNCATION_BIAS_NOTE,
            falseRefusalCount: refusals.length,
            falseRefusalOccurrences: refusalOccurrences,
            falseRefusalSamples: refusals.slice(0, 20).map((r) => ({
              command: [r.invocation.binary, ...r.invocation.argv].join(" "),
              count: r.invocation.count,
            })),
            leakageCount: leaks.length,
            leakageSamples: leaks.slice(0, 20).map((l) => ({
              wrapper: l.wrapper,
              command: [l.invocation.binary, ...l.invocation.argv].join(" "),
              commandTier: l.commandTier,
              segmentCeiling: l.segmentCeiling,
            })),
            promptEstimate,
            agreement: agreementResult,
            nextAction: leaks.length > 0
              ? `Fix ${reviewPath} before trusting any wrapper generated ` +
                `from it: leakage means a wrapper admits a command tiered ` +
                `above what its own segment promises.`
              : grantsNoWrapper
              ? `settingsPath grants not a single wrapper by name — before ` +
                `trusting these ${refusalOccurrences} occurrence(s) as the ` +
                `babysitting count, confirm settingsPath actually names ` +
                `the aliases fka generated (e.g. ` +
                `"${review.prefix}-safe-${baseName(review.cli)}"), not ` +
                `fka's own per-segment snippet — Claude Code's matching is ` +
                `token-bounded, so "Bash(${review.prefix}-safe:*)" does ` +
                `not cover a hyphenated alias name. This is a settings ` +
                `mismatch to check, not a claim that ${reviewPath} is ` +
                `unsafe. ${TRUNCATION_BIAS_NOTE}`
              : refusals.length > 0
              ? `${refusalOccurrences} corpus invocation occurrence(s) ` +
                `(${refusals.length} distinct command shape(s)) still cost ` +
                `a prompt or a refusal, decided in ${falseRefusalMode} mode` +
                (falseRefusalMode === "segment-bucket"
                  ? " (pass settingsPath for the real answer — a pinned " +
                    "alias an operator has actually allowed does not show " +
                    "up in this fallback)"
                  : "") +
                `. Add the missing ones to ${reviewPath}, or accept the ` +
                `babysitting — this is the number that measures it. ` +
                TRUNCATION_BIAS_NOTE
              : `No false refusals (${falseRefusalMode} mode) and no ` +
                `leakage against this corpus. Run verify before trusting ` +
                `the wrappers on disk, and re-run tally periodically — ` +
                `this score is only as current as the corpus it read. ` +
                TRUNCATION_BIAS_NOTE,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
