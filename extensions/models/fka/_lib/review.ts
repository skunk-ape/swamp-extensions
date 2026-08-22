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
 * The word that leads a wrapper's name. `modify` reads better as `write`.
 *
 * The tier goes in front rather than behind, and that ordering is a security
 * property rather than a style choice. Claude Code matches a Bash permission
 * rule by string prefix, so `Bash(gh:*)` matches every command line beginning
 * with `gh` — `gh-safe pr list` included. A suffix scheme therefore cannot say
 * "deny the raw tool, allow the safe wrapper": the deny rule swallows its own
 * exception, and deny wins.
 *
 * Leading with the tier also contains the one match nobody controls. The only
 * rules that can bleed into each other by prefix are rules within a tier —
 * `safe-gh` can only ever be a prefix of another `safe-*` wrapper — so
 * over-matching reaches something already judged safe.
 */
export const TIER_PREFIX: Record<Tier, string> = {
  "read-safe": "safe",
  "read-private": "private",
  "modify": "write",
  "escape": "escape",
};

/** Strip any directory part: a wrapper is named for the tool, not its path. */
export function baseName(cli: string): string {
  const parts = cli.split("/");
  return parts[parts.length - 1] || cli;
}

export function wrapperName(cli: string, tier: Tier): string {
  return `${TIER_PREFIX[tier]}-${baseName(cli)}`;
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

export const ReviewSchema = z.object({
  cli: z.string().min(1),
  /** Absolute path, resolved at discover time. */
  binary: z.string().min(1),
  binaryVersion: z.string().default(""),
  helpFlag: z.string().default("--help"),
  generatedAt: z.string().default(""),
  /** Which tiers get a wrapper. `escape` only ever appears here on request. */
  emit: z.array(TierSchema).min(1).default([
    "read-safe",
    "read-private",
    "modify",
  ]),
  env: z.object({
    scrub: z.array(z.string()).default([]),
    set: z.record(z.string(), z.string()).default({}),
  }).default({ scrub: [], set: {} }),
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
export function toPolicy(review: Review, tier: Tier): Policy {
  const ceiling = tierRank(tier);

  const globalOptions: Record<string, OptionSpec> = {};
  for (const [name, opt] of Object.entries(review.globalOptions)) {
    if (tierRank(opt.tier) <= ceiling) globalOptions[name] = toSpec(opt);
  }

  const commands = review.commands
    .filter((c) => tierRank(c.tier) <= ceiling)
    .map((c) => {
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
    name: wrapperName(review.cli, tier),
    tier,
    binary: review.binary,
    binaryVersion: review.binaryVersion,
    globalOptions,
    commands,
    env: { scrub: [...review.env.scrub], set: { ...review.env.set } },
  };
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
}

export function surfaceOf(nodes: readonly CrawlNode[]): Surface {
  const paths = new Set<string>();
  const optionsByPath = new Map<string, Set<string>>();
  let rootOptions = new Set<string>();
  for (const node of nodes) {
    if (!node.ok) continue;
    const key = node.path.join(" ");
    paths.add(key);
    const names = new Set<string>();
    for (const opt of node.parsed.options) {
      for (const n of opt.names) names.add(n);
    }
    optionsByPath.set(key, names);
    if (node.path.length === 0) rootOptions = names;
  }
  return { paths, optionsByPath, rootOptions };
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
  | { kind: "bad-pattern"; pattern: string; message: string };

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

  return { ...review, globalOptions, commands };
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
