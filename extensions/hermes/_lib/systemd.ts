// The Linux backend: systemd user units, via `systemctl --user`.
//
// Unit files live in ~/.config/systemd/user and are named for the same labels
// launchd uses — `sh.alpha.gateway.service`. Dots are legal in unit names, so
// the label survives the port and with it the status schema, the fleet report
// and every doc reference.
//
// Two things about this platform are genuinely nicer than launchd and one is
// genuinely worse, and all three are load-bearing:
//
//   - `systemctl show` emits flat `key=value`, not launchd's brace format. The
//     parser below is a `split("=")` rather than a set of regexes over a
//     grammar nobody documents.
//   - `disable --now` is synchronous, so there is no waitGone equivalent and no
//     "Bootstrap failed: 5" to decode.
//   - A user manager without lingering enabled stops when the user logs out,
//     taking every bot with it, and reports nothing unusual while doing it.
//     That is what preflight() exists for.

import { establishedViaLsof, run, which } from "./proc.ts";
import type { RunResult } from "./proc.ts";
import type { Problem, ServiceState, Supervisor } from "./supervisor.ts";

/**
 * The lowest kernel that can enforce a nono `network` block.
 *
 * nono's filesystem confinement is Landlock, available from 5.13. Its TCP
 * bind/connect filtering — which is what `open_port` and `allow_domain` compile
 * down to — needs Landlock ABI v4, and that shipped in 6.7.
 *
 * Below this the profile parses, the sandbox starts, the agent works, and the
 * entire network half of the boundary is inert. That is the same failure as
 * running `nono wrap` instead of `nono run`, arriving by a different road, and
 * it gets the same treatment: refuse, loudly, rather than deploy something that
 * reports healthy and enforces half of what it claims.
 */
export const MIN_KERNEL = { major: 6, minor: 7 };

/** Parse the leading `major.minor` out of a `uname -r` string.
 *
 * Release strings are a zoo — `6.8.0-45-generic`, `6.12.4-arch1-1`,
 * `5.15.0-1052-aws` — but every one of them starts with major.minor, so that is
 * all this reads. Returns null rather than guessing when it does not.
 */
export function parseKernelVersion(
  release: string,
): { major: number; minor: number } | null {
  const m = release.trim().match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** Can this kernel enforce a nono network block at all? */
export function kernelEnforcesNetwork(
  v: { major: number; minor: number } | null,
): boolean {
  if (v === null) return false;
  if (v.major !== MIN_KERNEL.major) return v.major > MIN_KERNEL.major;
  return v.minor >= MIN_KERNEL.minor;
}

/**
 * Parse `systemctl --user show`.
 *
 * Translated into launchd's vocabulary on the way out — see the note at the top
 * of supervisor.ts for why the older words won.
 *
 *   active/running          -> running
 *   activating, auto-restart-> waiting   (Restart=on-failure, coming back)
 *   inactive, failed        -> exited
 *
 * `loaded` means systemd has the unit file, which is the analogue of a launchd
 * job being bootstrapped into the domain. A unit that was never installed
 * reports LoadState=not-found, and that is the case the caller must be able to
 * tell apart from a unit that is installed and stopped.
 */
export function parseShow(label: string, stdout: string): ServiceState {
  const kv = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }

  const loadState = kv.get("LoadState") ?? "";
  const loaded = loadState === "loaded";
  if (!loaded) {
    return {
      label,
      loaded: false,
      state: null,
      pid: null,
      lastExitStatus: null,
    };
  }

  const active = kv.get("ActiveState") ?? "";
  const sub = kv.get("SubState") ?? "";
  let state: string;
  if (active === "active" && sub === "running") state = "running";
  else if (active === "activating" || sub === "auto-restart") state = "waiting";
  else state = "exited";

  const rawPid = Number(kv.get("MainPID") ?? "0");
  // systemd reports MainPID=0 for a unit with no live process; launchd reports
  // no pid field at all. Both mean the same thing and both must arrive as null.
  const pid = Number.isFinite(rawPid) && rawPid > 0 ? rawPid : null;

  // ExecMainStatus is 0 both for "exited cleanly" and "has never exited", so it
  // cannot be read alone. An empty ExecMainExitTimestamp is systemd's way of
  // saying the main process has not exited yet — launchd's "(never exited)".
  const exited = (kv.get("ExecMainExitTimestamp") ?? "") !== "";
  const rawStatus = Number(kv.get("ExecMainStatus") ?? "");
  const lastExitStatus = exited && Number.isFinite(rawStatus)
    ? rawStatus
    : null;

  return { label, loaded, state, pid, lastExitStatus };
}

/** Count ESTABLISHED sockets in `ss` output.
 *
 * `-H` would drop the header, but it is not in every iproute2 old enough to
 * still be shipping, and a version check to save a filter is a poor trade. The
 * header is dropped here instead, which works on every version.
 */
export function parseSsEstablished(stdout: string): number {
  return stdout.split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .filter((l) => !/^(State|Netid|Recv-Q)\b/.test(l))
    .length;
}

export class SystemdSupervisor implements Supervisor {
  readonly platform = "linux" as const;
  private readonly user: string;

  constructor(user: string) {
    this.user = user;
  }

  unitDir(home: string): string {
    return `${home}/.config/systemd/user`;
  }

  unitFile(label: string): string {
    return `${label}.service`;
  }

  committedUnit(label: string): string {
    return `systemd/${label}.service`;
  }

  async state(label: string, signal?: AbortSignal): Promise<ServiceState> {
    const r = await run("systemctl", [
      "--user",
      "show",
      this.unitFile(label),
      "--property=LoadState",
      "--property=ActiveState",
      "--property=SubState",
      "--property=MainPID",
      "--property=ExecMainStatus",
      "--property=ExecMainExitTimestamp",
    ], signal);
    // A failed `show` is not the same as a missing unit — no user bus, for
    // instance — but it is indistinguishable from here and both mean "this
    // service is not running and I cannot say more".
    if (r.code !== 0) {
      return {
        label,
        loaded: false,
        state: null,
        pid: null,
        lastExitStatus: null,
      };
    }
    return parseShow(label, r.stdout);
  }

  /** Reload the unit file from disk, then enable and start it.
   *
   * `enable` is what makes the bot come back at boot, and is the systemd half
   * of what `RunAtLoad` does in a plist. `--now` starts it in the same call. An
   * already-running unit is restarted rather than left on the old unit file,
   * which is what makes this idempotent in the way install expects.
   */
  async load(
    _unitPath: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const reload = await run("systemctl", ["--user", "daemon-reload"], signal);
    if (reload.code !== 0) return reload;
    const enable = await run("systemctl", [
      "--user",
      "enable",
      "--now",
      this.unitFile(label),
    ], signal);
    if (enable.code !== 0) return enable;
    // enable --now does not restart a unit that was already running, so it
    // would otherwise keep executing the previous unit file.
    return await run("systemctl", [
      "--user",
      "restart",
      this.unitFile(label),
    ], signal);
  }

  async unload(label: string, signal?: AbortSignal): Promise<void> {
    await run("systemctl", [
      "--user",
      "disable",
      "--now",
      this.unitFile(label),
    ], signal);
  }

  async kick(label: string, signal?: AbortSignal): Promise<RunResult> {
    return await run("systemctl", [
      "--user",
      "restart",
      this.unitFile(label),
    ], signal);
  }

  /** `ss` first, `lsof` as a fallback.
   *
   * iproute2 is on every desktop distro; lsof frequently is not installed at
   * all. The fallback exists because returning 0 here does not read as "I could
   * not tell" — it reads as "the gateway has no live session", which is the
   * exact shape of a parked MCP and would send someone debugging the wrong
   * thing.
   */
  async established(port: number, signal?: AbortSignal): Promise<number> {
    const r = await run("ss", [
      "-tn",
      "state",
      "established",
      `( sport = :${port} or dport = :${port} )`,
    ], signal);
    if (r.code === 0) return parseSsEstablished(r.stdout);
    return await establishedViaLsof(port, signal);
  }

  /**
   * The two ways this platform lies about itself.
   *
   * Both are blocking, and both produce a deployment that looks completely
   * healthy: every service active, every port answering, the agent replying on
   * Telegram. One of them is enforcing no network boundary at all; the other
   * will disappear the next time you log out.
   */
  async preflight(signal?: AbortSignal): Promise<Problem[]> {
    const problems: Problem[] = [];

    // -- the kernel ---------------------------------------------------------
    const uname = await run("uname", ["-r"], signal);
    const version = uname.code === 0 ? parseKernelVersion(uname.stdout) : null;
    if (version === null) {
      problems.push({
        blocking: true,
        detail: `could not read the kernel version (\`uname -r\` said ${
          JSON.stringify(uname.stdout.trim() || uname.stderr.trim())
        }). nono needs Landlock ABI v4 — kernel ${MIN_KERNEL.major}.${MIN_KERNEL.minor}+ — to enforce open_port and allow_domain, and an unverifiable kernel is not evidence that it can.`,
      });
    } else if (!kernelEnforcesNetwork(version)) {
      problems.push({
        blocking: true,
        detail:
          `kernel ${version.major}.${version.minor} is below ${MIN_KERNEL.major}.${MIN_KERNEL.minor}, so nono cannot enforce a network block: open_port and allow_domain would both be inert and every bot could reach every loopback service and every host. This is the \`nono wrap\` failure by another route. Upgrade the kernel, or run \`verify\` and read the FAILs before deciding to proceed anyway.`,
      });
    }

    // -- lingering ----------------------------------------------------------
    const linger = await run("loginctl", [
      "show-user",
      this.user,
      "--property=Linger",
    ], signal);
    if (linger.code !== 0) {
      problems.push({
        blocking: false,
        detail:
          `could not ask loginctl whether lingering is enabled for ${this.user}. Without it, user units stop at logout. Check with \`loginctl show-user ${this.user} --property=Linger\`.`,
      });
    } else if (!/Linger=yes/.test(linger.stdout)) {
      problems.push({
        blocking: true,
        detail:
          `lingering is not enabled for ${this.user}, so the user manager — and every bot in it — stops when you log out and does not start at boot. Fix with \`loginctl enable-linger ${this.user}\`.`,
      });
    }

    // -- a user bus at all --------------------------------------------------
    if (await which("systemctl", signal) === null) {
      problems.push({
        blocking: true,
        detail:
          "systemctl is not on PATH. This backend supervises bots with systemd user units and has nothing to fall back to.",
      });
    }

    return problems;
  }
}
