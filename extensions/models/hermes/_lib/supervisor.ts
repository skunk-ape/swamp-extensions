// What a bot's services are loaded into, as an interface.
//
// Two implementations: launchd on macOS, systemd --user on Linux. The methods
// in hermes.ts talk to this and never to either one directly, which is what
// made the Linux port a new file rather than a fork of every method.
//
// The interface is shaped by what the methods actually do, not by what the two
// init systems can do — they can do a great deal more, and none of it is
// needed here. `install` stages a unit and loads it, `uninstall` unloads and
// removes it, `status` asks what state it is in, `restart` kicks it. That is
// the whole surface.
//
// One deliberate asymmetry, called out because it looks like an oversight:
// ServiceState uses launchd's vocabulary ("running", "waiting", "exited") on
// both platforms. The systemd backend translates into it. That is backwards
// from the usual instinct — normalize onto the newer thing — but writeStatus()
// in hermes.ts, the @skunk-ape/hermes/fleet report, and the committed data from
// every audit run so far all read those words. Changing the vocabulary would
// change the meaning of stored data and make old fleet reports lie, to buy
// nothing.

import type { RunResult } from "./proc.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

export type Platform = "darwin" | "linux";

/** What a supervisor can tell us about one service. */
export type ServiceState = {
  label: string;
  loaded: boolean;
  /** launchd's word for it — "running", "waiting", "exited" — on BOTH
   * platforms. See the note at the top of this file. */
  state: string | null;
  pid: number | null;
  lastExitStatus: number | null;
};

/**
 * A problem that must be fixed before a bot can be installed.
 *
 * `blocking` is the whole point of the type. A preflight that returns advice
 * gets read once and ignored; these are conditions under which the deployment
 * would come up looking healthy and enforcing nothing, which is the failure
 * mode this repository is most careful about.
 */
export type Problem = { blocking: boolean; detail: string };

export interface Supervisor {
  readonly platform: Platform;

  /** Where installed unit files live, e.g. ~/Library/LaunchAgents. */
  unitDir(home: string): string;

  /** The installed filename for a label, e.g. `sh.alpha.gateway.plist`. */
  unitFile(label: string): string;

  /** Where the COMMITTED unit for a label lives, relative to the repo root. */
  committedUnit(label: string): string;

  /** What state this service is in right now. */
  state(label: string, signal?: AbortSignal): Promise<ServiceState>;

  /** Load a staged unit. Idempotent: an already-loaded service is replaced. */
  load(
    unitPath: string,
    label: string,
    signal?: AbortSignal,
  ): Promise<RunResult>;

  /** Unload a service. A service that was not loaded is not an error. */
  unload(label: string, signal?: AbortSignal): Promise<void>;

  /** Restart a loaded service in place. */
  kick(label: string, signal?: AbortSignal): Promise<RunResult>;

  /** ESTABLISHED socket count on a loopback port. */
  established(port: number, signal?: AbortSignal): Promise<number>;

  /** Host conditions that would make a deployment lie about itself. */
  preflight(signal?: AbortSignal): Promise<Problem[]>;
}

/** This host's platform.
 *
 * Note that the RENDERER does not consult this: render writes both a plist and
 * a systemd unit for every bot, always, so `render --input check=true` is a
 * drift detector on either machine. Only the methods that touch a running
 * system — install, uninstall, status, restart — care where they are.
 */
export function detectPlatform(): Platform {
  const os = Deno.build.os;
  if (os === "darwin" || os === "linux") return os;
  throw new Error(
    `unsupported platform '${os}'. This model type supervises bots with launchd (macOS) or systemd --user (Linux).`,
  );
}
