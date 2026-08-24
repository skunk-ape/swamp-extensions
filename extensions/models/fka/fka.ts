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
import { classifyAll, spawnAsk } from "./_lib/classify.ts";
import { renderSettings, renderSkill, renderWrapper } from "./_lib/wrapper.ts";
import {
  buildCases,
  type CaseResult,
  runCases,
  sampleCases,
  spawnCheck,
} from "./_lib/verify.ts";

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
  model: z.string().default("claude-opus-5"),
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
  version: "2026.08.22.1",
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
  },
};
