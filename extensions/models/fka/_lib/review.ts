/**
 * The approved table: tiers, the review file a person edits, and the policies
 * derived from it.
 *
 * This module is the join between the three stages that surround the human
 * gate. `classify` produces a {@link Review} and writes it as YAML. A person
 * edits that YAML. `generate` reads the edited file back and turns it into one
 * {@link Policy} per tier. Nothing downstream of the gate ever sees the
 * classifier's original proposal, which is the whole point of the arrangement.
 *
 * Every default here resolves toward refusal. An option nobody tiered, a
 * command that was not in the discovered surface, a value pattern that will not
 * compile — each drops out of the allowlist rather than into it.
 */

import { z } from "npm:zod@4";
import { Document, parse } from "npm:yaml@2.8.3";
import type { OptionSpec, Policy } from "./validate.ts";
import type { CrawlNode } from "./help.ts";

/** Tiers, least to most dangerous. The order is load-bearing: see {@link tierRank}. */
export const TIERS = ["read-safe", "read-private", "modify", "escape"] as const;
export type Tier = typeof TIERS[number];

/**
 * Where a tier sits on the danger axis.
 *
 * A wrapper for tier T admits every command at rank T or below, so `gh-write`
 * runs `gh pr list` as well as `gh pr close` and nobody needs three wrappers on
 * their `PATH` to do one job. The containment that matters runs the other way:
 * nothing above T is reachable from T's wrapper, which is what makes
 * `read-safe` worth an `allow` rule.
 */
export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

export const TIER_MEANING: Record<Tier, string> = {
  "read-safe":
    "Changes nothing, reveals nothing confidential. The only tier that runs unattended.",
  "read-private":
    "Changes nothing, but reads secrets, private source, identity, or billing.",
  "modify": "Changes state — local files, remote resources, money.",
  "escape":
    "Hands over arbitrary code execution, or names a program or endpoint to reach.",
};

/**
 * The second word of every wrapper name, and a closed set.
 *
 * A wrapper is called `<prefix>-<segment>-<name>`, so `fka-safe-gh`. The
 * segment has to come from a fixed vocabulary because it is what permission
 * rules key on: `Bash(fka-safe:*)` means something only if nothing can invent
 * `fka-mostly-safe-gh` and land outside every rule. Which commands go in which
 * segment is judgement; the set of segments is not.
 *
 * `help` is not a tier and does not sit on the tier ladder. Tiers partition
 * what a command does to the world; help is a mode outside that axis — asking
 * a tool to describe itself is not a kind of command at all. Its own segment
 * also means an operator can grant `Bash(fka-help:*)` and nothing else, which
 * is a real starting position.
 */
export const SEGMENTS = [
  "help",
  "safe",
  "private",
  "write",
  "escape",
] as const;
export type Segment = typeof SEGMENTS[number];

/** Which permission bucket a segment belongs in. */
export const SEGMENT_BUCKET: Record<Segment, "allow" | "ask"> = {
  help: "allow",
  safe: "allow",
  private: "ask",
  write: "ask",
  escape: "ask",
};

export const SEGMENT_MEANING: Record<Segment, string> = {
  help:
    "Asks the tool to describe itself. Runs no command and reads nothing else.",
  safe: "Changes nothing, reveals nothing confidential. Runs unattended.",
  private:
    "Changes nothing, but reads secrets, private source, identity, or billing.",
  write: "Changes state — local files, remote resources, money.",
  escape:
    "Hands over arbitrary code execution, or names a program or endpoint to reach.",
};

/** The segment a tier's commands land in when nothing says otherwise. */
export const SEGMENT_OF_TIER: Record<Tier, Segment> = {
  "read-safe": "safe",
  "read-private": "private",
  "modify": "write",
  "escape": "escape",
};

/**
 * The tier ceiling a segment implies, for a spec that does not state one.
 *
 * `help` has none: reading what `gh repo delete` does is not deleting
 * anything, so a help alias reaches every command in the table. That makes
 * `fka-help-*` broader in coverage than `fka-safe-*` while being narrower in
 * what it can do, which is correct and surprising enough to say out loud.
 */
export const SEGMENT_CEILING: Record<Segment, Tier | null> = {
  help: null,
  safe: "read-safe",
  private: "read-private",
  write: "modify",
  escape: "escape",
};

/** Strip any directory part: a wrapper is named for the tool, not its path. */
export function baseName(cli: string): string {
  const parts = cli.split("/");
  return parts[parts.length - 1] || cli;
}

/**
 * `fka-safe-gh`.
 *
 * Prefix matching is what makes this hierarchy useful rather than decorative.
 * `Bash(fka-safe:*)` grants every safe wrapper of every tool ever wrapped,
 * `Bash(fka-safe-gh:*)` narrows to one tool, and `Bash(fka-safe-gh-pr:*)`
 * to one alias — the same rule syntax at three levels of scope.
 */
export function wrapperName(
  prefix: string,
  segment: Segment,
  name: string,
): string {
  return `${prefix}-${segment}-${name}`;
}

const TierSchema = z.enum(TIERS);

const ReviewOptionSchema = z.object({
  /** 0 for a flag, 1 for an option taking a value. Never inferred here. */
  arity: z.union([z.literal(0), z.literal(1)]),
  /**
   * Tier of the option itself, when it differs from its command's.
   *
   * This field is why `git log` can be `read-safe` while `git log --ext-diff`
   * is not. Tiering only whole commands would force the entire command out of
   * the safe wrapper because one of its forty options runs a program.
   */
  tier: TierSchema.optional(),
  valuePattern: z.string().optional(),
  allowOptionLikeValue: z.boolean().optional(),
  note: z.string().optional(),
});
export type ReviewOption = z.infer<typeof ReviewOptionSchema>;

/** A global option must state its tier: there is no command to inherit one from. */
const GlobalOptionSchema = ReviewOptionSchema.extend({ tier: TierSchema });

const ReviewCommandSchema = z.object({
  /** Command path below the binary. Empty is the bare command. */
  path: z.array(z.string().min(1)),
  tier: TierSchema,
  /** The tool's own one-line description, carried through for the reviewer. */
  summary: z.string().default(""),
  /** Why this tier. The sentence a reviewer checks rather than the tier alone. */
  why: z.string().default(""),
  options: z.record(z.string(), ReviewOptionSchema).default({}),
  positionals: z.enum(["none", "any"]).optional(),
  positionalPattern: z.string().optional(),
  maxPositionals: z.number().int().nonnegative().optional(),
  /** Options `discover` saw that are not allowlisted, mapped to the reason. */
  dropped: z.record(z.string(), z.string()).default({}),
});
export type ReviewCommand = z.infer<typeof ReviewCommandSchema>;

const SegmentSchema = z.enum(SEGMENTS);

const AdmitsSchema = z.object({
  /** Commands at this tier or below. Omit to admit every command in the table. */
  maxTier: TierSchema.optional(),
  /** Exactly these command paths. Omit to admit everything within `maxTier`. */
  paths: z.array(z.array(z.string().min(1))).optional(),
}).default({});

const WrapperSpecSchema = z.object({
  segment: SegmentSchema,
  /**
   * What follows the segment. Usually the tool, sometimes tool plus qualifier.
   *
   * `gh` gives `fka-safe-gh`; `gh-pr` gives `fka-safe-gh-pr`, which an operator
   * can grant on its own without granting the rest of gh.
   */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** One line on what this alias is for. Shown to the agent in the skill. */
  purpose: z.string().default(""),
  /**
   * Tokens pinned in front of whatever the caller writes.
   *
   * Pinning beats permitting: `fka-safe-gh-pr` that prepends `pr` is a wrapper
   * for the pull-request subtree by construction, not by a rule that could be
   * argued with.
   */
  prepend: z.array(z.string()).default([]),
  /**
   * Tokens pinned after the caller's.
   *
   * How an alias becomes an answer rather than a permission. A help wrapper
   * appends the help flag itself, so nothing the caller writes decides whether
   * help happens.
   */
  append: z.array(z.string()).default([]),
  admits: AdmitsSchema,
  /**
   * What the caller may supply beyond the command path.
   *
   * `table` follows the review's own option and positional entries.
   * `path-only` accepts a command path and nothing else — no options, no
   * positionals — so the only argument vector that can reach the tool is the
   * path plus whatever this spec pins. That is the whole of a help alias.
   */
  accepts: z.enum(["table", "path-only"]).default("table"),
});
export type WrapperSpec = z.infer<typeof WrapperSpecSchema>;

export const ReviewSchema = z.object({
  cli: z.string().min(1),
  /** Absolute path, resolved at discover time. */
  binary: z.string().min(1),
  binaryVersion: z.string().default(""),
  helpFlag: z.string().default("--help"),
  generatedAt: z.string().default(""),
  /**
   * The first word of every generated wrapper name.
   *
   * One shared prefix across every tool is what turns per-tool permission
   * bookkeeping into a handful of rules that never change: wrap a new tool and
   * `Bash(fka-safe:*)` already covers its safe alias. The cost is that the
   * review gate becomes the only thing standing between running the workflow
   * and new commands running unattended, which is the trade this design makes
   * on purpose.
   */
  prefix: z.string().regex(/^[a-z][a-z0-9-]*$/).default("fka"),
  /**
   * The aliases to generate.
   *
   * Not a fixed set of tier wrappers. Which aliases a tool wants is judgement
   * about that tool — one path-taking help wrapper where the tree is regular,
   * a pinned alias per command where it is not — proposed by the classifier
   * against the guidelines and settled by whoever edits this file.
   */
  wrappers: z.array(WrapperSpecSchema).default([]),
  env: z.object({
    scrub: z.array(z.string()).default([]),
    set: z.record(z.string(), z.string()).default({}),
  }).default({ scrub: [], set: {} }),
  /**
   * The tool's own spellings for "describe yourself".
   *
   * A fact about the tool rather than a policy: observed by the crawl, recorded
   * for whoever plans the wrappers. An alias that pins one of these is how help
   * becomes reachable, and that decision belongs in the plan, not here.
   */
  helpOptions: z.array(z.string()).default([]),
  globalOptions: z.record(z.string(), GlobalOptionSchema).default({}),
  commands: z.array(ReviewCommandSchema).default([]),
});
export type Review = z.infer<typeof ReviewSchema>;

// ---------------------------------------------------------------------------
// Policy derivation
// ---------------------------------------------------------------------------

function toSpec(o: ReviewOption): OptionSpec {
  const spec: OptionSpec = { arity: o.arity };
  if (o.valuePattern !== undefined) spec.valuePattern = o.valuePattern;
  if (o.allowOptionLikeValue) spec.allowOptionLikeValue = true;
  return spec;
}

/** An option's own tier, or its command's when it does not state one. */
function optionTier(o: ReviewOption, fallback: Tier): Tier {
  return o.tier ?? fallback;
}

/**
 * Build the policy one wrapper enforces.
 *
 * Filtering happens twice, once over commands and once over each command's
 * options, because the two are tiered independently. A command that survives
 * the first filter can still lose most of its options to the second.
 */
export function toPolicy(review: Review, spec: WrapperSpec): Policy {
  const ceilingTier = spec.admits.maxTier ?? SEGMENT_CEILING[spec.segment];
  // No ceiling means every command in the table, which is what a help alias
  // wants: it reaches `gh repo delete` because asking is not doing.
  const ceiling = ceilingTier === null
    ? Number.POSITIVE_INFINITY
    : tierRank(ceilingTier);
  const only = spec.admits.paths
    ? new Set(spec.admits.paths.map((p) => p.join(" ")))
    : null;
  const pathOnly = spec.accepts === "path-only";

  const globalOptions: Record<string, OptionSpec> = {};
  if (!pathOnly) {
    for (const [name, opt] of Object.entries(review.globalOptions)) {
      if (tierRank(opt.tier) <= ceiling) globalOptions[name] = toSpec(opt);
    }
  }
  // The tokens this wrapper pins have to be legal in the policy that judges
  // them, because the check runs over the effective vector and not the
  // caller's. Deriving them here rather than asking the table keeps a pin and
  // its permission from ever disagreeing.
  Object.assign(
    globalOptions,
    pinnedOptions([...spec.prepend, ...spec.append]),
  );

  const commands = review.commands
    .filter((c) =>
      tierRank(c.tier) <= ceiling && (!only || only.has(c.path.join(" ")))
    )
    .map((c) => {
      if (pathOnly) {
        return { path: c.path, options: {}, positionals: "none" as const };
      }
      const options: Record<string, OptionSpec> = {};
      for (const [name, opt] of Object.entries(c.options)) {
        if (tierRank(optionTier(opt, c.tier)) <= ceiling) {
          options[name] = toSpec(opt);
        }
      }
      return {
        path: c.path,
        options,
        positionals: c.positionals ?? "none" as const,
        ...(c.positionalPattern !== undefined
          ? { positionalPattern: c.positionalPattern }
          : {}),
        ...(c.maxPositionals !== undefined
          ? { maxPositionals: c.maxPositionals }
          : {}),
      };
    });

  return {
    cli: review.cli,
    name: wrapperName(review.prefix, spec.segment, spec.name),
    tier: spec.segment,
    prependArgs: [...spec.prepend],
    appendArgs: [...spec.append],
    binary: review.binary,
    binaryVersion: review.binaryVersion,
    globalOptions,
    commands,
    env: { scrub: [...review.env.scrub], set: { ...review.env.set } },
  };
}

/**
 * The plan a tool gets when nobody proposes a better one.
 *
 * Three tier wrappers and a help wrapper covers most tools, and is the shape
 * the guidelines tell the classifier to start from and depart from with a
 * reason. `escape` is absent on purpose: a wrapper for the commands that hand
 * over execution is something an operator asks for, not something a default
 * hands out.
 */
export function defaultWrappers(cli: string, helpFlag: string): WrapperSpec[] {
  const name = baseName(cli);
  const plan: WrapperSpec[] = [
    {
      segment: "safe",
      name,
      purpose: `${name} commands cleared to run unattended`,
      prepend: [],
      append: [],
      admits: { maxTier: "read-safe" },
      accepts: "table",
    },
    {
      segment: "private",
      name,
      purpose: `${name} commands that read private or billable data`,
      prepend: [],
      append: [],
      admits: { maxTier: "read-private" },
      accepts: "table",
    },
    {
      segment: "write",
      name,
      purpose: `${name} commands that change state`,
      prepend: [],
      append: [],
      admits: { maxTier: "modify" },
      accepts: "table",
    },
  ];
  if (helpFlag) {
    plan.unshift({
      segment: "help",
      name,
      purpose: `read the help for any ${name} command`,
      prepend: [],
      append: [helpFlag],
      admits: {},
      accepts: "path-only",
    });
  }
  return plan;
}

/**
 * Permissions for the tokens a wrapper pins.
 *
 * Arity comes from the shape of the pin itself: an option followed by a
 * non-option consumes it, anything else is a flag. Reading it off the pinned
 * list rather than the review table means `append: ["--format", "json"]`
 * cannot be rendered into a wrapper that then refuses its own argument.
 */
function pinnedOptions(tokens: readonly string[]): Record<string, OptionSpec> {
  const options: Record<string, OptionSpec> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("-") || token === "-") continue;
    const name = token.includes("=")
      ? token.slice(0, token.indexOf("="))
      : token;
    const next = tokens[i + 1];
    const takesValue = !token.includes("=") && next !== undefined &&
      !next.startsWith("-");
    options[name] = { arity: takesValue ? 1 : 0 };
    if (takesValue) i++;
  }
  return options;
}

// ---------------------------------------------------------------------------
// Checking a proposal against ground truth
// ---------------------------------------------------------------------------

/** What the crawl actually saw: command paths, and the options legal at each. */
export interface Surface {
  paths: Set<string>;
  optionsByPath: Map<string, Set<string>>;
  /** Options the crawl saw at the root, which most tools accept anywhere. */
  rootOptions: Set<string>;
  /**
   * Flags the crawl ran the tool with and got help back from.
   *
   * Observed rather than read off a page, so these are legal spellings even
   * when the tool never prints them in an option table.
   */
  provenFlags: Set<string>;
}

/**
 * The tool's own spellings for "describe yourself".
 *
 * Anchored on `--help`, and every other name printed on the same help line
 * comes with it — that is how `-h` gets in without guessing. `-h` on its own
 * is never taken, because it means human-readable sizes to `du`, `sort`, and
 * `ls`, and a wrapper that treats `sort -h` as a help request has mis-modelled
 * an option rather than allowlisted one.
 */
export function helpOptionsOf(nodes: readonly CrawlNode[]): string[] {
  const found = new Set<string>();
  for (const node of nodes) {
    if (!node.ok) continue;
    // The flag the crawl actually used is the strongest evidence there is: the
    // tool was run with it and answered. `git` never lists `--help` among its
    // options, so the option tables alone would find git no help flag.
    if (node.helpFlagUsed) found.add(node.helpFlagUsed);
    for (const opt of node.parsed.options) {
      if (!opt.names.includes("--help")) continue;
      // A help flag that takes a value is not a help flag we understand.
      if (opt.arity === 1) continue;
      for (const name of opt.names) found.add(name);
    }
  }
  return [...found].sort();
}

export function surfaceOf(nodes: readonly CrawlNode[]): Surface {
  const paths = new Set<string>();
  const optionsByPath = new Map<string, Set<string>>();
  let rootOptions = new Set<string>();
  const provenFlags = new Set<string>();
  for (const node of nodes) {
    if (!node.ok) continue;
    if (node.helpFlagUsed) provenFlags.add(node.helpFlagUsed);
    const key = node.path.join(" ");
    paths.add(key);
    const names = new Set<string>();
    for (const opt of node.parsed.options) {
      for (const n of opt.names) names.add(n);
    }
    optionsByPath.set(key, names);
    if (node.path.length === 0) rootOptions = names;
  }
  return { paths, optionsByPath, rootOptions, provenFlags };
}

/**
 * One thing the proposal got wrong, in a form the caller can act on.
 *
 * Structured rather than a sentence because the caller does not only report
 * these — it deletes what they point at. Matching a message back to the entry
 * it describes would put the fail-closed guarantee at the mercy of a reworded
 * string.
 */
export type Problem =
  | { kind: "unknown-command"; path: string[]; message: string }
  | { kind: "duplicate-command"; path: string[]; message: string }
  | { kind: "unknown-option"; path: string[]; option: string; message: string }
  | { kind: "unknown-global-option"; option: string; message: string }
  | { kind: "unknown-help-option"; option: string; message: string }
  | { kind: "bad-pattern"; pattern: string; message: string }
  | { kind: "bad-wrapper"; wrapper: string; message: string };

/**
 * Reject anything the classifier invented.
 *
 * The classifier reads help text from a binary the operator did not write and,
 * with docs enabled, pages off the network. It may re-tier what `discover`
 * found and it may correct an arity; it may not add a command or an option that
 * never appeared in the crawl. Returns one problem per finding, empty when the
 * proposal stays inside the observed surface.
 */
export function checkAgainstSurface(
  review: Review,
  surface: Surface,
): Problem[] {
  const problems: Problem[] = [];

  for (const option of Object.keys(review.globalOptions)) {
    if (!surface.rootOptions.has(option)) {
      problems.push({
        kind: "unknown-global-option",
        option,
        message:
          `global option "${option}" was never seen in ${review.cli} --help`,
      });
    }
  }

  // Help options are permitted at every command, so a spelling the tool never
  // printed would be an allowlist entry nobody grounded.
  const everySeen = new Set<string>([
    ...surface.rootOptions,
    ...surface.provenFlags,
  ]);
  for (const names of surface.optionsByPath.values()) {
    for (const name of names) everySeen.add(name);
  }
  for (const option of review.helpOptions) {
    if (!everySeen.has(option)) {
      problems.push({
        kind: "unknown-help-option",
        option,
        message:
          `help option "${option}" was never seen in ${review.cli}'s help output`,
      });
    }
  }

  const seen = new Set<string>();
  for (const cmd of review.commands) {
    const key = cmd.path.join(" ");
    const display = [review.cli, ...cmd.path].join(" ");
    if (seen.has(key)) {
      problems.push({
        kind: "duplicate-command",
        path: cmd.path,
        message: `command "${display}" appears more than once`,
      });
      continue;
    }
    seen.add(key);

    if (!surface.paths.has(key)) {
      problems.push({
        kind: "unknown-command",
        path: cmd.path,
        message: `command "${display}" was never seen in the crawl`,
      });
      continue;
    }
    // Options legal at a node include every ancestor's, because persistent
    // flags really do work that way and the crawl records them per page.
    const legal = new Set<string>(surface.rootOptions);
    for (let i = 0; i <= cmd.path.length; i++) {
      const at = surface.optionsByPath.get(cmd.path.slice(0, i).join(" "));
      if (at) { for (const n of at) legal.add(n); }
    }
    for (const option of Object.keys(cmd.options)) {
      if (!legal.has(option)) {
        problems.push({
          kind: "unknown-option",
          path: cmd.path,
          option,
          message:
            `option "${option}" on "${display}" was never seen in its help output`,
        });
      }
    }
  }

  for (const pattern of patternsIn(review)) {
    try {
      new RegExp(`^(?:${pattern})$`);
    } catch {
      problems.push({
        kind: "bad-pattern",
        pattern,
        message: `pattern "${pattern}" is not a valid regular expression`,
      });
    }
  }

  problems.push(...checkWrappers(review, surface));
  return problems;
}

/**
 * Check the alias plan itself.
 *
 * The plan is as much a classifier proposal as the tier table is, and it has
 * its own ways of being wrong: two aliases fighting over one name, a pinned
 * subcommand the tool does not have, an alias that admits nothing and so ships
 * a wrapper that refuses everything.
 */
function checkWrappers(review: Review, surface: Surface): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();

  for (const spec of review.wrappers) {
    const wrapper = wrapperName(review.prefix, spec.segment, spec.name);
    if (seen.has(wrapper)) {
      problems.push({
        kind: "bad-wrapper",
        wrapper,
        message: `two aliases are both called "${wrapper}"`,
      });
      continue;
    }
    seen.add(wrapper);

    // A pinned path component has to be a real command, or the wrapper writes
    // an argument vector the tool will reject on every call.
    const pinnedPath = spec.prepend.filter((t) => !t.startsWith("-"));
    if (pinnedPath.length > 0 && !surface.paths.has(pinnedPath.join(" "))) {
      problems.push({
        kind: "bad-wrapper",
        wrapper,
        message: `"${wrapper}" pins the command "${
          pinnedPath.join(" ")
        }", which was never seen in the crawl`,
      });
    }

    for (const path of spec.admits.paths ?? []) {
      if (!surface.paths.has(path.join(" "))) {
        problems.push({
          kind: "bad-wrapper",
          wrapper,
          message: `"${wrapper}" admits "${
            path.join(" ")
          }", which was never seen in the crawl`,
        });
      }
    }

    if (toPolicy(review, spec).commands.length === 0) {
      problems.push({
        kind: "bad-wrapper",
        wrapper,
        message:
          `"${wrapper}" admits no command at all and would refuse everything`,
      });
    }
  }

  return problems;
}

/**
 * Delete everything the problems point at, returning a review that is inside
 * the observed surface.
 *
 * Deleting rather than repairing, because there is no safe repair: an entry the
 * crawl never saw is either a hallucination or an instruction from a page the
 * classifier read, and neither deserves a second guess. A dropped command is
 * refused by every wrapper, which is the direction to fail in.
 */
export function pruneProblems(
  review: Review,
  problems: readonly Problem[],
): Review {
  const dropCommands = new Set<string>();
  const dropGlobals = new Set<string>();
  const dropHelp = new Set<string>();
  const dropWrappers = new Set<string>();
  const dropOptions = new Map<string, Set<string>>();

  for (const problem of problems) {
    switch (problem.kind) {
      case "unknown-command":
      case "duplicate-command":
        dropCommands.add(problem.path.join(" "));
        break;
      case "unknown-global-option":
        dropGlobals.add(problem.option);
        break;
      case "unknown-help-option":
        dropHelp.add(problem.option);
        break;
      case "unknown-option": {
        const key = problem.path.join(" ");
        const set = dropOptions.get(key);
        if (set) set.add(problem.option);
        else dropOptions.set(key, new Set([problem.option]));
        break;
      }
      case "bad-pattern":
        // A pattern that will not compile refuses everything it is attached to,
        // so the validator already fails closed. Reported, not pruned.
        break;
      case "bad-wrapper":
        dropWrappers.add(problem.wrapper);
        break;
    }
  }

  const globalOptions = Object.fromEntries(
    Object.entries(review.globalOptions).filter(([name]) =>
      !dropGlobals.has(name)
    ),
  );

  const commands = review.commands
    .filter((c) => !dropCommands.has(c.path.join(" ")))
    .map((c) => {
      const drop = dropOptions.get(c.path.join(" "));
      if (!drop) return c;
      const kept = Object.entries(c.options).filter(([name]) =>
        !drop.has(name)
      );
      const dropped = { ...c.dropped };
      for (const name of drop) {
        dropped[name] = "discarded: never seen in this command's help output";
      }
      return { ...c, options: Object.fromEntries(kept), dropped };
    });

  const helpOptions = review.helpOptions.filter((n) => !dropHelp.has(n));
  const wrappers = review.wrappers.filter((s) =>
    !dropWrappers.has(wrapperName(review.prefix, s.segment, s.name))
  );

  return { ...review, globalOptions, helpOptions, wrappers, commands };
}

function* patternsIn(review: Review): Generator<string> {
  for (const o of Object.values(review.globalOptions)) {
    if (o.valuePattern) yield o.valuePattern;
  }
  for (const c of review.commands) {
    if (c.positionalPattern) yield c.positionalPattern;
    for (const o of Object.values(c.options)) {
      if (o.valuePattern) yield o.valuePattern;
    }
  }
}

// ---------------------------------------------------------------------------
// The review file
// ---------------------------------------------------------------------------

/** Sort read-safe first, then by path, so the tier that needs reading is on top. */
export function sortCommands(commands: ReviewCommand[]): ReviewCommand[] {
  return [...commands].sort((a, b) =>
    tierRank(a.tier) - tierRank(b.tier) ||
    a.path.join(" ").localeCompare(b.path.join(" "))
  );
}

export function tierCounts(review: Review): Record<Tier, number> {
  const counts = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<
    Tier,
    number
  >;
  for (const c of review.commands) counts[c.tier]++;
  return counts;
}

function header(review: Review): string {
  const counts = tierCounts(review);
  const version = review.binaryVersion ? ` (${review.binaryVersion})` : "";
  const lines = [
    ` fka review — ${review.cli}${version}`,
    ` binary: ${review.binary}`,
    "",
    " This is a proposal from a language model. It grants nothing until you",
    " approve the workflow's review step, and `generate` reads THIS FILE, not",
    " the proposal it started from. Edit freely.",
    "",
    " Read the read-safe block carefully and skim the rest. Every other tier",
    " still stops at a prompt when it runs, so a mistake there costs you one",
    " keystroke. A mistake in read-safe runs with nobody watching.",
    "",
  ];
  for (const tier of TIERS) {
    const count = String(counts[tier]).padStart(4);
    lines.push(` ${tier.padEnd(13)} ${count}  ${TIER_MEANING[tier]}`);
  }
  lines.push(
    "",
    " A command absent from this list is refused by every wrapper. An option",
    " absent from its command is refused too, so deleting a line is always the",
    " safe edit. `dropped` records what discover saw and did not allowlist.",
  );
  return lines.join("\n");
}

/** Render the review as commented YAML for a person to edit. */
export function toYaml(review: Review): string {
  const ordered: Review = {
    ...review,
    commands: sortCommands(review.commands),
  };
  const doc = new Document(ordered);
  doc.commentBefore = header(ordered);

  const commands = doc.get("commands", true) as
    | { items?: { commentBefore?: string }[] }
    | undefined;
  if (commands?.items) {
    let previous: Tier | null = null;
    ordered.commands.forEach((cmd, i) => {
      if (cmd.tier === previous) return;
      const item = commands.items?.[i];
      if (item) {
        item.commentBefore = ` --- ${cmd.tier} ---\n ${TIER_MEANING[cmd.tier]}`;
      }
      previous = cmd.tier;
    });
  }

  return doc.toString({ lineWidth: 0 });
}

/** Parse an edited review file. A malformed edit is an error, never a default. */
export function fromYaml(text: string): Review {
  const raw = parse(text);
  if (raw === null || typeof raw !== "object") {
    throw new Error("the review file is empty or is not a YAML mapping");
  }
  const parsed = ReviewSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `the review file does not match the expected shape:\n${issues}`,
    );
  }
  return parsed.data;
}
