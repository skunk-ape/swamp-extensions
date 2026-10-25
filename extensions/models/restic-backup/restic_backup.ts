/**
 * @skunk-ape/restic-backup — encrypted, deduplicated backups with restic, for
 * one machine on a repository several machines may share.
 *
 * `backup` copies live SQLite databases consistently and saves capture
 * commands' output before restic runs, so a busy database restores whole and
 * a machine can be rebuilt from its package lists. `forget` is scoped to this
 * machine's host and tag and refuses to run without both, so retention on a
 * shared repository can never select another machine's snapshots.
 */
import { z } from "npm:zod@4";
import {
  type BackupSummary,
  errorOf,
  EXIT_INCOMPLETE,
  prepareEnv,
  repoUrl,
  runRestic,
  type Snapshot,
  snapshotsOf,
  streamRestic,
  summaryOf,
} from "./_lib/restic.ts";
import { foreignSnapshots, resolveScope } from "./_lib/scope.ts";
import {
  type CaptureResult,
  clearStaging,
  expandHome,
  resetStaging,
  runCaptures,
  type StageResult,
  stageSqlite,
} from "./_lib/stage.ts";

// deno-lint-ignore no-explicit-any
type Ctx = any;

const GlobalArgsSchema = z.object({
  repository: z.string().default("").describe(
    "restic repository URL (any backend: s3:, gs:, b2:, sftp:, rest:, a local path). Empty uses `bucket`.",
  ),
  bucket: z.string().default("").describe(
    "S3 bucket for the repository, when `repository` is empty. Enables the S3 lifecycle policy on init.",
  ),
  region: z.string().default("us-east-2").describe(
    "AWS region of the S3 bucket",
  ),
  awsAccessKeyId: z.string().default("").meta({ sensitive: true }).describe(
    "AWS access key ID, for S3 repositories",
  ),
  awsSecretAccessKey: z.string().default("").meta({ sensitive: true }).describe(
    "AWS secret access key, for S3 repositories",
  ),
  gcsProjectId: z.string().default("").describe(
    "Google Cloud project, for gs: repositories (restic needs it to create the bucket on init).",
  ),
  gcsCredentials: z.string().default("").meta({ sensitive: true }).describe(
    "Service-account key JSON (the contents, from a vault), for gs: repositories. Empty uses the host's application-default credentials.",
  ),
  env: z.record(z.string(), z.string()).default({}).meta({ sensitive: true })
    .describe(
      "Extra environment for restic, for other backends' credentials (B2_ACCOUNT_KEY, AZURE_ACCOUNT_KEY, RESTIC_REST_PASSWORD, …). Values come from a vault.",
    ),
  resticPassword: z.string().meta({ sensitive: true }).describe(
    "Repository encryption password — required to decrypt backups. Keep a copy offline.",
  ),
  paths: z.array(z.string()).default([]).describe(
    "Paths to back up; `~/` is expanded. Empty means `backup` refuses to run.",
  ),
  excludes: z.array(z.string()).default([
    "node_modules",
    "*.tmp",
    ".DS_Store",
  ]).describe("restic exclude patterns"),
  excludeCaches: z.boolean().default(true).describe(
    "Skip directories holding a CACHEDIR.TAG file (cargo, many build tools and caches mark theirs).",
  ),
  sqlite: z.array(z.string()).default([]).describe(
    "Globs (`*`, `?`, `[...]`, `**`) for live SQLite databases. Each match is copied with SQLite's online backup into the staging directory and backed up from there; the original and its -wal/-shm are excluded. Files that are not SQLite are ignored.",
  ),
  captures: z.array(z.object({
    name: z.string().describe(
      "File name, saved as captures/<name>.txt in the staging directory",
    ),
    command: z.array(z.string()).min(1).describe("argv; no shell"),
  })).default([]).describe(
    "Commands whose stdout is saved and backed up, such as installed package lists.",
  ),
  stagingDir: z.string().default("").describe(
    "Where database copies and captures are written before the backup and removed after. Empty uses ~/.local/state/restic-backup/<machineTag or default>.",
  ),
  keepLast: z.number().int().positive().default(10),
  keepDaily: z.number().int().nonnegative().default(7).describe("0 disables"),
  keepWeekly: z.number().int().nonnegative().default(4).describe("0 disables"),
  keepMonthly: z.number().int().nonnegative().default(12).describe(
    "0 disables",
  ),
  machineTag: z.string().default("").describe(
    "Tag on every snapshot from this machine. Required for forget, which is scoped to it.",
  ),
  hostname: z.string().default("").describe(
    "Hostname forget is scoped to. Empty uses the system hostname.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const BackupSummarySchema = z.object({
  snapshotId: z.string(),
  filesNew: z.number(),
  filesChanged: z.number(),
  filesUnmodified: z.number(),
  totalFilesProcessed: z.number(),
  totalBytesProcessed: z.number(),
  dataAdded: z.number(),
  durationSeconds: z.number(),
  backedUpAt: z.string(),
  complete: z.boolean().default(true).describe(
    "False when restic saved the snapshot but could not read some files.",
  ),
  dryRun: z.boolean().default(false),
  unreadable: z.array(z.string()).default([]).describe(
    "The first files restic could not read",
  ),
  unreadableCount: z.number().default(0),
  sqliteCopies: z.number().default(0),
  sqliteBytes: z.number().default(0),
  sqliteFailed: z.array(z.object({ source: z.string(), error: z.string() }))
    .default([]),
  captures: z.array(z.object({
    name: z.string(),
    ok: z.boolean(),
    bytes: z.number(),
    error: z.string().optional(),
  })).default([]),
});

const StatusSchema = z.object({
  repository: z.string(),
  initialized: z.boolean(),
  lastBackup: BackupSummarySchema.nullable(),
  lastCheckAt: z.string().nullable(),
  lastCheckPassed: z.boolean().nullable(),
});
type StatusData = z.infer<typeof StatusSchema>;

const SnapshotsSchema = z.object({
  snapshots: z.array(z.object({
    id: z.string(),
    shortId: z.string(),
    time: z.string(),
    hostname: z.string(),
    username: z.string().optional(),
    paths: z.array(z.string()),
    tags: z.array(z.string()).optional(),
  })),
  count: z.number(),
  retrievedAt: z.string(),
});

const MAX_UNREADABLE = 50;

// The environment prepared for the method run in progress, keyed by its
// context. Every method runs inside withEnv (applied at the bottom of this
// file), which prepares it first and cleans up after, whatever happens.
const ENVS = new WeakMap<object, Record<string, string>>();

function env(ctx: Ctx): Record<string, string> {
  const e = ENVS.get(ctx);
  if (!e) throw new Error("restic environment not prepared for this run");
  return e;
}

// deno-lint-ignore no-explicit-any
function withEnv(execute: (args: any, ctx: Ctx) => Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  return async (args: any, ctx: Ctx) => {
    const prepared = await prepareEnv(ctx.globalArgs as GlobalArgs);
    ENVS.set(ctx, prepared.env);
    try {
      return await execute(args, ctx);
    } finally {
      ENVS.delete(ctx);
      await prepared.cleanup();
    }
  };
}

function stagingDirOf(g: GlobalArgs): string {
  return expandHome(
    g.stagingDir || `~/.local/state/restic-backup/${g.machineTag || "default"}`,
  );
}

async function writeStatus(
  ctx: Ctx,
  g: GlobalArgs,
  patch: Partial<StatusData>,
) {
  const prev = await ctx.readResource("status") as StatusData | null;
  return ctx.writeResource("status", "status", {
    repository: repoUrl(g),
    initialized: true,
    lastBackup: prev?.lastBackup ?? null,
    lastCheckAt: prev?.lastCheckAt ?? null,
    lastCheckPassed: prev?.lastCheckPassed ?? null,
    ...patch,
  });
}

function writeSnapshots(ctx: Ctx, snapshots: Snapshot[]) {
  return ctx.writeResource("snapshots", "snapshots", {
    snapshots,
    count: snapshots.length,
    retrievedAt: new Date().toISOString(),
  });
}

const mb = (n: number) => Math.round(n / 1024 / 1024);

/** The `@skunk-ape/restic-backup` behavior type. */
export const model = {
  type: "@skunk-ape/restic-backup",
  version: "2026.10.24.2",
  globalArguments: GlobalArgsSchema,

  resources: {
    status: {
      description:
        "Repository status, the last backup's summary and the last check",
      schema: StatusSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    snapshots: {
      description: "Snapshots in the repository, as last listed",
      schema: SnapshotsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },

  checks: {
    "restic-installed": {
      description: "Verify the restic binary is installed",
      labels: ["local"],
      execute: async () => {
        try {
          const { code } = await new Deno.Command("restic", {
            args: ["version"],
            stdout: "null",
            stderr: "null",
          }).output();
          if (code === 0) return { pass: true };
        } catch { /* not on PATH */ }
        return { pass: false, errors: ["restic not found on PATH"] };
      },
    },
  },

  methods: {
    init: {
      description:
        "Initialize the repository (idempotent). For an S3 bucket, also applies a lifecycle policy moving pack files to Standard-IA after 30 days and Glacier IR after 90.",
      arguments: z.object({
        s3Lifecycle: z.boolean().default(true).describe(
          "Apply the S3 lifecycle policy (bucket repositories only; needs the aws CLI)",
        ),
      }),
      execute: async (args: { s3Lifecycle: boolean }, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;
        const repo = repoUrl(g);
        const r = await runRestic(["init"], env(ctx), ctx.signal);
        const exists = /already (been )?initialized|config file already exists/
          .test(
            r.stderr + r.stdout,
          );
        if (!r.success && !exists) {
          throw new Error(`restic init failed (exit ${r.code}): ${r.stderr}`);
        }
        ctx.logger.info(
          exists
            ? "Repository already initialized at {repo}"
            : "Initialized {repo}",
          {
            repo,
          },
        );

        if (g.bucket && !g.repository && args.s3Lifecycle) {
          // index/, snapshots/ and keys/ are read on every run and stay in
          // Standard; only data/ is tiered.
          const policy = JSON.stringify({
            Rules: [{
              ID: "restic-data-tiering",
              Filter: { Prefix: "data/" },
              Status: "Enabled",
              Transitions: [
                { Days: 30, StorageClass: "STANDARD_IA" },
                { Days: 90, StorageClass: "GLACIER_IR" },
              ],
            }],
          });
          const aws = await new Deno.Command("aws", {
            args: [
              "s3api",
              "put-bucket-lifecycle-configuration",
              "--bucket",
              g.bucket,
              "--lifecycle-configuration",
              policy,
              "--region",
              g.region,
            ],
            env: env(ctx),
            stdout: "piped",
            stderr: "piped",
          }).output();
          if (aws.code !== 0) {
            throw new Error(
              `Failed to apply lifecycle policy (exit ${aws.code}): ${
                new TextDecoder().decode(aws.stderr)
              }`,
            );
          }
          ctx.logger.info(
            "Lifecycle policy applied: Standard-IA after 30d, Glacier IR after 90d",
          );
        }
        return {
          dataHandles: [await writeStatus(ctx, g, { initialized: true })],
        };
      },
    },

    backup: {
      description:
        "Back up the configured paths, tagged with machineTag. Live SQLite databases matching `sqlite` are copied consistently first and captures are saved; both are backed up from the staging directory, which is removed afterwards. A snapshot saved with some files unreadable is recorded as incomplete rather than failed. `dryRun` reports what would be added without writing to the repository.",
      arguments: z.object({
        paths: z.array(z.string()).optional().describe(
          "Override paths for this run",
        ),
        tag: z.string().optional().describe(
          "Override the machine tag for this run",
        ),
        dryRun: z.boolean().default(false).describe(
          "Scan and report what would be uploaded; writes nothing to the repository",
        ),
      }),
      execute: async (
        args: { paths?: string[]; tag?: string; dryRun: boolean },
        ctx: Ctx,
      ) => {
        const g = ctx.globalArgs as GlobalArgs;
        const paths = (args.paths ?? g.paths).map((p) => expandHome(p));
        if (!paths.length) {
          throw new Error("No paths configured; refusing to back up nothing.");
        }
        const tag = args.tag || g.machineTag;
        if (!tag) {
          ctx.logger.warning(
            "No machineTag set: this snapshot is untagged and no scoped forget can manage it.",
          );
        }

        const staging = stagingDirOf(g);
        const staged = g.sqlite.length > 0 || g.captures.length > 0;
        let stage: StageResult = { copies: [], failed: [], excludes: [] };
        let captures: CaptureResult[] = [];
        if (staged) {
          await resetStaging(staging);
          stage = await stageSqlite(g.sqlite, staging, g.excludes);
          captures = await runCaptures(g.captures, staging);
          ctx.logger.info(
            "Staged {n} SQLite copies ({mb}MB) and {c} capture(s)",
            {
              n: stage.copies.length,
              mb: mb(stage.copies.reduce((s, c) => s + c.bytes, 0)),
              c: captures.length,
            },
          );
          for (const f of stage.failed) {
            ctx.logger.warning("Could not copy {db}: {error}", {
              db: f.source,
              error: f.error,
            });
          }
          for (const c of captures.filter((c) => !c.ok)) {
            ctx.logger.warning("Capture {name} failed: {error}", c);
          }
        }

        const argv = [
          "backup",
          "--json",
          ...(args.dryRun ? ["--dry-run"] : []),
          ...(g.excludeCaches ? ["--exclude-caches"] : []),
          ...(tag ? ["--tag", tag] : []),
          ...[...g.excludes, ...stage.excludes].flatMap((
            e,
          ) => ["--exclude", e]),
          ...paths,
          ...(staged ? [staging] : []),
        ];
        ctx.logger.info("Backing up {n} path(s) to {repo}{dry}", {
          n: paths.length,
          repo: repoUrl(g),
          dry: args.dryRun ? " (dry run)" : "",
        });

        let summaryRaw: unknown;
        const unreadable: string[] = [];
        let unreadableCount = 0;
        const otherErr: string[] = [];
        let lastPct = -1;
        let lastLog = Date.now();
        const started = Date.now();
        const onLine = (line: string) => {
          const err = errorOf(line);
          if (err) {
            unreadableCount++;
            if (unreadable.length < MAX_UNREADABLE) unreadable.push(err);
            return;
          }
          let o;
          try {
            o = JSON.parse(line);
          } catch {
            if (otherErr.length < 20) otherErr.push(line);
            return;
          }
          if (o.message_type === "summary") summaryRaw = o;
          else if (o.message_type === "status") {
            const pct = Math.floor((o.percent_done ?? 0) * 100);
            const now = Date.now();
            if (pct >= lastPct + 5 || now - lastLog > 30000) {
              ctx.logger.info(
                "Progress: {pct}% — {done}/{total} files, {mb}MB ({s}s)",
                {
                  pct,
                  done: o.files_done ?? 0,
                  total: o.total_files ?? 0,
                  mb: mb(o.bytes_done ?? 0),
                  s: Math.round((now - started) / 1000),
                },
              );
              lastPct = pct;
              lastLog = now;
            }
          }
        };

        let code: number;
        try {
          code = await streamRestic(argv, env(ctx), onLine, onLine, ctx.signal);
        } finally {
          if (staged) await clearStaging(staging);
        }

        if (code !== 0 && code !== EXIT_INCOMPLETE) {
          throw new Error(
            `restic backup failed (exit ${code}): ${
              [...otherErr, ...unreadable].join("\n")
            }`,
          );
        }
        if (!summaryRaw) {
          throw new Error("restic backup finished without a summary");
        }

        const summary: BackupSummary & z.infer<typeof BackupSummarySchema> = {
          ...summaryOf(summaryRaw),
          complete: code === 0,
          dryRun: args.dryRun,
          unreadable,
          unreadableCount,
          sqliteCopies: stage.copies.length,
          sqliteBytes: stage.copies.reduce((s, c) => s + c.bytes, 0),
          sqliteFailed: stage.failed,
          captures: captures.map(({ name, ok, bytes, error }) => ({
            name,
            ok,
            bytes,
            error,
          })),
        };
        if (!summary.complete) {
          ctx.logger.warning(
            "Snapshot saved, but {n} file(s) could not be read",
            {
              n: unreadableCount,
            },
          );
        }
        ctx.logger.info(
          "{verb} {id}: {files} files, {total}MB scanned, {added}MB new, in {s}s",
          {
            verb: args.dryRun ? "Dry run" : "Snapshot",
            id: summary.snapshotId || "-",
            files: summary.totalFilesProcessed,
            total: mb(summary.totalBytesProcessed),
            added: mb(summary.dataAdded),
            s: Math.round(summary.durationSeconds),
          },
        );
        return {
          dataHandles: [await writeStatus(ctx, g, { lastBackup: summary })],
        };
      },
    },

    snapshots: {
      description: "List snapshots, optionally filtered by host and tag",
      arguments: z.object({
        host: z.string().optional(),
        tag: z.string().optional(),
      }),
      execute: async (args: { host?: string; tag?: string }, ctx: Ctx) => {
        const filter = [
          ...(args.host ? ["--host", args.host] : []),
          ...(args.tag ? ["--tag", args.tag] : []),
        ];
        const r = await runRestic(
          ["snapshots", "--json", ...filter],
          env(ctx),
          ctx.signal,
        );
        if (!r.success) {
          throw new Error(
            `restic snapshots failed (exit ${r.code}): ${r.stderr}`,
          );
        }
        const snaps = snapshotsOf(r.stdout);
        ctx.logger.info("{n} snapshot(s)", { n: snaps.length });
        return { dataHandles: [await writeSnapshots(ctx, snaps)] };
      },
    },

    check: {
      description:
        "Verify repository integrity; a failed check is recorded, not thrown",
      arguments: z.object({
        readData: z.boolean().default(false).describe(
          "Also download and verify pack contents (slow; on Glacier IR, costs retrieval)",
        ),
        readDataSubset: z.string().optional().describe(
          'Verify only part of the pack data, e.g. "5%" or "1/7"',
        ),
      }),
      execute: async (
        args: { readData: boolean; readDataSubset?: string },
        ctx: Ctx,
      ) => {
        const g = ctx.globalArgs as GlobalArgs;
        const argv = [
          "check",
          ...(args.readData ? ["--read-data"] : []),
          ...(args.readDataSubset
            ? ["--read-data-subset", args.readDataSubset]
            : []),
        ];
        const r = await runRestic(argv, env(ctx), ctx.signal);
        if (r.success) ctx.logger.info("Integrity check passed");
        else {ctx.logger.warning("Integrity check FAILED: {detail}", {
            detail: r.stderr.trim(),
          });}
        return {
          dataHandles: [
            await writeStatus(ctx, g, {
              lastCheckAt: new Date().toISOString(),
              lastCheckPassed: r.success,
            }),
          ],
        };
      },
    },

    ls: {
      description: "List files in a snapshot (logged, up to `limit` entries)",
      arguments: z.object({
        snapshot: z.string().default("latest"),
        path: z.string().optional().describe("Limit the listing to this path"),
        limit: z.number().int().positive().default(200),
      }),
      execute: async (
        args: { snapshot: string; path?: string; limit: number },
        ctx: Ctx,
      ) => {
        const r = await runRestic(
          ["ls", "--json", args.snapshot, ...(args.path ? [args.path] : [])],
          env(ctx),
          ctx.signal,
        );
        if (!r.success) {
          throw new Error(`restic ls failed (exit ${r.code}): ${r.stderr}`);
        }
        let shown = 0;
        let total = 0;
        for (const line of r.stdout.split("\n")) {
          if (!line.trim()) continue;
          let o;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          if (o.struct_type === "snapshot") {
            ctx.logger.info("Snapshot {id} ({time})", {
              id: o.short_id,
              time: o.time,
            });
          } else if (o.struct_type === "node") {
            total++;
            if (shown < args.limit) {
              shown++;
              const size = o.size != null
                ? ` (${Math.round(o.size / 1024)}KB)`
                : "";
              ctx.logger.info(
                `  ${o.type === "dir" ? "d" : "f"} ${o.path}${size}`,
              );
            }
          }
        }
        if (total > shown) {
          ctx.logger.info("…{n} more; narrow with `path` or raise `limit`", {
            n: total - shown,
          });
        }
        return { dataHandles: [] };
      },
    },

    restore: {
      description:
        "Restore a snapshot into a local directory. Database copies come back under <stagingDir>/sqlite/<original path>.",
      arguments: z.object({
        target: z.string().describe("Directory to restore into"),
        snapshot: z.string().default("latest"),
        include: z.array(z.string()).optional().describe(
          "Only restore these paths",
        ),
      }),
      execute: async (
        args: { target: string; snapshot: string; include?: string[] },
        ctx: Ctx,
      ) => {
        const target = expandHome(args.target);
        const r = await runRestic(
          [
            "restore",
            args.snapshot,
            "--target",
            target,
            ...(args.include ?? []).flatMap((p) => ["--include", p]),
          ],
          env(ctx),
          ctx.signal,
        );
        if (!r.success) {
          throw new Error(
            `restic restore failed (exit ${r.code}): ${r.stderr}`,
          );
        }
        ctx.logger.info("Restored {snapshot} to {target}: {out}", {
          snapshot: args.snapshot,
          target,
          out: r.stdout.trim(),
        });
        return { dataHandles: [] };
      },
    },

    rekey: {
      description: "Change the repository password",
      arguments: z.object({
        newPasswordFile: z.string().describe("File holding the new password"),
      }),
      execute: async (args: { newPasswordFile: string }, ctx: Ctx) => {
        const r = await runRestic(
          [
            "key",
            "passwd",
            "--new-password-file",
            expandHome(args.newPasswordFile),
          ],
          env(ctx),
          ctx.signal,
        );
        if (!r.success) {
          throw new Error(
            `restic key passwd failed (exit ${r.code}): ${r.stderr}`,
          );
        }
        ctx.logger.info(
          "Password changed. Store the new one in the vault, then delete {file}.",
          { file: args.newPasswordFile },
        );
        return { dataHandles: [] };
      },
    },

    forget: {
      description:
        "Apply the retention policy to this machine's snapshots only, selected by host AND tag. Refuses to run unscoped or if the selector matches another machine's snapshot. Pruning is opt-in.",
      arguments: z.object({
        keepLast: z.number().int().positive().optional(),
        keepDaily: z.number().int().nonnegative().optional(),
        keepWeekly: z.number().int().nonnegative().optional(),
        keepMonthly: z.number().int().nonnegative().optional(),
        host: z.string().optional(),
        tag: z.string().optional(),
        prune: z.boolean().default(false).describe(
          "Also repack to reclaim space. Repository-wide, and on data already in Glacier IR it costs retrieval and re-upload.",
        ),
        dryRun: z.boolean().default(false),
      }),
      execute: async (
        args: {
          keepLast?: number;
          keepDaily?: number;
          keepWeekly?: number;
          keepMonthly?: number;
          host?: string;
          tag?: string;
          prune: boolean;
          dryRun: boolean;
        },
        ctx: Ctx,
      ) => {
        const g = ctx.globalArgs as GlobalArgs;
        const e = env(ctx);
        const keep = {
          last: args.keepLast ?? g.keepLast,
          daily: args.keepDaily ?? g.keepDaily,
          weekly: args.keepWeekly ?? g.keepWeekly,
          monthly: args.keepMonthly ?? g.keepMonthly,
        };
        const scope = resolveScope(g, { host: args.host, tag: args.tag });

        // Belt and braces against restic changing its selection semantics:
        // preview the selector and stop if it reaches beyond this machine.
        const pre = await runRestic(
          ["snapshots", "--json", "--host", scope.host, "--tag", scope.tag],
          e,
          ctx.signal,
        );
        if (!pre.success) {
          throw new Error(`Failed to preview forget scope: ${pre.stderr}`);
        }
        const selected = snapshotsOf(pre.stdout);
        const foreign = foreignSnapshots(selected, scope);
        if (foreign.length) {
          throw new Error(
            `Refusing to run forget: host=${scope.host} tag=${scope.tag} matched ` +
              `${foreign.length} snapshot(s) of another machine (${
                foreign.map((f) => `${f.shortId}@${f.hostname}`).join(", ")
              }).`,
          );
        }
        ctx.logger.info(
          "Retention scope host={host} tag={tag}: {n} snapshot(s)",
          {
            ...scope,
            n: selected.length,
          },
        );

        const r = await runRestic(
          [
            "forget",
            "--host",
            scope.host,
            "--tag",
            scope.tag,
            "--group-by",
            "host,paths",
            "--keep-last",
            String(keep.last),
            ...(keep.daily > 0 ? ["--keep-daily", String(keep.daily)] : []),
            ...(keep.weekly > 0 ? ["--keep-weekly", String(keep.weekly)] : []),
            ...(keep.monthly > 0
              ? ["--keep-monthly", String(keep.monthly)]
              : []),
            ...(args.prune ? ["--prune"] : []),
            ...(args.dryRun ? ["--dry-run"] : []),
            "--json",
          ],
          e,
          ctx.signal,
        );
        if (!r.success) {
          throw new Error(`restic forget failed (exit ${r.code}): ${r.stderr}`);
        }

        let removed = 0;
        try {
          // deno-lint-ignore no-explicit-any
          for (const grp of JSON.parse(r.stdout) as any[]) {
            removed += grp.remove?.length ?? 0;
          }
        } catch { /* older restic without per-group JSON */ }
        ctx.logger.info("Forget {verb} {n} snapshot(s)", {
          verb: args.dryRun ? "would remove" : "removed",
          n: removed,
        });

        const list = await runRestic(["snapshots", "--json"], e, ctx.signal);
        if (!list.success) {
          throw new Error(`Failed to refresh snapshots: ${list.stderr}`);
        }
        return {
          dataHandles: [await writeSnapshots(ctx, snapshotsOf(list.stdout))],
        };
      },
    },
  },
};

for (const m of Object.values(model.methods)) {
  // deno-lint-ignore no-explicit-any
  (m as any).execute = withEnv(m.execute);
}
