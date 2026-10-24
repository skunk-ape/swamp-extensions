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
 * Arguments for a rewrite session that can only write text.
 *
 * The draft is untrusted input: a document under review can carry injected
 * instructions, so the session it reaches must hold nothing to act with.
 * `--tools ""` removes the built-in tools, but not MCP servers or claude.ai
 * connectors — `--strict-mcp-config` with no `--mcp-config` drops those.
 * `--setting-sources ""` skips settings files and the hooks they declare,
 * `--safe-mode` skips CLAUDE.md, skills, plugins and memory, and the rest keep
 * slash commands and session files out. `--bare` would also do most of this,
 * but it refuses the OAuth login this file exists to reuse.
 */
export function claudeArgs(model: string, system: string): string[] {
  return [
    "-p",
    "--model",
    model,
    "--system-prompt",
    system,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
}

/**
 * Run `claude -p` with the prompt on stdin and return its text.
 *
 * The prompt goes on stdin rather than argv so a large draft cannot hit the
 * ~1MB argv ceiling, and so the model is guaranteed to have seen the bytes —
 * pointing it at a file path instead would delegate that to a tool call the
 * model can skip or truncate.
 *
 * The session runs in an empty temp directory, so a CLAUDE.md in the caller's
 * repository is never discovered.
 */
export async function generate(o: GenerateOptions): Promise<string> {
  const cwd = await Deno.makeTempDir({ prefix: "stef-rewrite-" });
  try {
    return await generateIn(cwd, o);
  } finally {
    await Deno.remove(cwd, { recursive: true }).catch(() => {});
  }
}

async function generateIn(cwd: string, o: GenerateOptions): Promise<string> {
  // swamp-quality-ignore deno-command
  const command = new Deno.Command(o.claudePath, {
    args: claudeArgs(o.model, o.system),
    cwd,
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

  let reaped = false;
  try {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(o.prompt));
    await writer.close();

    const { code, stdout, stderr } = await child.output();
    reaped = true;
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
    // A throw before `output()` resolves — a broken stdin pipe, most likely —
    // leaves the child running with nobody waiting on it. Signal it and drain
    // the pipes so the process is reaped rather than orphaned.
    if (!reaped) {
      kill();
      await child.output().catch(() => {});
    }
  }
}
