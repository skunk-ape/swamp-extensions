/**
 * The argument-vector validator. This is the security boundary.
 *
 * ## Why this file has no imports
 *
 * `generate` inlines this file's source text, verbatim, into every wrapper it
 * writes. The wrapper that runs on your machine is therefore literally the
 * module this repo's test suite exercises — only the policy data differs. A
 * test asserts the inlined copy is byte-identical to this file, because a
 * tested boundary that ships as a separate reimplementation is a boundary that
 * has not been tested.
 *
 * So: no imports, no `Deno`, no I/O, no ambient state. A pure function from
 * (policy, argv) to a verdict. Keep it that way.
 *
 * ## The posture
 *
 * Deny by default, at every level. An unknown subcommand, an unknown option, an
 * option whose arity we are unsure of, a positional where none was permitted —
 * all refusals. The wrapper exists to be *more* restrictive than the CLI it
 * fronts, never less, so every ambiguity resolves toward "no".
 */

/** How many argv elements an option consumes after itself. */
export type Arity = 0 | 1;

export interface OptionSpec {
  /**
   * 0 for a flag, 1 for an option taking a value.
   *
   * This is the field most likely to cause a bypass if it is wrong. Suppose
   * `--limit` really takes no value, but we record arity 1: the wrapper
   * consumes the following token as a value and never inspects it, while the
   * real CLI reads that same token as another option — one that was never
   * checked against the allowlist. `discover` therefore takes arity from help
   * text that states it, and anything it cannot determine is left out of the
   * table entirely rather than guessed.
   */
  arity: Arity;
  /**
   * Permit a value that looks like an option.
   *
   * Off by default: if `--limit` consumes `--ext-diff`, that is either a
   * mis-modelled arity or a deliberate smuggle, and both deserve a refusal.
   * Bare `-` (stdin) and negative numbers are always allowed and do not need
   * this.
   */
  allowOptionLikeValue?: boolean;
  /** Anchored regex the value must match. The narrowest useful control. */
  valuePattern?: string;
}

export interface CommandRule {
  /** Command path below the binary. `["pr","list"]` for `gh pr list`. Empty is the bare command. */
  path: string[];
  /** Options permitted at this node, and inherited by its descendants. */
  options: Record<string, OptionSpec>;
  /**
   * Whether free positional arguments are accepted.
   *
   * Defaults to "none", and that default matters: `gh api <endpoint>` is a
   * harmless-looking subcommand whose entire risk surface is its positional.
   */
  positionals?: "none" | "any";
  /** Anchored regex each positional must match. */
  positionalPattern?: string;
  /** Cap on positional count. */
  maxPositionals?: number;
}

export interface EnvPolicy {
  /** Variables deleted before exec — the ones that name a program to run or a host to talk to. */
  scrub: string[];
  /** Variables forced to a fixed value before exec. */
  set: Record<string, string>;
}

export interface Policy {
  /** The wrapped tool, e.g. "gh". */
  cli: string;
  /**
   * The wrapper's own command name, e.g. "safe-gh".
   *
   * Refusals quote this rather than composing a name from `cli` and `tier`,
   * because the text a person reads has to be the word they actually typed —
   * a message about "gh-read-safe" sends them looking for a command that does
   * not exist.
   */
  name: string;
  /** Tier this wrapper enforces. */
  tier: string;
  /** Absolute path to the real binary, resolved at generate time so `PATH` cannot be aimed elsewhere. */
  binary: string;
  /** Version string captured at generate time, for drift reporting. */
  binaryVersion?: string;
  /**
   * Arguments this wrapper puts in front of whatever the caller wrote.
   *
   * A wrapper that pins part of the command line is stronger than one that
   * merely permits it, because the pinned tokens are not the caller's to
   * choose. `fka-safe-gh-pr` can prepend `pr` and be, by construction, a
   * wrapper for the pull-request subtree and nothing else.
   */
  prependArgs: string[];
  /**
   * Arguments appended after the caller's.
   *
   * This is how an alias becomes an answer rather than a permission. A help
   * wrapper appends `--help` itself, so no token the caller writes can decide
   * whether help happens — which is a different and better guarantee than
   * checking that they asked for it.
   */
  appendArgs: string[];
  /** Options accepted before any subcommand is named, e.g. `git -C <path> log`. */
  globalOptions: Record<string, OptionSpec>;
  /** One entry per permitted command. Anything absent is refused. */
  commands: CommandRule[];
  env: EnvPolicy;
}

/**
 * The vector that actually reaches the tool.
 *
 * Both the check and the exec run on this, never on the caller's argv, so
 * there is no gap between what was validated and what runs.
 */
export function effectiveArgv(
  policy: Policy,
  argv: readonly string[],
): string[] {
  return [...policy.prependArgs, ...argv, ...policy.appendArgs];
}

export type Verdict =
  | {
    ok: true;
    /** The resolved command path, for logging. */
    command: string[];
  }
  | {
    ok: false;
    /** Human-readable refusal, safe to print. */
    reason: string;
    /** The offending token, when there is one. */
    token?: string;
    /** Its index in argv. */
    index?: number;
  };

function deny(reason: string, token?: string, index?: number): Verdict {
  return { ok: false, reason, token, index };
}

/** `-` is stdin and `-5` is a number; neither is an option pretending to be a value. */
function looksLikeOption(v: string): boolean {
  if (v === "-" || !v.startsWith("-")) return false;
  return !/^-\d+(?:\.\d+)?$/.test(v);
}

export function matchesAnchored(pattern: string, value: string): boolean {
  // Anchored deliberately: an unanchored allowlist pattern is not an allowlist.
  // `new RegExp` on a policy-supplied string is safe here — the policy is a
  // reviewed local file, not attacker input — but a bad pattern must not throw
  // its way into an allow, so a malformed regex is a refusal.
  try {
    return new RegExp(`^(?:${pattern})$`).test(value);
  } catch {
    return false;
  }
}

/**
 * Key a path for lookup. The separator is written as an escape rather than a
 * literal NUL: a raw control byte in the source makes git call this file
 * binary, and the one file that most needs a readable diff is this one.
 */
function key(path: string[]): string {
  return path.join("\u0000");
}

/**
 * Validate one argument vector against one tier's policy.
 *
 * Walks argv left to right, resolving each token as an option, a subcommand, or
 * a positional, and refusing anything the policy does not name. Never mutates
 * argv: the wrapper passes the vector through to the real binary untouched, so
 * this parse must be at least as strict as the CLI's, never a rewrite of it.
 */
export function validate(policy: Policy, argv: readonly string[]): Verdict {
  const byPath = new Map<string, CommandRule>();
  for (const rule of policy.commands) byPath.set(key(rule.path), rule);

  // Children reachable from each node, so a bare word can be recognised as a
  // subcommand. Every prefix of every permitted command counts, otherwise
  // `gh pr list` would be unreachable whenever `gh pr` is not itself permitted.
  const children = new Map<string, Set<string>>();
  for (const rule of policy.commands) {
    for (let i = 0; i < rule.path.length; i++) {
      const parent = key(rule.path.slice(0, i));
      let set = children.get(parent);
      if (!set) children.set(parent, set = new Set());
      set.add(rule.path[i]);
    }
  }

  /**
   * Options legal at the current node: the globals, plus those of every
   * ancestor rule, plus the node's own.
   *
   * Inheritance mirrors how persistent flags actually behave, and it is safe
   * here for a narrower reason: every option in this table has already been
   * judged appropriate for this tier, so widening where one may appear cannot
   * admit anything the tier does not already permit.
   */
  const optionsAt = (path: string[]): Record<string, OptionSpec> => {
    const merged: Record<string, OptionSpec> = { ...policy.globalOptions };
    for (let i = 0; i <= path.length; i++) {
      const rule = byPath.get(key(path.slice(0, i)));
      if (rule) Object.assign(merged, rule.options);
    }
    return merged;
  };

  const path: string[] = [];
  let positionals = 0;
  let afterDashDash = false;

  const takePositional = (tok: string, i: number): Verdict | null => {
    const rule = byPath.get(key(path));
    const mode = rule?.positionals ?? "none";
    if (mode === "none") {
      // A rule below the root that takes no free arguments: the word really is
      // a stray argument, and naming the command it was handed to is the useful
      // thing to say.
      //
      // At the root the same branch would be wrong twice over. The word cannot
      // be a free argument there — the root declared it takes none — so it can
      // only be a subcommand the caller named and this tier does not admit,
      // which is a different problem with a different fix. And with `path`
      // empty the message renders as `"git "`, trailing space and nothing
      // after it. So the root falls through to the message below, which names
      // what the caller actually typed.
      if (rule && path.length > 0) {
        return deny(
          `"${policy.cli} ${
            path.join(" ")
          }" takes no free arguments under the ${policy.tier} policy`,
          tok,
          i,
        );
      }
      // No rule at this node, so the word cannot be an argument either. It read
      // as a positional only because it matched no subcommand — which for a
      // person at a terminal means they named a command that is not permitted,
      // and that is what the message should say.
      return deny(
        `"${
          [policy.cli, ...path, tok].join(" ")
        }" is not a permitted command under the ${policy.tier} policy`,
        tok,
        i,
      );
    }
    positionals++;
    if (
      rule?.maxPositionals !== undefined && positionals > rule.maxPositionals
    ) {
      return deny(
        `at most ${rule.maxPositionals} argument(s) permitted for "${policy.cli} ${
          path.join(" ")
        }"`,
        tok,
        i,
      );
    }
    if (
      rule?.positionalPattern && !matchesAnchored(rule.positionalPattern, tok)
    ) {
      return deny(
        `argument does not match the permitted pattern for "${policy.cli} ${
          path.join(" ")
        }"`,
        tok,
        i,
      );
    }
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];

    if (afterDashDash) {
      const bad = takePositional(tok, i);
      if (bad) return bad;
      continue;
    }

    // Everything after `--` is positional, never an option and never a
    // subcommand. `git log -- --ext-diff` asks about a file with a strange name.
    if (tok === "--") {
      afterDashDash = true;
      continue;
    }

    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq === -1 ? tok : tok.slice(0, eq);
      const attached = eq === -1 ? null : tok.slice(eq + 1);
      const spec = optionsAt(path)[name];
      if (!spec) {
        return deny(
          `option "${name}" is not permitted for "${policy.cli}${
            path.length ? " " + path.join(" ") : ""
          }" under the ${policy.tier} policy`,
          tok,
          i,
        );
      }
      if (attached !== null) {
        if (spec.arity === 0) {
          // `--flag=false` is how a cobra boolean is negated, so it has to work;
          // anything else attached to a flag means the arity is wrong.
          if (!/^(?:true|false|1|0)$/i.test(attached)) {
            return deny(`option "${name}" takes no value`, tok, i);
          }
        } else if (
          spec.valuePattern && !matchesAnchored(spec.valuePattern, attached)
        ) {
          return deny(
            `value for "${name}" does not match its permitted pattern`,
            tok,
            i,
          );
        }
        continue;
      }
      if (spec.arity === 1) {
        if (i + 1 >= argv.length) {
          return deny(`option "${name}" needs a value`, tok, i);
        }
        const value = argv[++i];
        if (looksLikeOption(value) && !spec.allowOptionLikeValue) {
          return deny(
            `"${value}" looks like an option, not a value for "${name}" — refusing rather than guessing which one the tool will believe`,
            value,
            i,
          );
        }
        if (spec.valuePattern && !matchesAnchored(spec.valuePattern, value)) {
          return deny(
            `value for "${name}" does not match its permitted pattern`,
            value,
            i,
          );
        }
      }
      continue;
    }

    if (tok.startsWith("-") && tok.length > 1) {
      // A short-option cluster. `-abc` is three flags, unless `-a` takes a
      // value in which case `bc` is that value. Guessing between those two
      // readings is a bypass, so each character is resolved in turn.
      const chars = tok.slice(1);
      const opts = optionsAt(path);
      for (let c = 0; c < chars.length; c++) {
        const name = `-${chars[c]}`;
        const spec = opts[name];
        if (!spec) {
          return deny(
            `option "${name}" is not permitted for "${policy.cli}${
              path.length ? " " + path.join(" ") : ""
            }" under the ${policy.tier} policy`,
            tok,
            i,
          );
        }
        if (spec.arity === 0) continue;
        const rest = chars.slice(c + 1);
        let value: string;
        if (rest.length > 0) {
          value = rest;
        } else {
          if (i + 1 >= argv.length) {
            return deny(`option "${name}" needs a value`, tok, i);
          }
          value = argv[++i];
          if (looksLikeOption(value) && !spec.allowOptionLikeValue) {
            return deny(
              `"${value}" looks like an option, not a value for "${name}" — refusing rather than guessing which one the tool will believe`,
              value,
              i,
            );
          }
        }
        if (spec.valuePattern && !matchesAnchored(spec.valuePattern, value)) {
          return deny(
            `value for "${name}" does not match its permitted pattern`,
            value,
            i,
          );
        }
        break; // the rest of the cluster was the value
      }
      continue;
    }

    // A bare word. It is a subcommand only while no positional has been taken —
    // which is how the CLIs themselves resolve it, front to back.
    if (positionals === 0 && children.get(key(path))?.has(tok)) {
      path.push(tok);
      continue;
    }

    const bad = takePositional(tok, i);
    if (bad) return bad;
  }

  const rule = byPath.get(key(path));
  if (!rule) {
    if (path.length === 0) {
      return deny(
        `"${policy.cli}" on its own is not permitted under the ${policy.tier} policy`,
      );
    }
    // Reached an intermediate node: `gh pr` is a real prefix but not a command.
    return deny(
      `"${policy.cli} ${
        path.join(" ")
      }" is not a permitted command under the ${policy.tier} policy — it is a prefix of one, not one itself`,
    );
  }

  return { ok: true, command: path };
}

/** Render a verdict as the single line a wrapper prints to stderr. */
export function explain(policy: Policy, verdict: Verdict): string {
  if (verdict.ok) return `${policy.name}: permitted (${policy.tier})`;
  const at = verdict.index === undefined ? "" : ` [argv ${verdict.index}]`;
  return `${policy.name}: refused${at}: ${verdict.reason}`;
}
