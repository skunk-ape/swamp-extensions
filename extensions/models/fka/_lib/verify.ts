/**
 * Proving the wrappers enforce the table, without running a single wrapped
 * command.
 *
 * Every check here rests on `FKA_CHECK=1`, which turns a wrapper into a
 * pure decision procedure: parse the argument vector, print the verdict, exit,
 * never exec. That is the only reason it is safe to run this at all — a suite
 * that proved `write-gh` works by letting it close a pull request would be a
 * worse problem than the one it verifies.
 *
 * The matrix runs twice, and the two runs answer different questions.
 *
 * In-process against the derived policies, it asks whether the *table* is
 * coherent: does every command reach its own tier, and does nothing reach a
 * tier below it. That sweep is complete because it is cheap.
 *
 * Spawned against the wrapper files on disk, it asks whether the *scripts* say
 * the same thing: that the shebang resolves, the policy survived being written
 * out, and the copy of the validator inside the file behaves like the module
 * this repository tests. That is sampled rather than exhaustive, because it
 * costs a process each and it is checking wiring rather than logic. Any
 * disagreement between the two runs is a failure, which is the point.
 */

import type { Review } from "./review.ts";
import { toPolicy, wrapperName } from "./review.ts";
import type { CommandRule, OptionSpec, Policy } from "./validate.ts";
import { matchesAnchored, validate } from "./validate.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

export interface Case {
  wrapper: string;
  argv: string[];
  expect: "permit" | "refuse";
  /** What this case is for, quoted back when it fails. */
  about: string;
}

/**
 * Build the matrix from the approved table.
 *
 * The refusal cases are the ones that matter. A wrapper that permits too little
 * is an annoyance someone notices in a minute; a wrapper that permits too much
 * is the failure this whole model exists to prevent, and it is silent.
 */
export function buildCases(review: Review): Case[] {
  const cases: Case[] = [];

  for (const spec of review.wrappers) {
    const wrapper = wrapperName(review.prefix, spec.segment, spec.name);
    const policy = toPolicy(review, spec);
    const admitted = new Set(policy.commands.map((c) => c.path.join(" ")));
    // What the caller types, once this alias's own pinned path is taken off
    // the front. `fka-safe-gh-pr` that prepends `pr` is called as `… list`.
    const pinnedDepth = spec.prepend.filter((t) => !t.startsWith("-")).length;
    const typed = (path: string[]) => path.slice(pinnedDepth);

    for (const cmd of review.commands) {
      const name = [review.cli, ...cmd.path].join(" ");
      const key = cmd.path.join(" ");
      const within = admitted.has(key);
      // A command this alias pins past cannot be typed at all: the caller
      // would have to write a path that contradicts the pin.
      if (pinnedDepth > 0 && typed(cmd.path).length === cmd.path.length) {
        continue;
      }

      cases.push({
        wrapper,
        argv: typed(cmd.path),
        expect: within ? "permit" : "refuse",
        about: within
          ? `${name} is admitted by ${wrapper}`
          : `${name} is outside ${wrapper}`,
      });

      if (!within) continue;

      // `path-only` is the whole claim of a pinned alias: the caller supplies
      // a command and nothing else. Every option in the table is a refusal.
      if (spec.accepts === "path-only") {
        for (const option of Object.keys(cmd.options).slice(0, 2)) {
          cases.push({
            wrapper,
            argv: [...typed(cmd.path), option],
            expect: "refuse",
            about:
              `${wrapper} takes a command path only, so ${option} is refused`,
          });
        }
        continue;
      }

      const rule = policy.commands.find((c) => c.path.join(" ") === key);
      for (const [option, spec_] of Object.entries(cmd.options)) {
        const argv = [...typed(cmd.path), option];
        if (spec_.arity === 1) argv.push("value");

        if (!rule?.options[option]) {
          cases.push({
            wrapper,
            argv,
            expect: "refuse",
            about: `${option} on ${name} is outside ${wrapper}`,
          });
          continue;
        }
        // A constrained value cannot be exercised with a made-up token: the
        // refusal would be the pattern doing its job, indistinguishable here
        // from the option being missing. Those are left to the reviewer.
        if (spec_.valuePattern) continue;
        cases.push({
          wrapper,
          argv,
          expect: "permit",
          about: `${option} is permitted on ${name} by ${wrapper}`,
        });
      }

      if (rule) {
        cases.push(...syntaxCases(policy, rule, wrapper, name, typed));
      }
    }

    // The bare alias, which for a pinned one is the pinned command itself.
    if (
      !admitted.has(spec.prepend.filter((t) => !t.startsWith("-")).join(" "))
    ) {
      cases.push({
        wrapper,
        argv: [],
        expect: "refuse",
        about: `${wrapper} on its own names no permitted command`,
      });
    }
  }

  return cases;
}

// ---------------------------------------------------------------------------
// Argument syntax
// ---------------------------------------------------------------------------

/**
 * Tokens chosen so a refusal can only mean one thing.
 *
 * A made-up positional has to be a word no tool would route as a subcommand,
 * or the parser resolves it as a path and the case proves nothing.
 */
const NOT_A_SUBCOMMAND = "fka-verify-not-a-subcommand";
const NONMATCHING = "fka-verify-nonmatching-value";

/** The options legal at a path: globals, plus every rule along the way. */
function optionsAlong(
  policy: Policy,
  path: readonly string[],
): Record<string, OptionSpec> {
  const merged: Record<string, OptionSpec> = { ...policy.globalOptions };
  for (let i = 0; i <= path.length; i++) {
    const key = path.slice(0, i).join(" ");
    const rule = policy.commands.find((c) => c.path.join(" ") === key);
    if (rule) Object.assign(merged, rule.options);
  }
  return merged;
}

/**
 * The syntax families, which the command-and-option sweep never reaches.
 *
 * That sweep asks whether each command and each option is on the right side of
 * the line. It builds one argument vector shape — path, option, maybe the word
 * "value" — so a whole class of question goes unasked: what `--` does, whether
 * an attached value is checked like a separate one, whether a short cluster is
 * resolved character by character, whether a positional is accepted where the
 * table says none. Those are all places a parser can be wrong while every
 * command still lands in the right tier, which is exactly the failure this
 * model exists to catch and exactly the failure a coherence check cannot see.
 *
 * Each case is emitted only when its outcome is unambiguous. A refusal that
 * could have come from either the rule under test or an unrelated constraint
 * proves nothing, so where a pattern or a cap could be doing the refusing, the
 * case is skipped rather than asserted.
 */
function syntaxCases(
  policy: Policy,
  rule: CommandRule,
  wrapper: string,
  name: string,
  typed: (path: string[]) => string[],
): Case[] {
  const cases: Case[] = [];
  const base = typed(rule.path);
  const permitted = optionsAlong(policy, rule.path);
  const mode = rule.positionals ?? "none";
  const unconstrained = mode === "any" && !rule.positionalPattern &&
    rule.maxPositionals === undefined;

  // `--` ends the options, so everything after it is a positional however much
  // it looks like a flag. The refusal case is the load-bearing one: it is the
  // difference between "options are checked" and "arguments are checked".
  if (mode === "none") {
    cases.push({
      wrapper,
      argv: [...base, "--", NOT_A_SUBCOMMAND],
      expect: "refuse",
      about:
        `${name} takes no positional, so a word after -- is refused by ${wrapper}`,
    });
    const anyOption = Object.keys(permitted)[0];
    if (anyOption) {
      cases.push({
        wrapper,
        argv: [...base, "--", anyOption],
        expect: "refuse",
        about:
          `after --, ${anyOption} is a positional rather than an option, and ${name} takes none`,
      });
    }
  } else if (unconstrained) {
    cases.push({
      wrapper,
      argv: [...base, "--", NOT_A_SUBCOMMAND],
      expect: "permit",
      about: `${name} accepts a positional after -- under ${wrapper}`,
    });
  }

  // A bare positional, which is the same question without the `--`.
  if (mode === "none") {
    cases.push({
      wrapper,
      argv: [...base, NOT_A_SUBCOMMAND],
      expect: "refuse",
      about: `${name} takes no positional under ${wrapper}`,
    });
  } else if (unconstrained) {
    cases.push({
      wrapper,
      argv: [...base, NOT_A_SUBCOMMAND],
      expect: "permit",
      about: `${name} accepts a positional under ${wrapper}`,
    });
  }

  if (
    mode === "any" && rule.maxPositionals !== undefined &&
    !rule.positionalPattern
  ) {
    cases.push({
      wrapper,
      argv: [
        ...base,
        ...Array(rule.maxPositionals + 1).fill(NOT_A_SUBCOMMAND),
      ],
      expect: "refuse",
      about:
        `${name} caps positionals at ${rule.maxPositionals}, so one more is refused`,
    });
  }

  if (
    mode === "any" && rule.positionalPattern &&
    !matchesAnchored(rule.positionalPattern, NONMATCHING)
  ) {
    cases.push({
      wrapper,
      argv: [...base, NONMATCHING],
      expect: "refuse",
      about: `${name} constrains its positionals and this one does not match`,
    });
  }

  const shortFlags = Object.entries(permitted)
    .filter(([n, s]) => s.arity === 0 && /^-[a-zA-Z0-9]$/.test(n))
    .map(([n]) => n);

  for (const [option, spec] of Object.entries(rule.options)) {
    // An attached value is a separate code path from a separated one, and the
    // table cannot say whether they agree.
    if (spec.arity === 1 && !spec.valuePattern) {
      cases.push({
        wrapper,
        argv: [...base, `${option}=value`],
        expect: "permit",
        about: `${option}=value is the attached spelling of a permitted option`,
      });
    }
    if (spec.arity === 1 && spec.valuePattern) {
      // The gap the old matrix left open: a constrained option was never
      // exercised at all. A value that cannot match makes the refusal mean
      // the pattern, and nothing else.
      if (!matchesAnchored(spec.valuePattern, NONMATCHING)) {
        cases.push({
          wrapper,
          argv: [...base, option, NONMATCHING],
          expect: "refuse",
          about: `${option} constrains its value and this one does not match`,
        });
        cases.push({
          wrapper,
          argv: [...base, `${option}=${NONMATCHING}`],
          expect: "refuse",
          about: `${option}= is checked against the same pattern as ${option} `,
        });
      }
    }
    if (spec.arity === 1 && !spec.allowOptionLikeValue) {
      cases.push({
        wrapper,
        argv: [...base, option, "--not-a-value"],
        expect: "refuse",
        about:
          `${option} takes a value, and an option-shaped one is refused rather than guessed`,
      });
    }
    // Attaching a value to a flag is a long-option convention and only a long
    // one. `--flag=false` is how a cobra boolean is negated; `-z=false` is not
    // the short spelling of that, it is the cluster z,=,f,a,l,s,e — which is
    // why the parser refuses it, and why generating it as a permit here was
    // wrong. Real tools read it the same way.
    if (spec.arity === 0 && option.startsWith("--")) {
      cases.push({
        wrapper,
        argv: [...base, `${option}=false`],
        expect: "permit",
        about: `${option}=false is how a boolean flag is negated`,
      });
      cases.push({
        wrapper,
        argv: [...base, `${option}=${NONMATCHING}`],
        expect: "refuse",
        about: `${option} takes no value, so an attached one is refused`,
      });
    }
    if (spec.arity === 0 && !option.startsWith("--") && !permitted["-="]) {
      cases.push({
        wrapper,
        argv: [...base, `${option}=false`],
        expect: "refuse",
        about:
          `${option} is a short flag, so =false is a cluster containing "-=" rather than a negation`,
      });
    }
  }

  // A short cluster is resolved one character at a time, and the whole reason
  // to test it is that a lazier reading — treat `-ab` as an unknown option, or
  // as `-a` and stop — is a bypass in one direction or noise in the other.
  if (shortFlags.length >= 2) {
    cases.push({
      wrapper,
      argv: [...base, `-${shortFlags[0][1]}${shortFlags[1][1]}`],
      expect: "permit",
      about: `${shortFlags[0]} and ${shortFlags[1]} bundle into one cluster`,
    });
  }
  if (shortFlags.length >= 1) {
    const taken = new Set(Object.keys(permitted));
    const spare = "abcdefghijklmnopqrstuvwxyz".split("").find((c) =>
      !taken.has(`-${c}`)
    );
    if (spare) {
      cases.push({
        wrapper,
        argv: [...base, `-${shortFlags[0][1]}${spare}`],
        expect: "refuse",
        about:
          `a cluster is refused when any character in it is not permitted (-${spare})`,
      });
    }
  }

  return cases;
}

export interface CaseResult extends Case {
  got: "permit" | "refuse";
  ok: boolean;
  detail: string;
}

/** Run the matrix in process, against the policies the wrappers were built from. */
export function runCases(review: Review, cases: readonly Case[]): CaseResult[] {
  const policies = new Map<string, Policy>();
  for (const spec of review.wrappers) {
    const policy = toPolicy(review, spec);
    policies.set(policy.name, policy);
  }

  return cases.map((c) => {
    const policy = policies.get(c.wrapper);
    if (!policy) {
      return {
        ...c,
        got: "refuse",
        ok: false,
        detail: `no policy for ${c.wrapper}`,
      };
    }
    const verdict = validate(policy, c.argv);
    const got = verdict.ok ? "permit" as const : "refuse" as const;
    return {
      ...c,
      got,
      ok: got === c.expect,
      detail: verdict.ok ? "" : verdict.reason,
    };
  });
}

// ---------------------------------------------------------------------------
// The spawned sample
// ---------------------------------------------------------------------------

/** Ask a wrapper on disk for its verdict. Never execs the wrapped tool. */
export async function spawnCheck(
  wrapperPath: string,
  argv: readonly string[],
  timeoutMs: number,
): Promise<{ got: "permit" | "refuse"; output: string }> {
  const child = new Deno.Command(wrapperPath, {
    args: [...argv],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { FKA_CHECK: "1" },
  }).spawn();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, timeoutMs);

  try {
    const { code, stdout, stderr } = await child.output();
    const dec = new TextDecoder();
    const output = (dec.decode(stdout) + dec.decode(stderr)).trim();
    if (timedOut) {
      throw new Error(`wrapper did not answer within ${timeoutMs}ms`);
    }
    // Exit 0 is a permit and 1 is a refusal; anything else means the script did
    // not get as far as a verdict, and a broken wrapper is not a passing one.
    if (code !== 0 && code !== 1) {
      throw new Error(`wrapper exited ${code}: ${output || "(no output)"}`);
    }
    return { got: code === 0 ? "permit" : "refuse", output };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick the cases worth paying a process for.
 *
 * Refusals first and one case per wrapper guaranteed, because the questions
 * this sample answers — does the script run, did the policy survive being
 * written out — are answered per wrapper, not per case.
 */
export function sampleCases(
  cases: readonly CaseResult[],
  perWrapper: number,
): CaseResult[] {
  const byWrapper = new Map<string, CaseResult[]>();
  for (const c of cases) {
    const list = byWrapper.get(c.wrapper);
    if (list) list.push(c);
    else byWrapper.set(c.wrapper, [c]);
  }

  const wanted = Math.max(1, perWrapper);
  const picked: CaseResult[] = [];
  for (const list of byWrapper.values()) {
    const refusals = list.filter((c) => c.expect === "refuse");
    const permits = list.filter((c) => c.expect === "permit");
    // Interleaved, refusal first, so a budget of one still buys the answer
    // that matters and a budget of two buys both kinds.
    const taken: CaseResult[] = [];
    for (let i = 0; taken.length < wanted; i++) {
      const refusal = refusals[i];
      const permit = permits[i];
      if (refusal === undefined && permit === undefined) break;
      if (refusal !== undefined && taken.length < wanted) taken.push(refusal);
      if (permit !== undefined && taken.length < wanted) taken.push(permit);
    }
    picked.push(...taken);
  }
  return picked;
}
