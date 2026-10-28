// Running restic: where the repository is, the environment it needs, and its
// JSON output turned into records.
//
// Secrets reach restic only through the environment, never argv, so they do
// not show in `ps` or in an error message that quotes the command. The one
// exception restic forces is a GCS service-account key, which it reads from
// a file: that file lives in a private temporary directory for one method
// run and is removed after.

export interface RepoArgs {
  repository?: string;
  bucket?: string;
  region: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  gcsProjectId?: string;
  gcsCredentials?: string;
  env?: Record<string, string>;
  resticPassword: string;
}

/** The restic repository URL: `repository` if set, else the S3 bucket form. */
export function repoUrl(g: RepoArgs): string {
  if (g.repository) return g.repository;
  if (g.bucket) return `s3:s3.${g.region}.amazonaws.com/${g.bucket}`;
  throw new Error(
    "No repository configured: set globalArguments.repository (any restic URL) or bucket (S3).",
  );
}

export function buildEnv(g: RepoArgs): Record<string, string> {
  const env: Record<string, string> = {
    RESTIC_REPOSITORY: repoUrl(g),
    RESTIC_PASSWORD: g.resticPassword,
  };
  if (g.awsAccessKeyId) env.AWS_ACCESS_KEY_ID = g.awsAccessKeyId;
  if (g.awsSecretAccessKey) env.AWS_SECRET_ACCESS_KEY = g.awsSecretAccessKey;
  if (g.region) env.AWS_DEFAULT_REGION = g.region;
  if (g.gcsProjectId) env.GOOGLE_PROJECT_ID = g.gcsProjectId;
  return { ...env, ...(g.env ?? {}) };
}

export interface PreparedEnv {
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

/**
 * The full environment for restic, on top of the process's own. With
 * `gcsCredentials`, the key is written to a 0600 file in a fresh temporary
 * directory and GOOGLE_APPLICATION_CREDENTIALS points at it until `cleanup`.
 * Without it, GCS falls back to the host's application-default credentials.
 */
export async function prepareEnv(g: RepoArgs): Promise<PreparedEnv> {
  const env = { ...Deno.env.toObject(), ...buildEnv(g) };
  if (!g.gcsCredentials) return { env, cleanup: () => Promise.resolve() };
  try {
    JSON.parse(g.gcsCredentials);
  } catch {
    throw new Error(
      "gcsCredentials must be a service-account key's JSON contents, not a path.",
    );
  }
  const dir = await Deno.makeTempDir({ prefix: "restic-backup-" });
  await Deno.chmod(dir, 0o700);
  const file = `${dir}/gcs-key.json`;
  await Deno.writeTextFile(file, g.gcsCredentials, { mode: 0o600 });
  env.GOOGLE_APPLICATION_CREDENTIALS = file;
  return {
    env,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => {}),
  };
}

export interface RunResult {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export async function runRestic(
  args: string[],
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<RunResult> {
  const { code, stdout, stderr } = await new Deno.Command("restic", {
    args,
    env,
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
  const dec = new TextDecoder();
  return {
    success: code === 0,
    code,
    stdout: dec.decode(stdout),
    stderr: dec.decode(stderr),
  };
}

/** Feed a byte stream to `onLine` one line at a time; resolves at EOF. */
export async function eachLine(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) onLine(l);
  }
  buf += dec.decode();
  if (buf.trim()) onLine(buf);
}

/**
 * Run restic with stdout streamed line by line, reading stderr at the same
 * time. Reading stderr only after exit deadlocks once restic writes more than
 * a pipe buffer of errors, which a backup with many unreadable files does.
 */
export async function streamRestic(
  args: string[],
  env: Record<string, string>,
  onStdout: (line: string) => void,
  onStderr: (line: string) => void,
  signal?: AbortSignal,
): Promise<number> {
  const p = new Deno.Command("restic", {
    args,
    env,
    stdout: "piped",
    stderr: "piped",
    signal,
  }).spawn();
  await Promise.all([
    eachLine(p.stdout, onStdout),
    eachLine(p.stderr, onStderr),
  ]);
  return (await p.status).code;
}

/** restic's exit code for "snapshot saved, but some files could not be read". */
export const EXIT_INCOMPLETE = 3;

export interface BackupSummary {
  snapshotId: string;
  filesNew: number;
  filesChanged: number;
  filesUnmodified: number;
  totalFilesProcessed: number;
  totalBytesProcessed: number;
  dataAdded: number;
  durationSeconds: number;
  backedUpAt: string;
}

// deno-lint-ignore no-explicit-any
type Json = any;

export function summaryOf(
  raw: Json,
  at = new Date().toISOString(),
): BackupSummary {
  return {
    snapshotId: raw.snapshot_id ?? "",
    filesNew: raw.files_new ?? 0,
    filesChanged: raw.files_changed ?? 0,
    filesUnmodified: raw.files_unmodified ?? 0,
    totalFilesProcessed: raw.total_files_processed ?? 0,
    totalBytesProcessed: raw.total_bytes_processed ?? 0,
    dataAdded: raw.data_added ?? 0,
    durationSeconds: raw.total_duration ?? 0,
    backedUpAt: at,
  };
}

/** One restic `--json` error line as "path: message", or null if it is not one. */
export function errorOf(line: string): string | null {
  try {
    const o = JSON.parse(line);
    if (o?.message_type !== "error") return null;
    const msg = o.error?.message ?? o.message ?? "error";
    return o.item ? `${o.item}: ${msg}` : msg;
  } catch {
    return null;
  }
}

export interface Snapshot {
  id: string;
  shortId: string;
  time: string;
  hostname: string;
  username?: string;
  paths: string[];
  tags?: string[];
}

export function snapshotsOf(stdout: string): Snapshot[] {
  // deno-lint-ignore no-explicit-any
  const raw: any[] = JSON.parse(stdout || "[]") ?? [];
  return raw.map((s) => ({
    id: s.id,
    shortId: s.short_id,
    time: s.time,
    hostname: s.hostname,
    username: s.username,
    paths: s.paths ?? [],
    tags: s.tags,
  }));
}
