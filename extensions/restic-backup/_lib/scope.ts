// Retention scope on a repository several machines share.
//
// An unscoped `restic forget` selects every machine's snapshots, so `forget`
// needs both a host and a tag and fails rather than defaulting open.

import type { Snapshot } from "./restic.ts";

export function systemHostname(): string {
  // Deno.hostname() needs --allow-sys; fall back to the environment so a
  // restricted sandbox degrades to the clear error in resolveScope.
  try {
    return Deno.hostname();
  } catch {
    return Deno.env.get("HOST") ?? Deno.env.get("HOSTNAME") ?? "";
  }
}

export function resolveScope(
  g: { hostname: string; machineTag: string },
  overrides: { host?: string; tag?: string },
  fallbackHost: () => string = systemHostname,
): { host: string; tag: string } {
  const host = overrides.host || g.hostname || fallbackHost();
  const tag = overrides.tag || g.machineTag;
  if (!host) {
    throw new Error(
      "Cannot resolve hostname for retention scope. Set globalArguments.hostname, " +
        "or pass --input host=<host>.",
    );
  }
  if (!tag) {
    throw new Error(
      "Cannot resolve machineTag for retention scope. Set globalArguments.machineTag. " +
        "Refusing to run forget unscoped: on a shared repository an unscoped forget " +
        "can delete another machine's snapshots.",
    );
  }
  return { host, tag };
}

/** Snapshots a host+tag selector matched that do not carry both. */
export function foreignSnapshots(
  selected: Snapshot[],
  scope: { host: string; tag: string },
): Snapshot[] {
  return selected.filter((s) =>
    s.hostname !== scope.host || !(s.tags ?? []).includes(scope.tag)
  );
}
