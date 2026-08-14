// Generation for tool-call mode: spawn `claude -p`.
//
// Using the local Claude Code binary means the rewrite runs on whatever
// credential Claude Code already holds — including a subscription token from
// `claude setup-token` — so nothing is stored in a vault and no API key exists
// to leak. Referee mode never reaches this file; there the driving agent writes.

export interface GenerateOptions {
  /** Path or command name for the Claude Code binary. */
  claudePath: string;
  model: string;
  /** Hard ceiling for a single generation. */
  wallTimeoutMs: number;
  system: string;
  prompt: string;
  signal: AbortSignal;
}

/**
 * Run `claude -p` with the prompt on stdin and return its text.
 *
 * The prompt goes on stdin rather than argv so a large draft cannot hit the
 * ~1MB argv ceiling, and so the model is guaranteed to have seen the bytes —
 * pointing it at a file path instead would delegate that to a tool call the
 * model can skip or truncate.
 */
export async function generate(o: GenerateOptions): Promise<string> {
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
        `the claudePath global argument to its full path.`,
    );
  }

  let timedOut = false;
  const kill = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited — nothing to signal.
    }
  };
  const onTimeout = () => {
    timedOut = true;
    kill();
  };
  const timer = setTimeout(onTimeout, o.wallTimeoutMs);
  o.signal.addEventListener("abort", kill, { once: true });

  try {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(o.prompt));
    await writer.close();

    const { code, stdout, stderr } = await child.output();
    const out = new TextDecoder().decode(stdout).trim();
    const err = new TextDecoder().decode(stderr).trim();

    if (timedOut) {
      throw new Error(`claude exceeded the ${o.wallTimeoutMs}ms wall timeout.`);
    }
    if (o.signal.aborted) throw new Error("Generation cancelled.");
    if (code !== 0) {
      throw new Error(`claude exited ${code}${err ? `: ${err}` : ""}`);
    }
    if (out === "") throw new Error("claude returned no text.");

    return out;
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", kill);
  }
}
