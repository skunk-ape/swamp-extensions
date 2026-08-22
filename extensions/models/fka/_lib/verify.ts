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

import type { Review, Tier } from "./review.ts";
import { tierRank, TIERS, toPolicy, wrapperName } from "./review.ts";
import type { Policy } from "./validate.ts";
import { validate } from "./validate.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

export interface Case {
  tier: Tier;
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

  for (const tier of TIERS) {
    if (!review.emit.includes(tier)) continue;
    const wrapper = wrapperName(review.cli, tier);
    const ceiling = tierRank(tier);

    for (const cmd of review.commands) {
      const name = [review.cli, ...cmd.path].join(" ");
      const within = tierRank(cmd.tier) <= ceiling;

      cases.push({
        tier,
        wrapper,
        argv: [...cmd.path],
        expect: within ? "permit" : "refuse",
        about: within
          ? `${name} is ${cmd.tier} and ${wrapper} covers that tier`
          : `${name} is ${cmd.tier}, which is above ${tier}`,
      });

      if (!within) continue;

      for (const [option, spec] of Object.entries(cmd.options)) {
        const optionTier = spec.tier ?? cmd.tier;
        const argv = [...cmd.path, option];
        if (spec.arity === 1) argv.push("value");

        if (tierRank(optionTier) > ceiling) {
          cases.push({
            tier,
            wrapper,
            argv,
            expect: "refuse",
            about:
              `${option} on ${name} is ${optionTier}, which is above ${tier}`,
          });
          continue;
        }
        // A constrained value cannot be exercised with a made-up token: the
        // refusal would be the pattern doing its job, indistinguishable here
        // from the option being missing. Those are left to the reviewer.
        if (spec.valuePattern) continue;
        cases.push({
          tier,
          wrapper,
          argv,
          expect: "permit",
          about: `${option} is permitted on ${name} at ${tier}`,
        });
      }
    }

    // An escape command must not be reachable from a wrapper that is not the
    // escape wrapper, and the bare tool name must not be a command by accident.
    if (!review.commands.some((c) => c.path.length === 0)) {
      cases.push({
        tier,
        wrapper,
        argv: [],
        expect: "refuse",
        about: `${review.cli} on its own is not a permitted command`,
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
  const policies = new Map<Tier, Policy>();
  for (const tier of review.emit) policies.set(tier, toPolicy(review, tier));

  return cases.map((c) => {
    const policy = policies.get(c.tier);
    if (!policy) {
      return {
        ...c,
        got: "refuse",
        ok: false,
        detail: `no policy for tier ${c.tier}`,
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
