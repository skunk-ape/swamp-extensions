// What restic cannot read on its own: consistent copies of live SQLite
// databases, and the output of commands that describe the machine.
//
// restic reads a database and its -wal at different moments, so a database
// being written during the backup can restore torn. Each one is copied with
// SQLite's online backup, which reads one consistent transaction while
// writers carry on, into a staging directory that is backed up in its place;
// the originals and their sidecars are excluded. Captures are command output
// saved as files, such as the list of installed packages, for a machine that
// is rebuilt rather than restored file by file.

export function expandHome(
  p: string,
  home = Deno.env.get("HOME") ?? "",
): string {
  if (p === "~") return home;
  return p.startsWith("~/") ? home + p.slice(1) : p;
}

const META = /[*?[]/;

/** One path segment's glob (`*`, `?`, `[...]`) as an anchored regexp. */
export function segmentRegExp(seg: string, matchDot = false): RegExp {
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = seg.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        re += "[" + seg.slice(i + 1, end).replace(/^!/, "^") + "]";
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  // A leading wildcard does not match dotfiles, as in the shell (restic's
  // excludes do match them: matchDot).
  return new RegExp(
    matchDot || seg.startsWith(".") ? `^${re}$` : `^(?!\\.)${re}$`,
  );
}

async function entries(dir: string): Promise<Deno.DirEntry[]> {
  try {
    return await Array.fromAsync(Deno.readDir(dir || "/"));
  } catch {
    return [];
  }
}

/**
 * Files matching an absolute glob, sorted. Expands one segment at a time, so
 * `*` reads only the directories it must; `**` matches any depth and walks
 * the whole subtree. Symlinks are not followed.
 */
export async function expandGlob(pattern: string): Promise<string[]> {
  if (!pattern.startsWith("/")) {
    throw new Error(`glob must be absolute (or start with ~/): ${pattern}`);
  }
  const segs = pattern.split("/").filter(Boolean);
  const out = new Set<string>();

  const walk = async (dir: string, i: number): Promise<void> => {
    if (i === segs.length) {
      try {
        if ((await Deno.lstat(dir)).isFile) out.add(dir);
      } catch { /* vanished */ }
      return;
    }
    const seg = segs[i];
    if (seg === "**") {
      await walk(dir, i + 1);
      for (const e of await entries(dir)) {
        if (e.isDirectory) await walk(`${dir}/${e.name}`, i);
      }
      return;
    }
    if (!META.test(seg)) return walk(`${dir}/${seg}`, i + 1);
    const re = segmentRegExp(seg);
    const last = i === segs.length - 1;
    for (const e of await entries(dir)) {
      if (!re.test(e.name)) continue;
      if (last ? e.isFile : e.isDirectory) {
        await walk(`${dir}/${e.name}`, i + 1);
      }
    }
  };
  await walk("", 0);
  return [...out].sort();
}

const SQLITE_MAGIC = "SQLite format 3\0";

export async function isSqlite(path: string): Promise<boolean> {
  let f: Deno.FsFile | undefined;
  try {
    f = await Deno.open(path);
    const buf = new Uint8Array(16);
    const n = await f.read(buf);
    return n === 16 && new TextDecoder().decode(buf) === SQLITE_MAGIC;
  } catch {
    return false;
  } finally {
    f?.close();
  }
}

/**
 * Whether restic would exclude `path` under these patterns, closely enough to
 * skip staging what the backup leaves out anyway: an absolute pattern
 * matches the path or one of its parents segment by segment (`**` spans
 * segments); a pattern without a slash matches any one segment.
 */
export function isExcluded(path: string, patterns: string[]): boolean {
  const segs = path.split("/").filter(Boolean);
  const matchFrom = (pat: string[], pi: number, si: number): boolean => {
    if (pi === pat.length) return true; // the pattern matched a parent: excluded
    if (si === segs.length) return pat.slice(pi).every((p) => p === "**");
    if (pat[pi] === "**") {
      return matchFrom(pat, pi + 1, si) || matchFrom(pat, pi, si + 1);
    }
    return segmentRegExp(pat[pi], true).test(segs[si]) &&
      matchFrom(pat, pi + 1, si + 1);
  };
  return patterns.some((p) => {
    if (p.startsWith("/")) return matchFrom(p.split("/").filter(Boolean), 0, 0);
    if (p.startsWith("**/")) {
      const rest = p.slice(3).split("/").filter(Boolean);
      return segs.some((_, i) => matchFrom(rest, 0, i));
    }
    if (p.includes("/")) return false; // relative multi-segment: not modelled
    const re = segmentRegExp(p, true);
    return segs.some((s) => re.test(s));
  });
}

/** restic exclude patterns for a database and its sidecars, if expressible. */
export function excludesFor(db: string): string[] | null {
  // restic patterns treat these as wildcards; such a path is backed up both
  // ways rather than mis-excluded.
  if (/[*?[\]\\]/.test(db)) return null;
  return [db, `${db}-wal`, `${db}-shm`, `${db}-journal`];
}

const MARKER = ".restic-backup-staging";

/**
 * Empty the staging directory, creating it if needed. Refuses a directory
 * that has contents but no marker: it was not made by this, and emptying it
 * would delete someone's files.
 */
export async function resetStaging(dir: string): Promise<void> {
  if (!dir.startsWith("/") || dir.split("/").filter(Boolean).length < 2) {
    throw new Error(
      `stagingDir must be an absolute path at least two levels deep: ${dir}`,
    );
  }
  const existing = await entries(dir);
  if (existing.length && !existing.some((e) => e.name === MARKER)) {
    throw new Error(
      `stagingDir ${dir} is not empty and was not created by restic-backup; refusing to clear it.`,
    );
  }
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    `${dir}/${MARKER}`,
    "Emptied before every backup.\n",
  );
}

export async function clearStaging(dir: string): Promise<void> {
  const existing = await entries(dir);
  if (existing.some((e) => e.name === MARKER)) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

export interface StagedDb {
  source: string;
  staged: string;
  bytes: number;
}

export interface StageResult {
  copies: StagedDb[];
  failed: { source: string; error: string }[];
  /** restic exclude patterns for the originals that were copied. */
  excludes: string[];
}

/** Copy one live database with SQLite's online backup API. */
export async function backupDb(
  src: string,
  dst: string,
  timeoutMs = 30000,
): Promise<void> {
  if (dst.includes("'")) {
    throw new Error(`staging path contains a quote: ${dst}`);
  }
  const { code, stderr } = await new Deno.Command("sqlite3", {
    args: [src, `.timeout ${timeoutMs}`, `.backup '${dst}'`],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      new TextDecoder().decode(stderr).trim() || `sqlite3 exited ${code}`,
    );
  }
}

/**
 * Copy every SQLite database the globs match into `<dir>/sqlite/<path>`,
 * skipping any the backup's `excludes` leave out anyway.
 */
export async function stageSqlite(
  globs: string[],
  dir: string,
  excludes: string[] = [],
): Promise<StageResult> {
  const res: StageResult = { copies: [], failed: [], excludes: [] };
  const seen = new Set<string>();
  for (const g of globs) {
    for (const src of await expandGlob(expandHome(g))) {
      if (seen.has(src) || src.startsWith(dir + "/")) continue;
      seen.add(src);
      if (isExcluded(src, excludes)) continue;
      if (!(await isSqlite(src))) continue;
      const staged = `${dir}/sqlite${src}`;
      try {
        await Deno.mkdir(staged.slice(0, staged.lastIndexOf("/")), {
          recursive: true,
        });
        await backupDb(src, staged);
        res.copies.push({
          source: src,
          staged,
          bytes: (await Deno.stat(staged)).size,
        });
        res.excludes.push(...(excludesFor(src) ?? []));
      } catch (e) {
        res.failed.push({ source: src, error: (e as Error).message });
      }
    }
  }
  return res;
}

export interface Capture {
  name: string;
  command: string[];
}

export interface CaptureResult {
  name: string;
  file: string;
  ok: boolean;
  bytes: number;
  error?: string;
}

/** Run each capture and save its stdout as `<dir>/captures/<name>.txt`. */
export async function runCaptures(
  captures: Capture[],
  dir: string,
): Promise<CaptureResult[]> {
  const out: CaptureResult[] = [];
  if (!captures.length) return out;
  await Deno.mkdir(`${dir}/captures`, { recursive: true });
  for (const c of captures) {
    if (!/^[A-Za-z0-9._-]+$/.test(c.name)) {
      throw new Error(`capture name must be a plain file name: ${c.name}`);
    }
    const file = `${dir}/captures/${c.name}.txt`;
    try {
      const [cmd, ...args] = c.command;
      const r = await new Deno.Command(cmd, {
        args,
        stdout: "piped",
        stderr: "piped",
      }).output();
      await Deno.writeFile(file, r.stdout);
      out.push({
        name: c.name,
        file,
        ok: r.code === 0,
        bytes: r.stdout.length,
        ...(r.code === 0 ? {} : {
          error: new TextDecoder().decode(r.stderr).trim().slice(0, 500) ||
            `exit ${r.code}`,
        }),
      });
    } catch (e) {
      out.push({
        name: c.name,
        file,
        ok: false,
        bytes: 0,
        error: (e as Error).message,
      });
    }
  }
  return out;
}
