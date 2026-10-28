import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  assertNoSymlinks,
  ensureDirSafe,
  privateTempDir,
  readRegularFile,
  SymlinkRefused,
  writeFileSafe,
} from "./safefs.ts";

/** A workdir the "bot" has planted things in, and a target outside it the
 * operator cares about. */
async function setup(): Promise<{ root: string; outside: string; base: string }> {
  const base = await Deno.makeTempDir({ prefix: "hermes-safefs-" });
  const root = `${base}/workdir`;
  const outside = `${base}/operator`;
  await Deno.mkdir(root);
  await Deno.mkdir(outside);
  await Deno.writeTextFile(`${outside}/bashrc`, "original");
  return { root, outside, base };
}

Deno.test("a symlinked directory on the way is refused, and nothing is written through it", async () => {
  const { root, outside, base } = await setup();
  try {
    await Deno.symlink(outside, `${root}/hermes`);
    await assertRejects(
      () => writeFileSafe(root, "hermes/config.yaml", "x", 0o644),
      SymlinkRefused,
    );
    // Nothing landed in the target directory.
    const names = [];
    for await (const e of Deno.readDir(outside)) names.push(e.name);
    assertEquals(names, ["bashrc"]);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("a symlink at the file itself is replaced, not written through", async () => {
  const { root, outside, base } = await setup();
  try {
    await Deno.mkdir(`${root}/hermes`);
    await Deno.symlink(`${outside}/bashrc`, `${root}/hermes/config.yaml`);
    await writeFileSafe(root, "hermes/config.yaml", "new", 0o644);
    assertEquals(await Deno.readTextFile(`${outside}/bashrc`), "original");
    assertEquals(await Deno.readTextFile(`${root}/hermes/config.yaml`), "new");
    assert(!(await Deno.lstat(`${root}/hermes/config.yaml`)).isSymlink);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("the written file gets the mode asked for", async () => {
  const { root, base } = await setup();
  try {
    await writeFileSafe(root, "tools/hook.sh", "#!/bin/sh\n", 0o755);
    assertEquals((await Deno.stat(`${root}/tools/hook.sh`)).mode! & 0o777, 0o755);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("ensureDirSafe refuses a symlink anywhere in the path", async () => {
  const { root, outside, base } = await setup();
  try {
    await Deno.mkdir(`${root}/funes`);
    await Deno.symlink(outside, `${root}/funes/hf`);
    await assertRejects(
      () => ensureDirSafe(root, "funes/hf/hub"),
      SymlinkRefused,
    );
    // The happy path still creates real directories.
    await ensureDirSafe(root, "workspace/inbox");
    assert((await Deno.lstat(`${root}/workspace/inbox`)).isDirectory);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("a path that climbs out of the root is refused", async () => {
  const { root, base } = await setup();
  try {
    await assertRejects(
      () => assertNoSymlinks(root, "../operator/bashrc"),
      SymlinkRefused,
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

// Every bot can write /tmp and watch it for new names; the operator's temp
// directories live where no sandbox is granted anything.
Deno.test("private temp dirs live under .runtime/.tmp, owner-only", async () => {
  const root = await Deno.makeTempDir({ prefix: "hermes-priv-" });
  try {
    const t = await privateTempDir(root, "fetch-");
    assert(t.startsWith(`${root}/.runtime/.tmp/fetch-`));
    assertEquals((await Deno.stat(`${root}/.runtime/.tmp`)).mode! & 0o777, 0o700);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a read refuses a FIFO the bot left, rather than hang on it", async () => {
  const root = await Deno.makeTempDir({ prefix: "hermes-fifo-" });
  try {
    await Deno.mkdir(`${root}/hermes`);
    const mk = await new Deno.Command("mkfifo", { args: [`${root}/hermes/config.yaml`] })
      .output();
    assert(mk.success);
    await assertRejects(() => readRegularFile(root, "hermes/config.yaml"), SymlinkRefused);
    assertEquals(await readRegularFile(root, "hermes/absent.yaml"), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
