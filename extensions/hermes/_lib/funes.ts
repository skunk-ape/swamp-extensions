// Host-side handling of a fetched funes integration, and the PATH sandboxed
// funes steps run with.
//
// The fetch itself runs inside nono (provision.ts, sandboxedFetch). What comes
// out of it is checked here before anything is put in the runtime, where every
// later install reads it: each file against the sha256 funes recorded for it,
// nothing but regular files and directories, and the swap into place done so a
// failure leaves the previous copy rather than none.

// deno-lint-ignore no-explicit-any
declare const Deno: any;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Every entry under `root`, relative, without following symlinks. */
async function walk(
  root: string,
  prefix = "",
): Promise<Array<{ rel: string; kind: "file" | "dir" | "other" }>> {
  const out: Array<{ rel: string; kind: "file" | "dir" | "other" }> = [];
  for await (const e of Deno.readDir(prefix ? `${root}/${prefix}` : root)) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isSymlink) out.push({ rel, kind: "other" });
    else if (e.isDirectory) {
      out.push({ rel, kind: "dir" });
      out.push(...await walk(root, rel));
    } else if (e.isFile) out.push({ rel, kind: "file" });
    else out.push({ rel, kind: "other" });
  }
  return out;
}

/**
 * Problems with a fetched integration at `dir`, given the record funes wrote
 * beside it (`<id>.json`, with a `files` map of relative path → sha256).
 * Empty when every file is a regular file, listed, and matches.
 */
export async function verifyIntegration(
  dir: string,
  record: string,
): Promise<string[]> {
  let files: Record<string, string>;
  try {
    const parsed = JSON.parse(record);
    files = parsed?.files;
    if (
      typeof files !== "object" || files === null || Array.isArray(files) ||
      Object.keys(files).length === 0
    ) {
      return ["the record has no files map"];
    }
  } catch {
    return ["the record is not JSON"];
  }
  // The root itself must be a real directory: a symlink here would be
  // followed by the walk below and copied as a link into the runtime.
  const root = await Deno.lstat(dir).catch(() => null);
  if (root === null || root.isSymlink || !root.isDirectory) {
    return [`${dir} is not a directory`];
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of await walk(dir)) {
    if (e.kind === "dir") continue;
    if (e.kind === "other") {
      problems.push(`${e.rel} is not a regular file`);
      continue;
    }
    seen.add(e.rel);
    const want = files[e.rel];
    if (want === undefined) {
      problems.push(`${e.rel} is not in the record`);
      continue;
    }
    const got = await sha256Hex(await Deno.readFile(`${dir}/${e.rel}`));
    if (got !== want) problems.push(`${e.rel} does not match its sha256`);
  }
  for (const rel of Object.keys(files)) {
    if (!seen.has(rel)) problems.push(`${rel} is in the record but missing`);
  }
  return problems;
}

/**
 * Put a verified integration at `dest`, replacing what is there only once the
 * new copy is complete: copied to a sibling temp name, then renamed into
 * place. A copy that fails leaves the previous integration as it was.
 */
export async function installIntegration(
  src: string,
  dest: string,
  run: (
    bin: string,
    args: string[],
  ) => Promise<{ code: number; stderr: string }>,
): Promise<void> {
  const staging = `${dest}.new-${crypto.randomUUID()}`;
  // -P: never follow a symlink (verifyIntegration refuses them already).
  const c = await run("cp", ["-RP", src, staging]);
  if (c.code !== 0) {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    throw new Error(`copying the funes integration failed: ${c.stderr.trim()}`);
  }
  const old = `${dest}.old-${crypto.randomUUID()}`;
  const hadOld = await Deno.lstat(dest).then(() => true, () => false);
  if (hadOld) await Deno.rename(dest, old);
  await Deno.rename(staging, dest);
  if (hadOld) await Deno.remove(old, { recursive: true }).catch(() => {});
}

/**
 * The PATH sandboxed funes steps run with: the operator's, minus any directory
 * holding a `hermes`.
 *
 * Not a fixed `/usr/bin:/bin`: funes shells out to tar, and setup to cp, awk
 * and dirname, which on NixOS live nowhere near /usr/bin. But never a hermes:
 * funes's setup runs `hermes mcp add` when it finds one, registering funes
 * with none of the bot's environment over the entry config.yaml already has.
 */
export async function toolPath(operatorPath: string): Promise<string> {
  const keep: string[] = [];
  for (const dir of operatorPath.split(":")) {
    // Relative entries would resolve against wherever the command runs —
    // inside a bot sandbox, the bot's own workdir.
    if (!dir.startsWith("/") || keep.includes(dir)) continue;
    const hasHermes = await Deno.stat(`${dir}/hermes`).then(
      () => true,
      () => false,
    );
    if (!hasHermes) keep.push(dir);
  }
  return keep.join(":");
}
