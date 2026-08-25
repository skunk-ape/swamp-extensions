// deno-lint-ignore no-explicit-any
declare const Deno: any;

/**
 * The dynamic-linker family of environment variables: `LD_*` and `DYLD_*`.
 *
 * These preload libraries and redirect loader search paths — the injection
 * surface fka's scrubbing exists for — and Deno refuses to spawn any process
 * that would inherit them under a scoped `--allow-run`. A caller's shell
 * routinely has them, so any spawn under a scoped grant crashes on them
 * unless they are removed first. The prefix rule matches exactly what Deno
 * itself refuses, verified against the runtime the wrappers execute under.
 */
export const LINKER_ENV = /^(?:LD|DYLD)_/;

/**
 * Delete the dynamic-linker family from this process's environment, and
 * return the function that restores exactly what was there.
 *
 * Deno decides what a child inherits at the moment of the spawn call, so the
 * strip only needs to outlive that call — wrap the spawn, restore right
 * after, and the host process is left exactly as found. That matters here
 * because the host is swamp's process, not ours.
 *
 * Deno merges any explicit spawn `env` over the inherited environment, so
 * there is no per-spawn way to exclude a variable; the deletion has to
 * happen in-process.
 */
export function stripLinkerEnv(): () => void {
  const saved: Record<string, string> = {};
  const current = Object.entries(Deno.env.toObject()) as [string, string][];
  for (const [name, value] of current) {
    if (LINKER_ENV.test(name)) {
      saved[name] = value;
      try {
        Deno.env.delete(name);
      } catch {
        // Not granted, so it was never readable by the child either.
      }
    }
  }
  return () => {
    for (const [name, value] of Object.entries(saved) as [string, string][]) {
      try {
        Deno.env.set(name, value);
      } catch {
        // Not granted; nothing to restore.
      }
    }
  };
}

/** Closure form: run `fn` with the family stripped, restoring afterwards. */
export async function withoutLinkerEnv<T>(fn: () => Promise<T>): Promise<T> {
  const restore = stripLinkerEnv();
  try {
    return await fn();
  } finally {
    restore();
  }
}
