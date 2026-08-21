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

/**
 * Where a script runs.
 *
 * This is the whole of the seam the design record argues for. Every script body
 * in the model — the probes, the installer drive, the .env write, the systemd
 * handling — is byte-identical across both, because all of them are shell fed
 * over stdin and none of them names a host.
 */
export type Transport =
  | { kind: "local" }
  | {
    kind: "ssh";
    /**
     * An ssh destination: `user@host`, or any alias `ssh` can resolve.
     *
     * Deliberately *not* accompanied by port or identity options. `ssh` reads
     * `~/.ssh/config`, which is where those belong — a Lima VM becomes
     * reachable by adding `Include ~/.lima/ * /ssh.config` there, with no code
     * here knowing anything about Lima. Re-implementing `-p` and `-i` would
     * duplicate ssh_config badly and cover less of it.
     */
    host: string;
    /** Bounds the handshake only. Wall-clock work is capped by `timeout(1)` in the script. */
    connectTimeoutSeconds?: number;
  };

export const LOCAL: Transport = { kind: "local" };

export interface RunOptions {
  /**
   * Cancellation signal, normally `ctx.signal`. Without it a cancelled method
   * leaves the install running on the host with nothing left to reap it.
   */
  signal?: AbortSignal;
  /** Defaults to local. */
  transport?: Transport;
}

/**
 * Build the argv that runs `bash -s` in the right place.
 *
 * Two `ssh` options are set and no more:
 *
 * - `BatchMode=yes`, so any prompt fails immediately instead of hanging
 *   forever against a pipe nobody is watching. This is the safety net behind
 *   the installer's `--non-interactive`.
 * - `ConnectTimeout`, so an unreachable host fails on a schedule.
 *
 * Everything else is left to the caller's ssh_config **on purpose**. In
 * particular `StrictHostKeyChecking` is not set: forcing it off — as at least
 * one published SSH extension does, alongside `UserKnownHostsFile=/dev/null` —
 * silently destroys host verification for every connection the model makes, and
 * a model that reaches outward to install software with sudo is the last place
 * that should happen. Inheriting the user's policy is both safer and less code.
 */
export function buildCommand(t: Transport): { bin: string; args: string[] } {
  if (t.kind === "local") return { bin: "bash", args: ["-s"] };
  return {
    bin: "ssh",
    args: [
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${Math.floor(t.connectTimeoutSeconds ?? 10)}`,
      t.host,
      "bash",
      "-s",
    ],
  };
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
 * How long to keep draining the output pipes after the script has exited.
 *
 * See runScriptRaw. Two seconds is far more than a drain of already-buffered
 * bytes needs, and it is only ever paid when a descendant outlived the script.
 */
const DRAIN_GRACE_MS = 2000;

/**
 * Run a bash script on the host and capture its output.
 *
 * The script is written to the process's stdin rather than passed as an
 * argument. Does not throw on a non-zero exit — callers decide, because a
 * probe that answers "no" is not a failure.
 *
 * ## Why this does not use `proc.output()`
 *
 * `proc.output()` waits for end-of-file on the output pipes, not for the
 * process to exit. Those are the same thing right up until a grandchild
 * survives its parent: the orphan inherits the write end of the pipe, EOF never
 * arrives, and the call blocks forever on a script that finished minutes ago.
 *
 * This is not hypothetical. It is what the first real run of `install` did.
 * The upstream installer wraps its Playwright step in `timeout 600`, `timeout`
 * signals only the child it spawned, and the Chromium downloader two levels
 * below it survived. The installer exited successfully, and the method sat
 * there for another thirteen minutes holding a pipe open for a process that had
 * nothing left to say — long enough that the dispatch's own credential expired
 * underneath it and the resource write then failed with a 401.
 *
 * So: wait for the process to *exit*, let the pipes drain briefly for whatever
 * was already buffered, then cancel the readers and move on. A stray orphan
 * costs DRAIN_GRACE_MS instead of the rest of the run.
 */
export async function runScriptRaw(
  script: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const { bin, args } = buildCommand(opts.transport ?? LOCAL);
  const proc = new Deno.Command(bin, {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    signal: opts.signal,
  }).spawn();

  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(script));
  await writer.close();

  const outReader = proc.stdout.getReader();
  const errReader = proc.stderr.getReader();

  const drain = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    into: Uint8Array[],
  ) => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) into.push(value);
      }
    } catch {
      // Cancelled below, or the pipe broke. Either way we keep what we read.
    }
  };

  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const pumping = Promise.all([
    drain(outReader, outChunks),
    drain(errReader, errChunks),
  ]);

  const status = await proc.status;

  // The pipes usually hit EOF the moment the script exits. When they do not,
  // something outlived it, and waiting is waiting forever.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    pumping,
    new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, DRAIN_GRACE_MS);
    }),
  ]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);

  await outReader.cancel().catch(() => {});
  await errReader.cancel().catch(() => {});

  const join = (chunks: Uint8Array[]) => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const buf = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      buf.set(c, at);
      at += c.length;
    }
    return new TextDecoder().decode(buf);
  };

  return {
    stdout: join(outChunks),
    stderr: join(errChunks),
    code: status.code,
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

  // Written to a sibling temp file and renamed over the destination, because
  // rename(2) is atomic within a filesystem: a reader sees either the old file
  // or the new one, never a half-written one. Truncating in place would leave a
  // window where the file is empty or partial, and the window is not
  // theoretical here — `service` restarts the gateway immediately after
  // `configure` writes the .env, and the gateway reads that file at startup.
  //
  // The temp lives beside the destination rather than in /tmp so the rename
  // stays within one filesystem. Borrowed from @mgreten/hermes-env, which got
  // this right first.
  return [
    `__hermes_dst=${pathWord}`,
    `__hermes_tmp="$__hermes_dst.tmp.$$"`,
    `mkdir -p "$(dirname "$__hermes_dst")"`,
    `: > "$__hermes_tmp"`,
    `chmod ${mode} "$__hermes_tmp"`,
    `if ! printf '%s' ${shellEsc(b64)} | base64 -d > "$__hermes_tmp"; then`,
    `  rm -f "$__hermes_tmp"`,
    `  echo "failed writing $__hermes_dst" >&2`,
    `  exit 1`,
    `fi`,
    `mv -f "$__hermes_tmp" "$__hermes_dst"`,
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
