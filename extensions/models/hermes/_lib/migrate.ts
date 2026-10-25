// Moving a bot to another machine without losing what it knows.
//
// A workdir is 2-4 GB and almost none of it should travel. The interpreter, the
// venv, the staged funes binary, the uv and npm caches are all *architecture
// specific*: copied to a Linux box they are Mach-O files that fail at exec, and
// the failure arrives late, in a log, as something that looks unrelated. They
// are also all rebuildable — `provision` exists to rebuild exactly them — so
// the right answer is to leave every one of them behind.
//
// What is left is perhaps 30 MB per bot and is irreplaceable: the session
// database, the Funes memory, the cron jobs, the skills, SOUL.md, and the
// config.yaml the agent has been editing since the day it was provisioned.
//
// The part that is easy to get wrong is not the copying. It is that several of
// those files contain the *old* absolute workdir, and two of them are
// load-bearing: config.yaml points the funes MCP and the post-turn index hook
// at `/Users/x/agents/<slug>/...`. Restore those verbatim onto a Linux box
// and the gateway starts, connects to Telegram, answers messages, reports
// healthy — and has no memory tool at all, because the MCP it was told to spawn
// is a path that does not exist. Nothing in the health model catches this: the
// funes MCP is stdio, so there is no port to probe and no session to count.
//
// So `restore` rewrites the prefix, and reports both what it rewrote and what
// it found and did not.

import type { Bot } from "./decl.ts";

/** One thing the snapshot carries, and why it is worth carrying. */
export type Carried = { path: string; why: string };

/**
 * Everything that travels, workdir-relative.
 *
 * Directories are taken whole. The list is explicit rather than a walk with an
 * exclude list, and that direction is deliberate: a new file appearing in the
 * workdir should default to being left behind, not to being shipped to another
 * machine. The cost of missing something is a re-copy; the cost of shipping an
 * arch-specific binary is a confusing failure days later.
 */
export function carriedPaths(
  b: Bot,
  opts: { includeHfCache: boolean },
): Carried[] {
  const out: Carried[] = [
    // -- the agent's own state --------------------------------------------
    { path: "hermes/state.db", why: "sessions, messages, the agent's history" },
    { path: "hermes/state.db-wal", why: "uncheckpointed tail of state.db" },
    { path: "hermes/sessions", why: "conversation threads" },
    { path: "hermes/memories", why: "MEMORY.md and USER.md" },
    { path: "hermes/cron", why: "scheduled jobs" },
    { path: "hermes/skills", why: "installed skills" },
    { path: "hermes/skins", why: "display skin" },
    { path: "hermes/platforms", why: "per-platform adapter state" },
    { path: "hermes/price-watches", why: "standing watches" },
    { path: "hermes/kanban.db", why: "the agent's board" },
    { path: "hermes/kanban.db-wal", why: "uncheckpointed tail of kanban.db" },

    // -- files a person or the runtime owns --------------------------------
    { path: "hermes/SOUL.md", why: "the bot's character" },
    {
      path: "hermes/config.yaml",
      why:
        "the live configuration, which has diverged from the provisioned starter",
    },
    {
      path: "hermes/auth.json",
      why: "provider auth the agent obtained itself",
    },
    { path: "hermes/channel_directory.json", why: "known chats" },
    {
      path: "hermes/gateway_state.json",
      why: "home channel and gateway state",
    },
    { path: "hermes/install_id", why: "stable identity for this installation" },
    {
      path: "hermes/shell-hooks-allowlist.json",
      why: "commands the human has approved",
    },
    { path: "hermes/spawn-ledger.json", why: "subagent accounting" },

    // -- the memory ---------------------------------------------------------
    // A Lance dataset, which is architecture-independent, so it copies as-is.
    { path: "funes/memory", why: "the Funes memory — the whole point" },
    { path: "funes/state.json", why: "Funes bookkeeping" },
    {
      path: "funes/index-coverage.json",
      why: "what Funes has already indexed",
    },

    // -- the file handoff ---------------------------------------------------
    { path: "workspace", why: "inbox and outbox" },
  ];

  // The embedding cache: 1.2 GB, architecture-independent, and re-obtainable —
  // by download for a bot with open egress, and by `provision --input
  // seedHfFrom=<sibling>` for one without. Shipping it by default would make
  // every snapshot forty times larger to save a step that already exists.
  if (opts.includeHfCache) {
    out.push({ path: "funes/hf", why: "embedding cache (includeHfCache)" });
  }

  for (const p of b.state.extraPaths) {
    out.push({ path: p, why: "declared in state.extraPaths" });
  }
  return out;
}

/**
 * Paths `provision` rebuilds, recorded so the snapshot report can say what it
 * deliberately left behind.
 *
 * This is documentation with a test on it. "Why is my snapshot 30 MB when the
 * workdir is 4 GB" is the first question anyone asks, and the answer should be
 * in the run's own output rather than in a comment in this file.
 */
export function rebuiltPaths(): Carried[] {
  return [
    // The first three are code from the layout before the runtime moved out
    // of the workdir. A current workdir does not have them; an old one may.
    {
      path: "hermes/hermes-agent",
      why: "old layout: the checkout now lives in the runtime",
    },
    {
      path: "hermes/python",
      why: "old layout: the interpreter now lives in the runtime",
    },
    { path: "hermes/bin", why: "arch-specific binaries (uv, uvx, tirith)" },
    { path: "hermes/cache", why: "uv and npm caches" },
    { path: "hermes/xdg", why: "XDG cache tree, rebuilt on first run" },
    { path: "hermes/hooks", why: "regenerated by `funes add hermes`" },
    { path: "tools", why: "old layout: staged tools now live in the runtime" },
    { path: "logs", why: "this host's logs belong to this host" },
    { path: ".hermes", why: "a symlink provision recreates" },
  ];
}

/**
 * Patterns excluded even inside a carried directory.
 *
 * Locks and sockets belonging to a process on another machine, and `-shm`,
 * which is pure shared memory SQLite rebuilds. `-wal` is NOT here: it is
 * carried, because a checkpoint that failed silently would otherwise cost the
 * most recent conversations.
 */
export const EXCLUDES = ["*.lock", "*.sock", "*.pid", "*-shm"];

/** Databases worth checkpointing before they are copied. */
export function checkpointables(): string[] {
  return ["hermes/state.db", "hermes/kanban.db"];
}

/**
 * Files whose contents may be rewritten on restore.
 *
 * Narrow on purpose. Rewriting a path inside `state.db` or a session transcript
 * would mean editing history to say something that never happened, and the
 * paths in there are descriptive — where a command once ran — not operative.
 * The files below are the ones something *reads to decide what to do*, and they
 * are the only ones where a stale path changes behaviour.
 */
export function rewritable(relPath: string): boolean {
  const exact = new Set([
    // The two that matter: the funes MCP command and the post_llm_call hook.
    "hermes/config.yaml",
    "hermes/gateway_state.json",
    "hermes/shell-hooks-allowlist.json",
    "hermes/spawn-ledger.json",
    "hermes/channel_directory.json",
    "hermes/SOUL.md",
  ]);
  if (exact.has(relPath)) return true;
  return /^hermes\/memories\/.*\.md$/.test(relPath);
}

/** Replace every mention of the old workdir with the new one. */
export function rewritePrefix(
  content: string,
  fromWorkdir: string,
  toWorkdir: string,
): { content: string; count: number } {
  if (fromWorkdir === toWorkdir) return { content, count: 0 };
  const count = content.split(fromWorkdir).length - 1;
  return { content: content.replaceAll(fromWorkdir, toWorkdir), count };
}

/**
 * Mentions of the old host that survived the rewrite.
 *
 * The rewrite only knows about `<oldHome>/agents/<slug>`. A config that also
 * references `/Users/x/src/something` is not something this can fix — it is
 * a path on a machine that no longer exists — but it is absolutely something
 * the operator has to be told about, and a silent restore would not.
 */
export function residualMentions(
  content: string,
  fromHome: string,
  limit = 5,
): string[] {
  if (fromHome === "") return [];
  return content.split("\n")
    .map((l, i) => ({ l: l.trim(), i: i + 1 }))
    .filter(({ l }) => l.includes(fromHome))
    .slice(0, limit)
    .map(({ l, i }) => `line ${i}: ${l.slice(0, 160)}`);
}
