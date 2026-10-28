// Which machine this is, and what supervises services on it.
//
// The factory lives here rather than in supervisor.ts so that the two backends
// can import the interface without the interface importing them back. It is
// also the one place that reads the environment, which keeps every method in
// hermes.ts testable against a fabricated host.

import { LaunchdSupervisor } from "./launchd.ts";
import { SystemdSupervisor } from "./systemd.ts";
import { detectPlatform } from "./supervisor.ts";
import type { Platform, Supervisor } from "./supervisor.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

export type HostFacts = {
  platform: Platform;
  uid: number;
  home: string;
  user: string;
  supervisor: Supervisor;
  /** Where installed unit files go on this host. */
  unitDir: string;
};

export function supervisorFor(
  platform: Platform,
  opts: { uid: number; user: string },
): Supervisor {
  return platform === "darwin"
    ? new LaunchdSupervisor(opts.uid)
    : new SystemdSupervisor(opts.user);
}

/** This host, as the methods see it. */
export function hostFacts(): HostFacts {
  const platform = detectPlatform();
  const uid = Deno.uid();
  const home = Deno.env.get("HOME") ?? "";
  // `USER` is not always exported under a service manager; the login name from
  // the OS is. Falling back matters because the Linux backend asks loginctl
  // about this name, and an empty one makes that question meaningless.
  const user = Deno.env.get("USER") ?? Deno.env.get("LOGNAME") ?? "";
  const supervisor = supervisorFor(platform, { uid, user });
  return {
    platform,
    uid,
    home,
    user,
    supervisor,
    unitDir: supervisor.unitDir(home),
  };
}
