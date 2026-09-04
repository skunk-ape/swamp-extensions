/**
 * Scoring: measure a review file against a corpus, deterministically and
 * without spawning anything or running the wrapped CLI.
 *
 * This module does not reimplement wrapper matching. `_lib/review.ts` exports
 * `toPolicy(review, spec)` and `_lib/validate.ts` exports `validate(policy,
 * argv)`, and those are the exact functions the shipped wrappers run —
 * `generate` pastes `validate.ts` verbatim into every wrapper. Scoring
 * composes them over corpus invocations instead of building a second engine
 * that could quietly disagree with the one that actually runs.
 *
 * Two metrics, kept separate on purpose — see `DESIGN.md`, "What is proven,
 * and what is not":
 *
 * - {@link falseRefusals} — corpus invocations no unattended wrapper admits.
 *   "Unattended" is decided from a real `settings.json`-shaped ruleset when
 *   one is supplied — a wrapper is unattended when its full name is granted
 *   by `allow` and not revoked by `deny` — and falls back to the `help`/`safe`
 *   segment bucket only when no ruleset is available. This is the babysitting
 *   number: every one of these still costs a prompt, or is refused outright,
 *   however the table is edited elsewhere.
 * - {@link leakage} — a wrapper admitting a command whose own tier sits above
 *   the ceiling that wrapper's *segment* promises. Mechanical, and the same
 *   property `verify`'s synthetic case matrix already asserts; this reuses
 *   the derivation over real corpus argv rather than synthetic cases, so a
 *   review file edited after `verify` last ran is checked against what people
 *   actually typed.
 *
 * A third function, {@link wouldPrompt}, is a coarse, deliberately
 * conservative estimate of whether a `settings.json` permission ruleset would
 * prompt for a corpus invocation. It is a ranking and reporting aid, not the
 * metric of record — see the module doc for its limits.
 *
 * Neither `mis-tiering` (a command that is dangerous but was tiered
 * read-safe) is computable here. Usage says what was run, never what was
 * safe to run, so that question needs the hand-labelled fixture instead —
 * see `testdata/labelled.json` and the classifier-agreement check built on
 * it.
 *
 * @module
 */

import type { Review, Tier, WrapperSpec } from "./review.ts";
import {
  SEGMENT_BUCKET,
  SEGMENT_CEILING,
  tierRank,
  toPolicy,
  wrapperName,
} from "./review.ts";
import { effectiveArgv, validate } from "./validate.ts";
import type { Policy } from "./validate.ts";
import type { Invocation } from "./corpus.ts";

/**
 * Recover what the caller would have had to type AT THIS WRAPPER to produce
 * `recorded` — the exact argv a corpus invocation carries.
 *
 * The wrapper's own runtime (`wrapper.ts:92`) computes
 * `effectiveArgv(POLICY, Deno.args)`, where `Deno.args` is the RESIDUAL the
 * caller typed after the wrapper's pin, never the full recorded command.
 * Folding `effectiveArgv` over the full recorded argv — which this module
 * used to do — silently re-applies the pin on top of an argv that may
 * already contain it: for a wrapper that pins `prepend: ["model", "list"]`,
 * folding the recorded `["model", "list"]` through `effectiveArgv` yields
 * `["model", "list", "model", "list"]`, which `validate` correctly refuses
 * even though the wrapper's own fold — `effectiveArgv(policy, [])` — yields
 * `["model", "list"]` and permits it. That made `falseRefusals` invent a
 * prompt for a command a pinned wrapper already runs unattended, and made
 * `leakage` — the must-be-zero safety gate — silently return 0 through every
 * `prepend`-pinned wrapper, because nothing it admitted was ever checked
 * against the corpus at all (see finding N1).
 *
 * Returns the residual only when `recorded` actually begins with the
 * policy's `prependArgs` and ends with its `appendArgs` token-for-token — a
 * wrapper that pins `["model", "list"]` cannot have produced `git status`,
 * and crediting it with satisfying an invocation it can never type would be
 * the same error in the other direction. `undefined` means "not satisfiable
 * by this wrapper": the caller should treat that as a non-admission, not as
 * a validation failure to retry some other way.
 */
function residualArgv(
  policy: Policy,
  recorded: readonly string[],
): string[] | undefined {
  const { prependArgs, appendArgs } = policy;
  if (recorded.length < prependArgs.length + appendArgs.length) {
    return undefined;
  }
  for (let i = 0; i < prependArgs.length; i++) {
    if (recorded[i] !== prependArgs[i]) return undefined;
  }
  const bodyEnd = recorded.length - appendArgs.length;
  for (let i = 0; i < appendArgs.length; i++) {
    if (recorded[bodyEnd + i] !== appendArgs[i]) return undefined;
  }
  return recorded.slice(prependArgs.length, bodyEnd);
}

/**
 * Whether `policy`'s wrapper, run with whatever residual argv the caller
 * would actually have to type, produces exactly `recorded`. This is the
 * scoring-path equivalent of the wrapper's own
 * `effectiveArgv(POLICY, Deno.args)` fold — see {@link residualArgv} for why
 * folding `effectiveArgv` directly over `recorded` is the wrong vector.
 */
function admits(policy: Policy, recorded: readonly string[]): boolean {
  const residual = residualArgv(policy, recorded);
  if (residual === undefined) return false;
  return validate(policy, effectiveArgv(policy, residual)).ok;
}

function baseName(cli: string): string {
  const parts = cli.split("/");
  return parts[parts.length - 1] || cli;
}

/** Invocations of one review's tool, scoped out of a mixed-tool corpus. */
function corpusFor(
  review: Review,
  corpus: readonly Invocation[],
): Invocation[] {
  const name = baseName(review.cli);
  return corpus.filter((inv) => inv.binary === name);
}

// ---------------------------------------------------------------------------
// settings.json matching — shared by falseRefusals and wouldPrompt
// ---------------------------------------------------------------------------

export interface SettingsRuleset {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

/** One `Bash(...)` rule, split into its body and whether it carries a `:*` wildcard. */
interface BashRule {
  body: string;
  wildcard: boolean;
}

/**
 * Parse `Bash(<body>)` and `Bash(<body>:*)` entries out of a rule list.
 * Anything else — a `Read(...)` rule, a bare tool name — is not a Bash rule
 * and is ignored: it cannot match a shell invocation either way.
 */
function bashRules(rules: readonly string[]): BashRule[] {
  const found: BashRule[] = [];
  for (const rule of rules) {
    const m = /^Bash\((.*)\)$/.exec(rule.trim());
    if (!m) continue;
    let body = m[1];
    const wildcard = body.endsWith(":*");
    if (wildcard) body = body.slice(0, -2);
    found.push({ body, wildcard });
  }
  return found;
}

/**
 * Whether `command` matches one of `rules`, respecting the difference between
 * `Bash(foo)` — exact match only — and `Bash(foo:*)` — `foo` or anything
 * starting with `foo` followed by a word boundary (a space). Without the
 * boundary, `Bash(git:*)` would match `gitleaks detect` on a bare substring
 * test, and without distinguishing wildcard from exact, `Bash(git)` would
 * match `git push --force` the same way `Bash(git:*)` does — which is not
 * what the settings file says.
 */
function matchesBashRules(
  command: string,
  rules: readonly BashRule[],
): boolean {
  return rules.some((r) => {
    if (!r.wildcard) return command === r.body;
    return command === r.body || command.startsWith(`${r.body} `);
  });
}

/** A wrapper's full generated name, e.g. `fka-write-swamp-push-dry`. */
function fullWrapperName(review: Review, spec: WrapperSpec): string {
  return wrapperName(review.prefix, spec.segment, spec.name);
}

/**
 * Whether a permission rule set would let this wrapper run unattended: some
 * `allow` rule matches its full name, and neither a `deny` rule nor an `ask`
 * rule also matches it. Claude Code's own precedence is `deny` > `ask` >
 * `allow` — both a denied and an ask-covered wrapper still stop for a
 * person, so treating either as unattended would be the
 * over-widened-safety-net failure this whole scorer exists to avoid (finding
 * F12: `ask` used to be declared and never read here, which made this
 * function optimistic in exactly that direction).
 */
function wrapperAllowedBySettings(
  review: Review,
  spec: WrapperSpec,
  settings: SettingsRuleset,
): boolean {
  const name = fullWrapperName(review, spec);
  if (matchesBashRules(name, bashRules(settings.deny ?? []))) return false;
  if (matchesBashRules(name, bashRules(settings.ask ?? []))) return false;
  return matchesBashRules(name, bashRules(settings.allow ?? []));
}

// ---------------------------------------------------------------------------
// false refusals — the babysitting number
// ---------------------------------------------------------------------------

export interface FalseRefusal {
  invocation: Invocation;
}

/** Which method decided which wrappers count as "unattended" for {@link falseRefusals}. */
export type RefusalMode = "settings" | "segment-bucket";

export interface FalseRefusalsResult {
  /**
   * `"settings"` when a real `settings.json`-shaped ruleset was supplied and
   * decided the answer per wrapper; `"segment-bucket"` when it fell back to
   * "is this wrapper's segment normally an `allow` bucket" (`help` or
   * `safe`), which is a property of the *segment name*, not of what any
   * operator has actually granted.
   *
   * The two can and do disagree. A pinned alias like
   * `fka-write-swamp-push-dry` sits in the `write` segment — normally
   * `ask` — but an operator can `allow` that one name specifically without
   * allowing `write` generally (`"allow": ["Bash(fka-write-swamp-push-dry:*)"]`,
   * `"ask": ["Bash(fka-write:*)"]`). Under `segment-bucket` mode that pinned
   * alias is never unattended, so every corpus invocation it actually covers
   * — including one run 45 times without a prompt — counts as a false
   * refusal. That misreports the project's own flagship case, which is why
   * `settings` mode is preferred whenever a ruleset is available.
   */
  mode: RefusalMode;
  /**
   * `true` only in `"settings"` mode, and only when the supplied ruleset
   * grants not a single non-`help` wrapper by name — a distinct condition
   * from every wrapper being legitimately `ask` or `deny`'d, and one this
   * scorer cannot tell apart from that on its own.
   *
   * The renamed-segment naming defect that makes fka's own pasted snippet
   * (`Bash(<prefix>-<segment>:*)`) match none of the wrappers it names is
   * FKA-12's to fix, not this one's — but reporting a resulting maximal
   * `refusals` count as if the review TABLE were at fault would blame the
   * wrong artifact. When this is `true`, treat `refusals` as "settings mode
   * found nothing it recognises", not as "nothing in the table is safe" —
   * check `settingsPath` names the aliases fka actually generated before
   * trusting the count.
   */
  grantsNoWrapper: boolean;
  refusals: FalseRefusal[];
}

/**
 * Corpus invocations that no unattended wrapper permits.
 *
 * "Unattended" is decided from the real permission rules a caller actually
 * has, when `settings` is supplied: a wrapper is unattended exactly when
 * `settings.allow` grants its full name and `settings.deny` does not revoke
 * it — see {@link wrapperAllowedBySettings}. Without `settings` this falls
 * back to the segment's normal bucket (`help` and `safe` are usually
 * `allow`), which is a coarser question and can be wrong in exactly the
 * direction the pinning mechanism exists to fix — see {@link
 * FalseRefusalsResult.mode}.
 *
 * Every invocation this returns still needs a person: either some ask-tier
 * wrapper admits it and a prompt fires, or nothing in the table does and the
 * bare command is what runs (or is refused), which is the exact babysitting
 * this design set out to reduce and had never measured before there was a
 * corpus to measure against.
 *
 * Validated on the **residual** vector recovered by {@link admits}, not on
 * the caller's raw recorded argv — the same question the wrapper's own
 * runtime asks via `effectiveArgv(POLICY, Deno.args)` in `wrapper.ts`.
 * Folding `effectiveArgv` directly over the recorded argv would credit a
 * `help` or pinned wrapper with admitting an invocation it never actually
 * produces, and for a `prepend`-pinned wrapper would double the pinned
 * tokens and refuse an invocation that wrapper already runs unattended
 * today — see {@link residualArgv} (finding N1). A `help` wrapper appends
 * `--help` before it runs anything, so the corpus invocation `git push` is
 * never what a `help` wrapper does even though the bare path `push` might
 * validate against its table.
 */
export function falseRefusals(
  review: Review,
  corpus: readonly Invocation[],
  settings?: SettingsRuleset,
): FalseRefusalsResult {
  const mode: RefusalMode = settings ? "settings" : "segment-bucket";
  // "Unattended" (granted without a prompt) and "can satisfy an invocation"
  // are different questions, deliberately kept separate here. `settings` and
  // `SEGMENT_BUCKET` answer the first: whether an operator would be asked
  // before this wrapper runs. They say nothing about whether the wrapper, if
  // run, actually performs the corpus invocation in question. A `help`
  // wrapper is unattended by both measures — it sits in the `allow` bucket
  // and is commonly granted — but `fka-help-git push` runs `git push --help`,
  // never the bare `git push` a caller actually wanted. It can be granted;
  // it satisfies `git push --help` exactly and nothing that isn't itself a
  // help-flag invocation. (A corpus invocation that already IS `git push
  // --help` counts as a false refusal here too — the blanket exclusion below
  // is conservative on purpose, not a claim that a help wrapper satisfies
  // nothing at all.) So `help` is excluded here regardless of how it scores
  // above, and that exclusion is NOT a statement that operators shouldn't
  // grant it.
  const nonHelp = review.wrappers.filter((s) => s.segment !== "help");
  const unattended = nonHelp.filter((s) =>
    settings
      ? wrapperAllowedBySettings(review, s, settings)
      : SEGMENT_BUCKET[s.segment] === "allow"
  );
  // A ruleset that grants not a single wrapper by name is a distinct signal
  // from "every wrapper happens to be legitimately ask/deny" — see
  // `FalseRefusalsResult.grantsNoWrapper` (finding N2). Both look the same
  // from here (an empty `unattended` list), so the field just records
  // whether it happened; the caller decides what it means.
  const grantsNoWrapper = mode === "settings" && nonHelp.length > 0 &&
    unattended.length === 0;
  const policies = unattended.map((s) => toPolicy(review, s));
  const refusals: FalseRefusal[] = [];
  for (const inv of corpusFor(review, corpus)) {
    const admitted = policies.some((p) => admits(p, inv.argv));
    if (!admitted) refusals.push({ invocation: inv });
  }
  return { mode, grantsNoWrapper, refusals };
}

// ---------------------------------------------------------------------------
// leakage — a wrapper exceeding its own segment's promise
// ---------------------------------------------------------------------------

export interface Leak {
  wrapper: string;
  invocation: Invocation;
  /** The tier the matched command actually carries in the review file. */
  commandTier: string;
  /** The tier the wrapper's segment promises never to exceed. */
  segmentCeiling: string;
}

/**
 * Any invocation a wrapper admits whose matched command is tiered above that
 * wrapper's own **segment** ceiling — `fka-safe-*` admitting something the
 * review file itself tiers `modify`, say.
 *
 * Validated on the residual vector recovered by {@link residualArgv} — for
 * the same reason {@link falseRefusals} is: folding `effectiveArgv` directly
 * over the recorded argv re-applies a wrapper's pin on top of an argv that
 * may already contain it, which is checking the wrong vector (finding N1).
 *
 * `toPolicy` filters by `spec.admits.maxTier ?? SEGMENT_CEILING[segment]`, so
 * this can only fire when a `WrapperSpec` overrides `admits.maxTier` past what
 * its segment name promises — a human edit to `review.yaml`, not something
 * `classify` would propose. `verify`'s synthetic matrix already asserts the
 * table is internally coherent; this asks the same question of what people
 * actually ran, which can surface a wrapper nobody exercised with the
 * synthetic cases because no synthetic case happened to hit it.
 *
 * A `help`-segment wrapper is exempt: it has no ceiling by design (asking a
 * tool to describe itself is not a kind of command), so it cannot leak by this
 * definition.
 */
export function leakage(
  review: Review,
  corpus: readonly Invocation[],
): Leak[] {
  const byPath = new Map(review.commands.map((c) => [c.path.join(" "), c]));
  const found: Leak[] = [];
  const scoped = corpusFor(review, corpus);

  for (const spec of review.wrappers) {
    const segmentCeiling = SEGMENT_CEILING[spec.segment];
    if (segmentCeiling === null) continue; // help: no ceiling to exceed
    const ceilingRank = tierRank(segmentCeiling);
    const policy = toPolicy(review, spec);

    for (const inv of scoped) {
      const residual = residualArgv(policy, inv.argv);
      if (residual === undefined) continue; // not satisfiable by this wrapper
      const verdict = validate(policy, effectiveArgv(policy, residual));
      if (!verdict.ok) continue;
      const cmd = byPath.get(verdict.command.join(" "));
      if (!cmd) continue;
      if (tierRank(cmd.tier) > ceilingRank) {
        found.push({
          wrapper: policy.name,
          invocation: inv,
          commandTier: cmd.tier,
          segmentCeiling,
        });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// wouldPrompt — a coarse, conservative settings.json estimate
// ---------------------------------------------------------------------------

export interface PromptEstimate {
  invocation: Invocation;
  /**
   * Whether some `allow` rule matches this invocation's raw command, at a
   * word boundary, with no `deny` rule and no `ask` rule also matching it.
   * Still a coarse estimate — see the function doc — but no longer blind to
   * `deny` or `ask` (finding F12), and no longer confusing an exact-match
   * rule (`Bash(git)`, no `:*`) with a prefix rule (`Bash(git:*)`).
   */
  certainlyAllowed: boolean;
}

/**
 * Coarsely and conservatively estimate whether `settings` would prompt for
 * each corpus invocation.
 *
 * This does **not** replicate Claude Code's permission matcher — that
 * matcher is external, versioned, and not this project's to model exactly.
 * What it now does do: honour Claude Code's documented precedence, `deny` >
 * `ask` > `allow` (a matching `deny` or `ask` rule beats a matching `allow`
 * rule), and require a word boundary on a prefix match (`Bash(git:*)` no
 * longer marks `gitleaks detect` certainly-allowed just because the string
 * `"git"` is a substring of the command). What it still does not do — and
 * cannot, without reimplementing the matcher exactly — is know that
 * `command` here is only ever the **leading** segment of whatever was
 * actually typed (see corpus.ts's module doc on the compound-line bias):
 * `git log && rm -rf /tmp/x` is scored against `git log` alone, which is
 * optimistic in the same direction as {@link falseRefusals}'s documented
 * bias. Use this for ranking and reporting, never as the metric that decides
 * whether a wrapper is safe — {@link falseRefusals} and {@link leakage},
 * built on the exact validator the wrappers run, are that metric.
 */
export function wouldPrompt(
  settings: SettingsRuleset,
  corpus: readonly Invocation[],
): PromptEstimate[] {
  const allow = bashRules(settings.allow ?? []);
  const deny = bashRules(settings.deny ?? []);
  const ask = bashRules(settings.ask ?? []);
  return corpus.map((invocation) => {
    const command = [invocation.binary, ...invocation.argv].join(" ");
    const certainlyAllowed = !matchesBashRules(command, deny) &&
      !matchesBashRules(command, ask) &&
      matchesBashRules(command, allow);
    return { invocation, certainlyAllowed };
  });
}

// ---------------------------------------------------------------------------
// classifier agreement against the hand-labelled fixture — mis-tiering
// ---------------------------------------------------------------------------

/**
 * One hand-tiered ground-truth entry. Usage says what was run, never what
 * was safe to run, so mis-tiering — a genuinely dangerous command the
 * classifier put in `read-safe` — cannot be computed from a corpus alone.
 * This is the only source of truth for it, and it is a human artifact by
 * necessity: see `testdata/labelled.json`.
 */
export interface LabelledInvocation {
  binary: string;
  path: string[];
  tier: Tier;
  /**
   * When set, this entry labels that OPTION on that command rather than the
   * command itself, and is compared against the option's effective tier —
   * its own if it declares one, otherwise its command's.
   *
   * Command-level labels cannot see the failure this model exists to prevent.
   * `swamp extension push` is `modify` and `swamp extension push --dry-run`
   * changes nothing; `git log` is `read-safe` and `git log --ext-diff` runs a
   * program of the caller's choosing. A fixture without option entries scores
   * a classifier only where being wrong is cheapest.
   */
  option?: string;
  /**
   * Where this entry came from. `corpus` means it was drawn from a real
   * transcript window; `known-risk` means it was added because being wrong
   * about it is expensive, whether or not anyone has run it here. Both are
   * legitimate ground truth and they answer different questions — one asks
   * whether the classifier handles the work you actually do, the other
   * whether it catches what would hurt. Deliberately no `count` field: paths
   * shift while segmentation is provisional (see corpus.ts), so a count here
   * could not be kept re-derivable, and this fixture keeps provenance
   * instead of numbers that would need regenerating on every path change.
   */
  source?: "corpus" | "known-risk";
  note?: string;
}

export interface AgreementResult {
  /** Labelled entries for this review's tool. */
  total: number;
  /** Of those, how many the review file tiers at all. */
  scored: number;
  agreed: number;
  mismatches: {
    path: string[];
    option?: string;
    labelledTier: Tier;
    reviewTier: Tier;
    note?: string;
  }[];
  /** Labelled commands absent from the review file entirely — untiered, not mis-tiered. */
  missing: { path: string[]; option?: string; tier: Tier }[];
  /** Of the scored entries, how many carried an option label. */
  scoredOptions: number;
}

/**
 * Compare a review's own tiers against the labelled fixture for its tool.
 *
 * This is the only place mis-tiering can be checked, and only up to the
 * fixture's coverage: a command the fixture never labelled is neither agreed
 * nor mismatched, it is simply outside what this check can say anything
 * about. A `missing` entry — labelled but not in the review at all — is
 * reported separately, because an omission and a wrong tier are different
 * failures with different fixes: one needs the command added to the table,
 * the other needs its tier corrected.
 */
export function agreement(
  review: Review,
  labelled: readonly LabelledInvocation[],
): AgreementResult {
  const name = baseName(review.cli);
  const scoped = labelled.filter((l) => baseName(l.binary) === name);
  const byPath = new Map(review.commands.map((c) => [c.path.join(" "), c]));

  const mismatches: AgreementResult["mismatches"] = [];
  const missing: AgreementResult["missing"] = [];
  let agreed = 0;
  let scored = 0;
  let scoredOptions = 0;

  for (const l of scoped) {
    const cmd = byPath.get(l.path.join(" "));
    if (!cmd) {
      missing.push({ path: l.path, option: l.option, tier: l.tier });
      continue;
    }

    // An option entry is scored against the option's EFFECTIVE tier: its own
    // if it declares one, otherwise the command's, which is exactly how
    // `toPolicy` resolves it. `toPolicy` admits `review.globalOptions` at
    // EVERY command — that is what "global" means — so an option absent from
    // `cmd.options` is not automatically refused: it may be a global the
    // table already tiers, and reporting it `missing` there would claim a
    // command is safer than the table actually makes it. Only an option in
    // neither place is genuinely absent from the table, and only then is it
    // `missing` rather than mis-tiered — it is refused, which is safe.
    let reviewTier: Tier;
    if (l.option !== undefined) {
      const local = cmd.options[l.option];
      const global = review.globalOptions[l.option];
      if (local) {
        reviewTier = local.tier ?? cmd.tier;
      } else if (global) {
        reviewTier = global.tier;
      } else {
        missing.push({ path: l.path, option: l.option, tier: l.tier });
        continue;
      }
      scoredOptions++;
    } else {
      reviewTier = cmd.tier;
    }

    scored++;
    if (reviewTier === l.tier) {
      agreed++;
    } else {
      mismatches.push({
        path: l.path,
        option: l.option,
        labelledTier: l.tier,
        reviewTier,
        note: l.note,
      });
    }
  }

  return {
    total: scoped.length,
    scored,
    agreed,
    mismatches,
    missing,
    scoredOptions,
  };
}
