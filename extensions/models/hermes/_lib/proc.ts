// Process and socket primitives, with no opinion about the init system.
//
// This is the half of the old launchd.ts that was never about launchd: running
// a command, waiting for a port, substituting placeholders into a committed
// unit file. It was split out when the fleet moved to Linux, because a file
// named launchd.ts holding the only TCP probe in the codebase is a file nobody
// thinks to look in.
//
// What lives here is everything a supervisor backend needs and none of what
// makes one backend different from another. The backends are in launchd.ts and
// systemd.ts; the interface they satisfy is in supervisor.ts.

// deno-lint-ignore no-explicit-any
declare const Deno: any;

export type RunResult = { stdout: string; stderr: string; code: number };

/** Run a command, capturing both streams. Never through a shell: an argument
 * vector cannot be re-parsed by something that thinks it sees a metacharacter. */
export async function run(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  // swamp-quality-ignore deno-command
  const cmd = new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
    signal,
    cwd: opts.cwd,
    env: opts.env,
    // Nothing here is interactive, and several of the things provisioning
    // drives will happily block on a prompt if given a terminal to ask on.
    stdin: "null",
  });
  const out = await cmd.output();
  const dec = new TextDecoder();
  return {
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
    code: out.code,
  };
}

/** Absolute path of a binary on PATH, or null.
 *
 * `which` rather than a PATH walk because the answer has to match what the
 * shell in an entrypoint would resolve, and because the one caller that needs
 * it — the verify probe's interpreter — must fail loudly rather than guess.
 * /usr/bin/python3 is a safe assumption on macOS and a wrong one on NixOS.
 */
export async function which(
  bin: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const r = await run("/usr/bin/env", ["which", bin], signal);
  if (r.code !== 0) return null;
  const path = r.stdout.trim().split("\n")[0]?.trim();
  return path ? path : null;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** The service label for a bot's gateway.
 *
 * One label per service across both platforms: `sh.alpha.gateway` names a
 * launchd job and, with `.service` appended, a systemd unit. Dots are legal in
 * unit names, so keeping the label identical means the status schema, the fleet
 * report and every doc reference survive the port unchanged. */
export function gatewayLabelFor(slug: string): string {
  return `sh.${slug}.gateway`;
}

/** The service label for one of a bot's host-side MCPs.
 *
 * MCP unit files are hand-written — an MCP is a host service with its own
 * credential, not a sandboxed bot — but their labels follow the bot, so the
 * declaration is still enough to find them. */
export function mcpLabelFor(slug: string, mcpName: string): string {
  return `sh.${slug}.${mcpName}`;
}

// ---------------------------------------------------------------------------
// Unit files
// ---------------------------------------------------------------------------

/** Committed unit files carry placeholders so no machine-specific absolute path
 * is ever checked in. This is the substitution `install` performs on the way to
 * the platform's unit directory, and it is the same for a plist and a systemd
 * unit — which is the point of doing it textually rather than per format. */
export function substitutePlaceholders(
  content: string,
  vars: { repo: string; home: string; user: string },
): string {
  return content
    .replaceAll("__REPO__", vars.repo)
    .replaceAll("__HOME__", vars.home)
    .replaceAll("__USER__", vars.user);
}

/** True when a rendered unit still has a placeholder in it. Installing one of
 * these produces a job that fails at exec with a path that does not exist. */
export function unresolvedPlaceholders(content: string): string[] {
  return [...new Set(content.match(/__[A-Z]+__/g) ?? [])];
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Can something be reached on this loopback port right now? */
export async function portOpen(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

export async function waitPort(
  port: number,
  attempts = 40,
  delayMs = 2000,
  signal?: AbortSignal,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await portOpen(port)) return true;
    await sleep(delayMs, signal);
  }
  return await portOpen(port);
}

/**
 * How many ESTABLISHED sockets exist on a loopback port, per `lsof`.
 *
 * This is the check that distinguishes "the MCP is listening" from "the gateway
 * is actually talking to it", and the difference matters because Hermes *parks*
 * an MCP whose connection drops and does not retry until a reconnect is
 * requested. A parked MCP leaves a server that is plainly running and answering
 * on its port, and an agent reporting that it cannot reach it.
 *
 * lsof is the macOS answer and the Linux fallback. `ss` is the Linux answer and
 * lives in systemd.ts, because on a desktop distro iproute2 is always there and
 * lsof frequently is not.
 */
export async function establishedViaLsof(
  port: number,
  signal?: AbortSignal,
): Promise<number> {
  const r = await run("lsof", ["-nP", `-iTCP:${port}`], signal);
  if (r.code !== 0) return 0;
  return r.stdout.split("\n").filter((l) => l.includes("ESTABLISHED")).length;
}

/** One live session, seen from both ends. */
export function hasLiveSession(established: number): boolean {
  return established >= 2;
}

// ---------------------------------------------------------------------------

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
