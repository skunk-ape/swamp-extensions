// Filesystem writes into a directory the bot can write.
//
// The workdir is the bot's: anything in it may have been put there by a
// prompt-injected agent. Host-side methods — provision, restore — still write
// into it, as the operator, outside the sandbox. A plain write follows
// symlinks, so a bot that plants `hermes -> ~/.ssh` or `config.yaml ->
// ~/.bashrc` turns the operator's next provision into a write wherever it
// pointed. Everything here refuses to pass through a symlink.
//
// Deno has no openat, so the component check and the write are two steps and
// a bot running at the same moment could swap a directory between them. That
// is why provision and restore refuse while the gateway is running; what this
// file closes is the planted-and-waiting case, which needs no timing at all.

// deno-lint-ignore no-explicit-any
declare const Deno: any;

/** Thrown when a path below a bot-writable root passes through a symlink. */
export class SymlinkRefused extends Error {}

async function lstatOrNull(
  path: string,
): Promise<
  { isSymlink: boolean; isDirectory: boolean; isFile: boolean } | null
> {
  try {
    return await Deno.lstat(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

/**
 * Refuse when any existing component of `root/rel` is a symlink.
 *
 * `root` itself is trusted: it is the workdir, created by provision inside a
 * parent the bot cannot write. Components that do not exist yet are fine —
 * they will be created as real directories.
 */
export async function assertNoSymlinks(
  root: string,
  rel: string,
): Promise<void> {
  let at = root;
  for (const part of rel.split("/").filter((p) => p !== "" && p !== ".")) {
    if (part === "..") {
      throw new SymlinkRefused(`${rel} climbs out of ${root}`);
    }
    at = `${at}/${part}`;
    const st = await lstatOrNull(at);
    if (st === null) return;
    if (st.isSymlink) {
      throw new SymlinkRefused(
        `${at} is a symlink. Nothing under this directory should be one, and following it would write outside it; remove it and re-run.`,
      );
    }
  }
}

/** `mkdir -p root/rel`, refusing to pass through a symlink. */
export async function ensureDirSafe(root: string, rel: string): Promise<void> {
  await assertNoSymlinks(root, rel);
  await Deno.mkdir(`${root}/${rel}`, { recursive: true });
}

/**
 * Write `root/rel` without following a symlink anywhere on the way.
 *
 * The parent directories are checked, then the content goes to a fresh temp
 * name opened with O_EXCL — which fails on anything already there, a planted
 * symlink included — and is renamed into place. rename replaces a symlink at
 * the destination rather than writing through it.
 */
export async function writeFileSafe(
  root: string,
  rel: string,
  data: string | Uint8Array,
  mode: number,
): Promise<void> {
  const slash = rel.lastIndexOf("/");
  const dir = slash === -1 ? "" : rel.slice(0, slash);
  await ensureDirSafe(root, dir);
  const abs = `${root}/${rel}`;
  const tmp = `${abs}.writing-${crypto.randomUUID()}`;
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  await Deno.writeFile(tmp, bytes, { createNew: true, mode });
  try {
    await Deno.chmod(tmp, mode);
    await Deno.rename(tmp, abs);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/** True when `path` is a symlink. Missing is not a symlink. */
export async function isSymlink(path: string): Promise<boolean> {
  return (await lstatOrNull(path))?.isSymlink ?? false;
}

/**
 * A fresh temp directory under `<workdirRoot>/.runtime/.tmp`, private to the
 * operator.
 *
 * Not the system temp directory. Every bot's sandbox can write /tmp — nono's
 * default profile grants it — and although a bot cannot list it, it can watch
 * it for new entries and learn a "random" name the moment it appears. A
 * host-side step that put anything there a later command reads (a cwd python
 * imports from, a HOME an integration's setup reads, a config directory uv
 * reads) was reachable from every other bot on the host. No sandbox is granted
 * anything under .runtime: crossCheck refuses a filesystemAllow that covers it.
 */
export async function privateTempDir(
  workdirRoot: string,
  prefix: string,
): Promise<string> {
  await assertNoSymlinks(workdirRoot, ".runtime/.tmp");
  const base = `${workdirRoot}/.runtime/.tmp`;
  await Deno.mkdir(base, { recursive: true, mode: 0o700 });
  await Deno.chmod(base, 0o700);
  return await Deno.makeTempDir({ dir: base, prefix });
}

/**
 * `root/rel` as text, or null when it does not exist. Refuses a symlink on the
 * way and anything that is not a regular file: a FIFO the bot left would hang
 * the read, and a device would never end.
 */
export async function readRegularFile(
  root: string,
  rel: string,
): Promise<string | null> {
  await assertNoSymlinks(root, rel);
  const st = await lstatOrNull(`${root}/${rel}`);
  if (st === null) return null;
  if (!st.isFile) {
    throw new SymlinkRefused(
      `${root}/${rel} is not a regular file; remove it and re-run.`,
    );
  }
  return await Deno.readTextFile(`${root}/${rel}`);
}
