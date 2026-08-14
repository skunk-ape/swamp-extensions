// Generation drivers for tool-call mode.
//
// Two ways to reach a model, chosen by the `driver` global argument:
//
//   claude-code  spawn `claude -p`, prompt on stdin. Uses the local Claude Code
//                credential, so a subscription token from `claude setup-token`
//                works and no key is stored in a vault.
//   api          the Anthropic SDK, authenticated by an API key or an OAuth
//                bearer token from a vault.
//
// Referee mode uses neither — there the driving agent does the writing and this
// file is never reached.

import Anthropic from "npm:@anthropic-ai/sdk@0.117.1";

export type Driver = "claude-code" | "api";

export interface GenerateOptions {
  driver: Driver;
  model: string;
  /** Path or command name for the Claude Code binary. */
  claudePath: string;
  /** Hard ceiling for a single generation. */
  wallTimeoutMs: number;
  /** API key (x-api-key) — api driver only. */
  apiKey: string;
  /** OAuth bearer token — api driver only, takes precedence over apiKey. */
  authToken: string;
  system: string;
  prompt: string;
  signal: AbortSignal;
}

/**
 * Spawn `claude -p` with the prompt on stdin.
 *
 * The prompt goes on stdin rather than argv so a large draft cannot hit the
 * ~1MB argv ceiling, and so the model is guaranteed to have seen the bytes —
 * pointing it at a file path instead would delegate that to a tool call the
 * model can skip or truncate.
 */
async function viaClaudeCode(o: GenerateOptions): Promise<string> {
  const command = new Deno.Command(o.claudePath, {
    args: ["-p", "--model", o.model, "--system-prompt", o.system],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });

  let child: Deno.ChildProcess;
  try {
    child = command.spawn();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not run "${o.claudePath}": ${reason}. Install Claude Code, or set ` +
        `claudePath, or switch driver to "api".`,
    );
  }

  const kill = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited — nothing to signal.
    }
  };
  const timer = setTimeout(kill, o.wallTimeoutMs);
  o.signal.addEventListener("abort", kill, { once: true });

  try {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(o.prompt));
    await writer.close();

    const { code, stdout, stderr } = await child.output();
    const out = new TextDecoder().decode(stdout).trim();
    const err = new TextDecoder().decode(stderr).trim();

    if (o.signal.aborted) throw new Error("Generation cancelled.");
    if (code !== 0) {
      throw new Error(
        `claude exited ${code}${err ? `: ${err}` : ""}. ` +
          `A timeout at ${o.wallTimeoutMs}ms also surfaces this way.`,
      );
    }
    return out;
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", kill);
  }
}

/** Call the Messages API directly. */
async function viaApi(o: GenerateOptions): Promise<string> {
  if (o.authToken === "" && o.apiKey === "") {
    throw new Error(
      'driver "api" needs apiKey or authToken — set one to a vault expression, ' +
        'or switch driver to "claude-code".',
    );
  }
  // authToken sends `Authorization: Bearer`; apiKey sends `x-api-key`.
  const client = o.authToken !== ""
    ? new Anthropic({ authToken: o.authToken })
    : new Anthropic({ apiKey: o.apiKey });

  const message = await client.messages.create({
    model: o.model,
    max_tokens: 16000,
    system: o.system,
    messages: [{ role: "user", content: o.prompt }],
  }, { signal: o.signal, timeout: o.wallTimeoutMs });

  if (message.stop_reason === "refusal") throw new Error("The model refused the rewrite.");

  return message.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** Generate a rewrite through the configured driver. */
export async function generate(o: GenerateOptions): Promise<string> {
  const text = o.driver === "claude-code" ? await viaClaudeCode(o) : await viaApi(o);
  if (text === "") throw new Error(`Driver "${o.driver}" returned no text.`);
  return text;
}
