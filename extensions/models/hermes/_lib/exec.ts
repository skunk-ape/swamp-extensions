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

export interface RunOptions {
  /**
   * Cancellation signal, normally `ctx.signal`. Without it a cancelled method
   * leaves the install running on the host with nothing left to reap it.
   */
  signal?: AbortSignal;
}

/** Single-quote a value for safe interpolation into a shell script. */
export function shellEsc(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * A `expand_home` shell function, prepended to every `runScript` body.
 *
 * Configured paths are written the way a person writes them, so `~/.hermes` has
 * to become `$HOME/.hermes` somewhere. `eval echo "$path"` is the usual trick
 * and it is the wrong one: `eval` re-parses the whole string, so a path
 * containing a substitution would run as code. This expands a leading `~` and
 * nothing else.
 */
const HOME_EXPANSION = `expand_home() {
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s%s' "$HOME" "\${1#\\~}" ;;
    *) printf '%s' "$1" ;;
  esac
}
`;

/**
 * Strip ANSI colour codes from captured output.
 *
 * The upstream installer and `hermes doctor` both colour their output
 * unconditionally rather than checking for a terminal, so anything parsed out
 * of them has to be de-coloured first.
 */
export function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Run a bash script on the host and capture its output.
 *
 * The script is written to the process's stdin rather than passed as an
 * argument. Does not throw on a non-zero exit — callers decide, because a
 * probe that answers "no" is not a failure.
 */
export async function runScriptRaw(
  script: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const proc = new Deno.Command("bash", {
    args: ["-s"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    signal: opts.signal,
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
export async function runScript(
  script: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const prelude = "set -euo pipefail\n" + HOME_EXPANSION;
  const result = await runScriptRaw(prelude + script, opts);
  if (result.code !== 0) {
    throw new Error(
      `script failed (exit ${result.code}): ${result.stderr.slice(-1200)}`,
    );
  }
  return result;
}

/**
 * Run a probe script: `expand_home` available, but no `set -e`, and no throw.
 *
 * A probe's answer is its output, so a failing command inside it is data rather
 * than an error. `runScript` is for steps that have to succeed.
 */
export function runProbe(
  script: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  return runScriptRaw("set -uo pipefail\n" + HOME_EXPANSION + script, opts);
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
 * Build a script fragment that writes `content` to `pathWord` with `mode`.
 *
 * The content is base64-encoded into the script body, which is itself fed over
 * stdin, so the plaintext never reaches a command argument and never touches a
 * temporary file on disk. This is the only supported way to place a secret.
 *
 * `pathWord` is an already-quoted shell word rather than a plain string,
 * because the destination is usually only known on the target — `~` has to
 * expand there. Pass `shellEsc("/etc/thing")` for a literal, or `'"$ENV_PATH"'`
 * to write to a path the script computed.
 *
 * The file is created at `mode` before the content lands in it. Writing first
 * and chmod-ing after would leave a secret world-readable for the width of the
 * write, which on a machine running an autonomous agent is not a hypothetical.
 */
export function writeFileScript(
  pathWord: string,
  content: string,
  mode = "0600",
): string {
  // btoa reads its argument as Latin-1, so a UTF-8 string has to be encoded to
  // bytes first. Passing the string straight in throws on any character above
  // U+00FF — an accented name in a config value is enough.
  const bytes = new TextEncoder().encode(content);
  let latin1 = "";
  for (const b of bytes) latin1 += String.fromCharCode(b);
  const b64 = btoa(latin1);
  return [
    `mkdir -p "$(dirname ${pathWord})"`,
    `: > ${pathWord}`,
    `chmod ${mode} ${pathWord}`,
    `printf '%s' ${shellEsc(b64)} | base64 -d > ${pathWord}`,
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
