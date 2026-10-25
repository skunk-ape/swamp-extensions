/**
 * restic-backup: retention scope, globbing, staging live databases, restic's
 * JSON, and the behavior end to end against a real local repository.
 *
 * The end-to-end tests need `restic` and `sqlite3` on PATH and skip without.
 *
 * Run with: ~/.swamp/deno/deno test -A
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { model } from "./restic_backup.ts";
import { errorOf, repoUrl, snapshotsOf, summaryOf } from "./_lib/restic.ts";
import { foreignSnapshots, resolveScope } from "./_lib/scope.ts";
import {
  excludesFor,
  expandGlob,
  expandHome,
  isExcluded,
  resetStaging,
  runCaptures,
  segmentRegExp,
  stageSqlite,
} from "./_lib/stage.ts";

const has = async (bin: string, arg = "--version") => {
  try {
    return (await new Deno.Command(bin, {
      args: [arg],
      stdout: "null",
      stderr: "null",
    })
      .output()).code === 0;
  } catch {
    return false;
  }
};
const TOOLS = (await has("restic", "version")) && (await has("sqlite3"));

async function sql(db: string, ...stmts: string[]): Promise<string> {
  const r = await new Deno.Command("sqlite3", {
    args: [db, ...stmts],
    stdout: "piped",
  })
    .output();
  return new TextDecoder().decode(r.stdout).trim();
}

async function touch(path: string, body = "x") {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, body);
}

// ---- scope ------------------------------------------------------------------

Deno.test("resolveScope refuses without a tag, and without any host", () => {
  assertThrows(
    () => resolveScope({ hostname: "h", machineTag: "" }, {}),
    Error,
    "machineTag",
  );
  assertThrows(
    () => resolveScope({ hostname: "", machineTag: "t" }, {}, () => ""),
    Error,
    "hostname",
  );
  assertEquals(
    resolveScope({ hostname: "", machineTag: "t" }, {}, () => "sys"),
    {
      host: "sys",
      tag: "t",
    },
  );
  assertEquals(
    resolveScope({ hostname: "h", machineTag: "t" }, { tag: "o" }).tag,
    "o",
  );
});

Deno.test("foreignSnapshots catches another host or a missing tag", () => {
  const s = (hostname: string, tags?: string[]) => ({
    id: hostname,
    shortId: hostname,
    time: "",
    hostname,
    paths: [],
    tags,
  });
  const got = foreignSnapshots([s("a", ["t"]), s("b", ["t"]), s("a")], {
    host: "a",
    tag: "t",
  });
  assertEquals(got.map((x) => x.hostname), ["b", "a"]);
});

// ---- restic -----------------------------------------------------------------

Deno.test("repoUrl prefers repository, else the S3 bucket, else refuses", () => {
  const base = { region: "us-east-2", resticPassword: "p" };
  assertEquals(repoUrl({ ...base, repository: "/r", bucket: "b" }), "/r");
  assertEquals(
    repoUrl({ ...base, bucket: "b" }),
    "s3:s3.us-east-2.amazonaws.com/b",
  );
  assertThrows(() => repoUrl(base), Error, "No repository");
});

Deno.test("errorOf reads restic's JSON errors and nothing else", () => {
  assertEquals(
    errorOf(JSON.stringify({
      message_type: "error",
      error: { message: "permission denied" },
      during: "archival",
      item: "/x/y",
    })),
    "/x/y: permission denied",
  );
  assertEquals(errorOf(JSON.stringify({ message_type: "status" })), null);
  assertEquals(errorOf("not json"), null);
});

Deno.test("summaryOf and snapshotsOf map restic's field names", () => {
  const s = summaryOf(
    { snapshot_id: "abc", files_new: 2, data_added: 10 },
    "T",
  );
  assertEquals([
    s.snapshotId,
    s.filesNew,
    s.dataAdded,
    s.filesChanged,
    s.backedUpAt,
  ], [
    "abc",
    2,
    10,
    0,
    "T",
  ]);
  assertEquals(snapshotsOf("null"), []);
  assertEquals(
    snapshotsOf(
      JSON.stringify([{ id: "i", short_id: "s", time: "t", hostname: "h" }]),
    )[0]
      .paths,
    [],
  );
});

// ---- globbing ---------------------------------------------------------------

Deno.test("segmentRegExp: wildcards stay in one segment and skip dotfiles", () => {
  assert(segmentRegExp("*.db").test("state.db"));
  assert(!segmentRegExp("*.db").test(".hidden.db"));
  assert(segmentRegExp(".*.db").test(".hidden.db"));
  assert(segmentRegExp("state_?.sqlite").test("state_5.sqlite"));
  assert(segmentRegExp("[ab].db").test("a.db"));
  assert(!segmentRegExp("[!ab].db").test("a.db"));
  assert(!segmentRegExp("*.db").test("x.db-wal"));
});

Deno.test("expandGlob matches per segment and with **", async () => {
  const d = await Deno.makeTempDir();
  for (
    const f of [
      "a/hermes/state.db",
      "b/hermes/state.db",
      "b/hermes/cron/x.db",
      "c/other.db",
    ]
  ) {
    await touch(`${d}/${f}`);
  }
  assertEquals(await expandGlob(`${d}/*/hermes/*.db`), [
    `${d}/a/hermes/state.db`,
    `${d}/b/hermes/state.db`,
  ]);
  assertEquals((await expandGlob(`${d}/**/*.db`)).length, 4);
  assertEquals(await expandGlob(`${d}/nope/*.db`), []);
  await assertRejects(() => expandGlob("relative/*.db"), Error, "absolute");
  assertEquals(expandHome("~/x", "/home/u"), "/home/u/x");
  await Deno.remove(d, { recursive: true });
});

Deno.test("excludesFor covers sidecars and declines wildcard paths", () => {
  assertEquals(excludesFor("/a/s.db"), [
    "/a/s.db",
    "/a/s.db-wal",
    "/a/s.db-shm",
    "/a/s.db-journal",
  ]);
  assertEquals(excludesFor("/a/[x].db"), null);
});

// ---- staging ----------------------------------------------------------------

Deno.test("resetStaging refuses a directory it did not make, and shallow paths", async () => {
  const d = await Deno.makeTempDir();
  await touch(`${d}/precious.txt`);
  await assertRejects(() => resetStaging(d), Error, "refusing");
  await assertRejects(() => resetStaging("/tmp"), Error, "two levels");
  const s = `${d}/stage`;
  await resetStaging(s);
  await touch(`${s}/old`);
  await resetStaging(s); // its own marker: cleared
  assertEquals((await Array.fromAsync(Deno.readDir(s))).map((e) => e.name), [
    ".restic-backup-staging",
  ]);
  await Deno.remove(d, { recursive: true });
});

Deno.test({
  name:
    "stageSqlite copies a WAL database with uncheckpointed writes, skips non-SQLite",
  ignore: !TOOLS,
  fn: async () => {
    const d = await Deno.makeTempDir();
    const db = `${d}/live/state.db`;
    await Deno.mkdir(`${d}/live`);
    await touch(`${d}/live/notes.db`, "plain text, not a database");
    // A writer holds the database open with autocheckpoint off, so the rows
    // exist only in the -wal while we copy: state.db alone would have none.
    const writer = new Deno.Command("sqlite3", {
      args: [db],
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const w = writer.stdin.getWriter();
    await w.write(new TextEncoder().encode(
      "PRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\nCREATE TABLE t(x);\n" +
        "INSERT INTO t SELECT value FROM generate_series(1,500);\n",
    ));
    for (let i = 0; i < 100; i++) {
      const wal = await Deno.stat(`${db}-wal`).catch(() => null);
      if (
        wal && wal.size > 0 &&
        await sql(db, "SELECT count(*) FROM t;") === "500"
      ) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const fileCopy = `${d}/filecopy.db`;
    await Deno.copyFile(db, fileCopy);
    assert(
      (await sql(fileCopy, "SELECT count(*) FROM t;")) !== "500",
      "precondition: a plain file copy misses the WAL rows",
    );

    const stage = `${d}/stage`;
    await resetStaging(stage);
    const r = await stageSqlite([`${d}/live/*.db`], stage);
    await w.close();
    await writer.status;
    assertEquals(r.copies.map((c) => c.source), [db]);
    assertEquals(r.failed, []);
    assertEquals(r.excludes[0], db);
    assertEquals(
      await sql(`${stage}/sqlite${db}`, "SELECT count(*) FROM t;"),
      "500",
    );
    assertEquals(
      await sql(`${stage}/sqlite${db}`, "PRAGMA integrity_check;"),
      "ok",
    );
    await Deno.remove(d, { recursive: true });
  },
});

Deno.test("runCaptures saves stdout and records failures without throwing", async () => {
  const d = await Deno.makeTempDir();
  const r = await runCaptures([
    { name: "hello", command: ["echo", "hi"] },
    { name: "bad", command: ["false"] },
    { name: "missing", command: ["definitely-not-a-binary-xyz"] },
  ], d);
  assertEquals(await Deno.readTextFile(`${d}/captures/hello.txt`), "hi\n");
  assertEquals(r.map((c) => c.ok), [true, false, false]);
  await assertRejects(
    () => runCaptures([{ name: "../x", command: ["true"] }], d),
    Error,
  );
  await Deno.remove(d, { recursive: true });
});

// ---- the behavior, end to end -------------------------------------------------

type Handle = { spec: string; name: string; data: unknown };

function fakeCtx(globalArgs: Record<string, unknown>) {
  const store = new Map<string, unknown>();
  const logs: string[] = [];
  const log =
    (level: string) => (msg: string, props: Record<string, unknown> = {}) =>
      logs.push(
        `${level} ${msg.replace(/\{(\w+)\}/g, (_, k) => String(props[k]))}`,
      );
  const g = model.globalArguments.parse(globalArgs);
  return {
    store,
    logs,
    ctx: {
      globalArgs: g,
      logger: {
        info: log("info"),
        warning: log("warning"),
        warn: log("warning"),
      },
      readResource: (name: string) => Promise.resolve(store.get(name) ?? null),
      writeResource: (
        spec: string,
        name: string,
        data: unknown,
      ): Promise<Handle> => {
        store.set(name, data);
        return Promise.resolve({ spec, name, data });
      },
    },
  };
}

async function fixture() {
  const d = await Deno.makeTempDir();
  const src = `${d}/home`;
  await touch(`${src}/notes/a.txt`, "alpha");
  await touch(`${src}/node_modules/big.js`, "skip me");
  await touch(
    `${src}/cache/CACHEDIR.TAG`,
    "Signature: 8a477f597d28d172789f06886806bc55",
  );
  await touch(`${src}/cache/blob`, "cached");
  const db = `${src}/agent/state.db`;
  await Deno.mkdir(`${src}/agent`);
  await sql(
    db,
    "PRAGMA journal_mode=WAL;",
    "PRAGMA wal_autocheckpoint=0;",
    "CREATE TABLE t(x);",
    "INSERT INTO t VALUES (42);",
  );
  const repo = `${d}/repo`;
  const args = {
    repository: repo,
    resticPassword: "test-password",
    paths: [src],
    excludes: ["node_modules"],
    sqlite: [`${src}/*/*.db`],
    captures: [{ name: "uname", command: ["uname", "-s"] }],
    stagingDir: `${d}/stage`,
    machineTag: "testbox",
    hostname: Deno.hostname(),
  };
  const init = fakeCtx(args);
  await model.methods.init.execute({ s3Lifecycle: true }, init.ctx);
  return { d, src, db, repo, args };
}

async function lsPaths(repo: string): Promise<string[]> {
  const r = await new Deno.Command("restic", {
    args: ["ls", "--json", "latest"],
    env: { RESTIC_REPOSITORY: repo, RESTIC_PASSWORD: "test-password" },
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(r.stdout).split("\n").filter(Boolean).map((
    l,
  ) => JSON.parse(l))
    .filter((o) => o.struct_type === "node").map((o) => o.path);
}

Deno.test({
  name:
    "backup: stages the database, excludes the original, honors excludes and cache tags",
  ignore: !TOOLS,
  fn: async () => {
    const { d, src, db, repo, args } = await fixture();
    const { ctx, store } = fakeCtx(args);
    await model.methods.backup.execute({ dryRun: false }, ctx);

    // deno-lint-ignore no-explicit-any
    const last = (store.get("status") as any).lastBackup;
    assert(last.complete);
    assertEquals(last.sqliteCopies, 1);
    assertEquals(last.captures[0].ok, true);

    const paths = await lsPaths(repo);
    assert(paths.includes(`${src}/notes/a.txt`));
    assert(paths.includes(`${d}/stage/sqlite${db}`), "staged copy backed up");
    assert(paths.includes(`${d}/stage/captures/uname.txt`));
    assert(!paths.includes(db), "live original excluded");
    assert(!paths.some((p) => p.includes("node_modules")));
    assert(!paths.includes(`${src}/cache/blob`), "CACHEDIR.TAG honored");

    // Staging is removed afterwards.
    await assertRejects(() => Deno.stat(`${d}/stage`));

    // The staged copy restores as a working database.
    const out = `${d}/out`;
    await model.methods.restore.execute(
      { target: out, snapshot: "latest" },
      ctx,
    );
    assertEquals(
      await sql(`${out}${d}/stage/sqlite${db}`, "SELECT x FROM t;"),
      "42",
    );
    await Deno.remove(d, { recursive: true });
  },
});

Deno.test({
  name: "backup: unreadable files make the snapshot incomplete, not a failure",
  ignore: !TOOLS || Deno.uid() === 0,
  fn: async () => {
    const { d, src, args } = await fixture();
    await touch(`${src}/secret.txt`, "no");
    await Deno.chmod(`${src}/secret.txt`, 0o000);
    const { ctx, store, logs } = fakeCtx(args);
    await model.methods.backup.execute({ dryRun: false }, ctx);
    // deno-lint-ignore no-explicit-any
    const last = (store.get("status") as any).lastBackup;
    assertEquals(last.complete, false);
    assertEquals(last.unreadableCount, 1);
    assert(last.unreadable[0].includes("secret.txt"));
    assert(logs.some((l) => l.startsWith("warning Snapshot saved")));
    await Deno.chmod(`${src}/secret.txt`, 0o600);
    await Deno.remove(d, { recursive: true });
  },
});

Deno.test({
  name: "backup: dry run writes no snapshot",
  ignore: !TOOLS,
  fn: async () => {
    const { d, args } = await fixture();
    const { ctx, store } = fakeCtx(args);
    await model.methods.backup.execute({ dryRun: true }, ctx);
    // deno-lint-ignore no-explicit-any
    assertEquals((store.get("status") as any).lastBackup.dryRun, true);
    await model.methods.snapshots.execute({}, ctx);
    // deno-lint-ignore no-explicit-any
    assertEquals((store.get("snapshots") as any).count, 0);
    await Deno.remove(d, { recursive: true });
  },
});

Deno.test({
  name: "forget: keeps another machine's snapshots on a shared repository",
  ignore: !TOOLS,
  fn: async () => {
    const { d, args } = await fixture();
    const mine = fakeCtx(args);
    const other = fakeCtx({
      ...args,
      machineTag: "otherbox",
      hostname: "otherhost",
    });
    for (let i = 0; i < 3; i++) {
      await model.methods.backup.execute({ dryRun: false }, mine.ctx);
    }
    // restic records the real hostname; override it for the other machine.
    const r = await new Deno.Command("restic", {
      args: [
        "backup",
        "--host",
        "otherhost",
        "--tag",
        "otherbox",
        args.paths[0],
      ],
      env: {
        RESTIC_REPOSITORY: args.repository,
        RESTIC_PASSWORD: "test-password",
      },
      stdout: "null",
      stderr: "null",
    }).output();
    assertEquals(r.code, 0);

    await model.methods.forget.execute(
      {
        keepLast: 1,
        keepDaily: 0,
        keepWeekly: 0,
        keepMonthly: 0,
        prune: false,
        dryRun: false,
      },
      mine.ctx,
    );
    // deno-lint-ignore no-explicit-any
    const snaps = (mine.store.get("snapshots") as any).snapshots;
    assertEquals(
      snaps.filter((s: { hostname: string }) => s.hostname === "otherhost")
        .length,
      1,
    );
    assertEquals(snaps.length, 2);

    const unscoped = fakeCtx({ ...args, machineTag: "" });
    await assertRejects(
      () =>
        model.methods.forget.execute(
          { prune: false, dryRun: true },
          unscoped.ctx,
        ),
      Error,
      "machineTag",
    );
    void other;
    await Deno.remove(d, { recursive: true });
  },
});

Deno.test("backup refuses an empty path list", async () => {
  const { ctx } = fakeCtx({ repository: "/nonexistent", resticPassword: "p" });
  await assertRejects(
    () => model.methods.backup.execute({ dryRun: false }, ctx),
    Error,
    "No paths",
  );
});

Deno.test("isExcluded follows restic: anchored, name-anywhere, ** and dotfiles", () => {
  const ex = [
    "/home/u/.config/chromium",
    "/home/u/agents/*/hermes/cache",
    "**/.swamp/bundles",
    "node_modules",
    "*.tmp",
  ];
  assert(isExcluded("/home/u/.config/chromium/first_party_sets.db", ex));
  assert(!isExcluded("/home/u/.config/gcloud/credentials.db", ex));
  assert(isExcluded("/home/u/agents/secunit/hermes/cache/x.db", ex));
  assert(!isExcluded("/home/u/agents/secunit/hermes/state.db", ex));
  assert(isExcluded("/home/u/src/a/.swamp/bundles/b.js", ex));
  assert(isExcluded("/home/u/src/a/node_modules/x/y.db", ex));
  assert(isExcluded("/home/u/.x.tmp", ex));
  assert(!isExcluded("/home/u/src/a/.swamp/data/_catalog.db", ex));
});
