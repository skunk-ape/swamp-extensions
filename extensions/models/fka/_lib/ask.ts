/**
 * Talking to a model session, and counting what it cost.
 *
 * This lives apart from any one caller because more than one stage needs it.
 * `classify` asks a model to tier commands; `discover` is expected to ask one
 * to read a help page, since help text is unstructured prose with no standard
 * to parse against. Neither should have to import the other to spawn a
 * session, so the seam, the argv, the envelope parser, and the usage tally sit
 * here and know nothing about tiers or command trees.
 *
 * Two properties are deliberate.
 *
 * `Ask` is an injectable function type, so every caller can be tested without
 * spawning anything, and the tests that matter never depend on a model being
 * available or on what it happens to say.
 *
 * The envelope is parsed strictly. A reply that is not a well-formed success
 * envelope throws rather than falling back to treating raw stdout as the
 * answer, because a silent fallback would let a changed CLI output format
 * become confident nonsense in a table that decides what an agent may run.
 *
 * @module
 */

import { stripLinkerEnv } from "./env.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

/** One question to the model. Injectable so tests never spawn anything. */
export type Ask = (system: string, prompt: string) => Promise<string>;

export interface AskOptions {
  claudePath: string;
  /**
   * Model to pin for the spawned session. Empty inherits the caller's Claude
   * Code default: the child gets the caller's environment and `claude -p`
   * resolves its model from it, so no `--model` flag is passed.
   */
  model: string;
  wallTimeoutMs: number;
  /** Whether the classifier may read documentation off the network. */
  docsMode: "none" | "web";
  signal: AbortSignal;
  /**
   * Called once per successful ask with what that call cost.
   *
   * A callback rather than a return value because `Ask` stays
   * `(system, prompt) => Promise<string>`: the batching loop and the JSON
   * parser have no business knowing about tokens, and threading a second
   * return value through them would put cost accounting in the path that
   * decides what a command is allowed to do.
   */
  onUsage?: (usage: AskUsage) => void;
  /**
   * Variables set for the spawned child only.
   *
   * Deno merges these over what the child would inherit, so this adds and
   * overrides without touching the host process. That distinction is the whole
   * point: pointing `ANTHROPIC_BASE_URL` at a proxy for one classify run must
   * not move the caller's own Claude Code session onto it.
   *
   * Empty by default. Using it to reach a proxy means supplying that proxy's
   * token, which is a stored credential by another name — see the README on
   * what that changes about the posture.
   */
  env?: Record<string, string>;
  /**
   * Working directory for the child.
   *
   * Worth setting because Claude Code reads a CLAUDE.md from its working
   * directory upwards, and a repository's instructions are dead weight in a
   * session whose entire job is to read one help page. Every batch pays for
   * them again.
   */
  cwd?: string;
}

/**
 * What one ask cost.
 *
 * Recorded per call and summed across a run, because the whole reason to pin a
 * model or reach for the cache is that classify is expensive, and an argument
 * about cost that nobody measured is an argument about nothing.
 */
export interface AskUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /**
   * List price for the call, as the CLI reports it. On a subscription this is
   * not what the run is billed — there is no per-call billing — so treat it as
   * a comparable number between runs rather than money owed.
   */
  costUsd: number;
  /** Model ids the CLI says served the call. Usually one. */
  models: string[];
}

/** An empty tally, so summing has an identity. */
export function zeroUsage(): AskUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    costUsd: 0,
    models: [],
  };
}

/** Add one call's usage into a running total, keeping the model set unique. */
export function addUsage(total: AskUsage, one: AskUsage): AskUsage {
  return {
    input: total.input + one.input,
    output: total.output + one.output,
    cacheRead: total.cacheRead + one.cacheRead,
    cacheCreation: total.cacheCreation + one.cacheCreation,
    costUsd: total.costUsd + one.costUsd,
    models: [...new Set([...total.models, ...one.models])].sort(),
  };
}

/**
 * Read the reply text and the usage out of `claude --output-format json`.
 *
 * Pure, because this is the one place that interprets what the model session
 * returned, and a parser that can only be exercised by spawning a real session
 * is a parser nobody exercises.
 *
 * An unrecognised envelope throws rather than falling back to treating the raw
 * stdout as the answer. A silent fallback here would turn a changed CLI output
 * format into a classifier that confidently tiers commands from a fragment of
 * JSON, which is exactly the failure this extension must not have.
 */
export function parseAskEnvelope(
  stdout: string,
): { text: string; usage: AskUsage } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error(
      "claude did not return a JSON envelope; expected --output-format json",
    );
  }
  // Array.isArray, because an array passes `typeof x === "object"` and would
  // otherwise reach the field reads below and fail with a confusing message.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("claude returned a JSON value that is not an object");
  }
  const env = raw as Record<string, unknown>;

  if (env.is_error === true || env.subtype !== "success") {
    // Name the subtype as well as the text. A run that hit the turn limit
    // still carries a plausible-looking `result`, so reporting only the text
    // would describe a truncated answer as if it were the failure.
    const subtype = String(env.subtype ?? "unknown");
    const detail = typeof env.result === "string" && env.result.trim() !== ""
      ? `: ${env.result.trim()}`
      : "";
    throw new Error(`claude reported failure (${subtype})${detail}`);
  }
  if (typeof env.result !== "string" || env.result.trim() === "") {
    throw new Error("claude returned an envelope with no result text");
  }

  const u = (typeof env.usage === "object" && env.usage !== null)
    ? env.usage as Record<string, unknown>
    : {};
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;

  // modelUsage is keyed by model id. It is the only place the reply names which
  // model actually served the call — the top-level `model` field comes back
  // null — and a proposal is worth much less to a reviewer who cannot tell
  // whether a cheap model produced it.
  const models = (typeof env.modelUsage === "object" && env.modelUsage !== null)
    ? Object.keys(env.modelUsage as Record<string, unknown>).sort()
    : [];

  return {
    text: env.result.trim(),
    usage: {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheCreation: num(u.cache_creation_input_tokens),
      costUsd: num(env.total_cost_usd),
      models,
    },
  };
}

/**
 * The argv for one ask, pure so tests can see exactly what gets spawned.
 *
 * `--model` is passed only when a model was chosen. Omitting it is the
 * inheritance path: `claude -p` then runs on whatever model the caller's
 * Claude Code is configured for, rather than on a default this file picked.
 */
export function askArgv(
  o: Pick<AskOptions, "model" | "docsMode">,
  system: string,
): string[] {
  const args = ["-p"];
  if (o.model !== "") args.push("--model", o.model);
  // The envelope carries the token counts and the list price alongside the
  // reply. Reading them is the only way this extension can say what a classify
  // run cost, so the format is not optional and parseAskEnvelope refuses
  // anything else rather than guessing.
  args.push("--output-format", "json");
  args.push("--append-system-prompt", system);
  if (o.docsMode === "web") args.push("--allowedTools", "WebFetch,WebSearch");
  else {
    args.push(
      "--disallowedTools",
      "WebFetch,WebSearch,Bash,Read,Write,Edit",
    );
  }
  return args;
}

/**
 * Everything that configures one spawn, built purely so it can be asserted.
 *
 * Separate from the spawn itself because the interesting claims — that the
 * child gets the JSON envelope, that overrides reach the child and nowhere
 * else, that the working directory moved — are claims about this object, and
 * a test that had to spawn a real session to check them would not be run.
 */
export function askCommandOptions(
  o: Pick<AskOptions, "model" | "docsMode" | "env" | "cwd">,
  system: string,
): { args: string[]; env: Record<string, string>; cwd?: string } {
  return {
    args: askArgv(o, system),
    // A fresh object, never a reference to the caller's, and never the host
    // environment: Deno merges this over what the child inherits, so what is
    // absent here is left exactly as the host had it.
    env: { ...(o.env ?? {}) },
    ...(o.cwd !== undefined && o.cwd !== "" ? { cwd: o.cwd } : {}),
  };
}

/**
 * Ask by spawning `claude -p`.
 *
 * The local Claude Code binary means this runs on whatever credential Claude
 * Code already holds, so no API key is stored in a vault and none exists to
 * leak. Tools are named explicitly in both directions: with docs off, the
 * session gets nothing, which is the posture for an operator who would rather
 * classify blind than let a fetched page near the classifier.
 */
export function spawnAsk(o: AskOptions): Ask {
  return async (system: string, prompt: string): Promise<string> => {
    const { args, env, cwd } = askCommandOptions(o, system);

    let child: Deno.ChildProcess;
    // The session inherits the caller's credentials and model default, which
    // is the point, but nothing that could preload a library into it. Strip
    // the loader family around the spawn for the same reason the wrappers do.
    const restore = stripLinkerEnv();
    try {
      child = new Deno.Command(o.claudePath, {
        args,
        env,
        ...(cwd !== undefined ? { cwd } : {}),
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not run "${o.claudePath}": ${reason}. Install Claude Code, or set ` +
          `the claudePath global argument to its full path.`,
      );
    } finally {
      restore();
    }

    let timedOut = false;
    const kill = () => {
      try {
        child.kill("SIGTERM");
      } catch { /* already exited */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.wallTimeoutMs);
    o.signal.addEventListener("abort", kill, { once: true });

    let reaped = false;
    try {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(prompt));
      await writer.close();

      const { code, stdout, stderr } = await child.output();
      reaped = true;
      const out = new TextDecoder().decode(stdout).trim();
      const err = new TextDecoder().decode(stderr).trim();

      if (timedOut) {
        throw new Error(
          `claude exceeded the ${o.wallTimeoutMs}ms wall timeout.`,
        );
      }
      if (o.signal.aborted) throw new Error("Classification cancelled.");
      if (code !== 0) {
        throw new Error(`claude exited ${code}${err ? `: ${err}` : ""}`);
      }
      if (out === "") throw new Error("claude returned no text.");
      const { text, usage } = parseAskEnvelope(out);
      o.onUsage?.(usage);
      return text;
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener("abort", kill);
      // A throw before output() resolves leaves the child running with nobody
      // waiting on it. Signal and drain so it is reaped rather than orphaned.
      if (!reaped) {
        kill();
        await child.output().catch(() => {});
      }
    }
  };
}
