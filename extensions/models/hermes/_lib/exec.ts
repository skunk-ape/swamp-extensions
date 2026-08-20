// The one seam every method reaches the host through.
//
// Shape C runs the method on the target itself, so this is a local bash
// invocation. The SSH implementation the design record describes would swap
// only this file: the install scripts, the idempotency guards, and the
// KEY=value parsing are identical either way.
//
// Two properties matter and are the reason this exists rather than a plain
// Deno.Command per call:
//
//   - The script is fed over stdin, never as an argument. Process arguments
//     are readable by any other process, so a secret in argv is a secret
//     leaked. Everything secret-bearing goes through writeFileScript.
//   - Scripts run under `set -euo pipefail`, so a failing step in the middle
//     of a script is an error rather than a silently skipped line.

// Deno is available at runtime in the swamp model host. Declared here so the
// type checker does not need --unstable for the namespace.
// deno-lint-ignore no-explicit-any
declare const Deno: any;

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Single-quote a value for safe interpolation into a shell script. */
export function shellEsc(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a bash script on the host and capture its output.
 *
 * The script is written to the process's stdin rather than passed as an
 * argument. Does not throw on a non-zero exit — callers decide, because a
 * probe that answers "no" is not a failure.
 */
export async function runScriptRaw(script: string): Promise<RunResult> {
  const proc = new Deno.Command("bash", {
    args: ["-s"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(script));
  await writer.close();

  const result = await proc.output();
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    code: result.code,
  };
}

/**
 * Run a bash script and throw if it fails.
 *
 * Use for steps that must succeed. Use runScriptRaw for probes whose answer
 * is the exit code.
 */
export async function runScript(script: string): Promise<RunResult> {
  const prelude = "set -euo pipefail\n";
  const result = await runScriptRaw(prelude + script);
  if (result.code !== 0) {
    throw new Error(
      `script failed (exit ${result.code}): ${result.stderr.slice(-1200)}`,
    );
  }
  return result;
}

/**
 * Parse the `KEY=value` lines a script emits into an object.
 *
 * This is how a shell-driven install still produces structured data. Lines
 * without an `=` are ignored, so a script can log freely to stdout alongside
 * its answers.
 */
export function parseKv(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * Build a script fragment that writes `content` to `path` with `mode`.
 *
 * The content is base64-encoded into the script body, which is itself fed over
 * stdin, so the plaintext never reaches a command argument and never touches a
 * temporary file on disk. This is the only supported way to place a secret.
 */
export function writeFileScript(
  path: string,
  content: string,
  mode = "0600",
): string {
  const b64 = btoa(content);
  return [
    `mkdir -p "$(dirname ${shellEsc(path)})"`,
    `printf '%s' ${shellEsc(b64)} | base64 -d > ${shellEsc(path)}`,
    `chmod ${mode} ${shellEsc(path)}`,
  ].join("\n");
}

/**
 * Wrap a command in a remote `timeout(1)`.
 *
 * Nothing else bounds wall-clock time, and the heavy install steps look
 * identical to a hang while they are working. A stall should fail on a
 * schedule rather than block the run forever.
 */
export function withTimeout(seconds: number, command: string): string {
  return `timeout ${seconds} ${command}`;
}
