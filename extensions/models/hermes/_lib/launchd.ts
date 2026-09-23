// The macOS backend: launchd, via `launchctl`.
//
// Lifecycle deliberately does NOT go through @bixu/launchd, even though that
// extension covers load/unload/start/stop. Two reasons. Bootstrapping needs the
// `__REPO__`/`__HOME__`/`__USER__` substitution that produces the plist in
// `~/Library/LaunchAgents` in the first place, which is ours. And a bot coming
// up at login is the critical path: it should not depend on a third-party
// extension resolving from a registry. @bixu/launchd earns its place on the
// reporting side — `health`, `orphans`, `list`, `processes` — where a missing
// dependency costs a report rather than an outage.
//
// Everything here that was never about launchd — running a command, probing a
// port, substituting placeholders — moved to proc.ts when the fleet gained a
// second platform.

import {
  establishedViaLsof,
  gatewayLabelFor,
  mcpLabelFor,
  run,
  sleep,
} from "./proc.ts";
import type { RunResult } from "./proc.ts";
import type { Problem, ServiceState, Supervisor } from "./supervisor.ts";

// Re-exported so a caller that only wants a label does not have to know which
// backend is in play.
export { gatewayLabelFor, mcpLabelFor };

/**
 * Parse `launchctl print`.
 *
 * The output is a nested brace format, not JSON or anything with a parser. The
 * four facts worth having are all `key = value` lines at the top level, so this
 * reads those rather than pretending to understand the whole grammar.
 */
export function parsePrint(label: string, stdout: string): ServiceState {
  const field = (name: string): string | null => {
    const m = stdout.match(new RegExp(`^\\s*${name} = (.+)$`, "m"));
    return m ? m[1].trim() : null;
  };
  const pid = field("pid");
  const exit = field("last exit code");
  return {
    label,
    loaded: true,
    state: field("state"),
    pid: pid === null ? null : Number(pid),
    lastExitStatus: exit === null || exit === "(never exited)"
      ? null
      : Number(exit),
  };
}

/**
 * Wait for a booted-out label to actually disappear.
 *
 * `bootout` is asynchronous. Bootstrapping while launchd is still tearing the
 * old job down fails with "Bootstrap failed: 5: Input/output error", which names
 * nothing about the actual cause and sends you looking in the wrong place.
 *
 * systemd needs no equivalent, which is why the Linux backend's load() is three
 * lines shorter: `systemctl --user disable --now` does not return until the
 * unit is actually down.
 */
export async function waitGone(
  target: string,
  label: string,
  attempts = 50,
  delayMs = 200,
  signal?: AbortSignal,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const r = await run("launchctl", ["print", `${target}/${label}`], signal);
    if (r.code !== 0) return true;
    await sleep(delayMs, signal);
  }
  return false;
}

export class LaunchdSupervisor implements Supervisor {
  readonly platform = "darwin" as const;
  /** `gui/<uid>`, the domain user agents live in. */
  private readonly target: string;

  constructor(uid: number) {
    this.target = `gui/${uid}`;
  }

  unitDir(home: string): string {
    return `${home}/Library/LaunchAgents`;
  }

  unitFile(label: string): string {
    return `${label}.plist`;
  }

  committedUnit(label: string): string {
    return `launchd/${label}.plist`;
  }

  async state(label: string, signal?: AbortSignal): Promise<ServiceState> {
    const r = await run("launchctl", [
      "print",
      `${this.target}/${label}`,
    ], signal);
    if (r.code !== 0) {
      return {
        label,
        loaded: false,
        state: null,
        pid: null,
        lastExitStatus: null,
      };
    }
    return parsePrint(label, r.stdout);
  }

  async load(
    unitPath: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    await this.unload(label, signal);
    await waitGone(this.target, label, 50, 200, signal);
    return await run(
      "launchctl",
      ["bootstrap", this.target, unitPath],
      signal,
    );
  }

  async unload(label: string, signal?: AbortSignal): Promise<void> {
    await run("launchctl", ["bootout", `${this.target}/${label}`], signal);
  }

  async kick(label: string, signal?: AbortSignal): Promise<RunResult> {
    return await run(
      "launchctl",
      ["kickstart", "-k", `${this.target}/${label}`],
      signal,
    );
  }

  async established(port: number, signal?: AbortSignal): Promise<number> {
    return await establishedViaLsof(port, signal);
  }

  /**
   * Nothing to check.
   *
   * Neither Linux trap has a macOS equivalent: a user agent in `gui/<uid>` runs
   * without any per-user opt-in, and Seatbelt's network filtering is not gated
   * on an OS version this deployment could plausibly be below. The one macOS
   * way to end up with an unenforced sandbox is `nono wrap`, and that is
   * settled in the entrypoint templates rather than here.
   */
  preflight(_signal?: AbortSignal): Promise<Problem[]> {
    return Promise.resolve([]);
  }
}
