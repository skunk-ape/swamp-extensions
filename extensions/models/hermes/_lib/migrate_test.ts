import { assert, assertEquals } from "jsr:@std/assert@1";
import { BotSchema } from "./decl.ts";
import type { Bot } from "./decl.ts";
import {
  carriedPaths,
  EXCLUDES,
  rebuiltPaths,
  residualMentions,
  rewritable,
  rewritePrefix,
} from "./migrate.ts";

function bot(over: Record<string, unknown> = {}): Bot {
  return BotSchema.parse({
    slug: "demo",
    displayName: "Demo",
    summary: "Demo.",
    vault: "demo-secrets",
    telegram: {
      allowedUsers: ["1"],
      homeChannel: "1",
      homeChannelName: "DM",
    },
    sandbox: { egress: ["*"], openPorts: [], filesystemAllow: [] },
    ...over,
  });
}

// ---------------------------------------------------------------------------
// What travels
// ---------------------------------------------------------------------------

Deno.test("the memory and the live config travel", () => {
  const paths = carriedPaths(bot(), { includeHfCache: false }).map((c) => c.path);
  for (
    const p of [
      "hermes/state.db",
      "hermes/sessions",
      "hermes/memories",
      "hermes/cron",
      "hermes/SOUL.md",
      "hermes/config.yaml",
      "funes/memory",
      "workspace",
    ]
  ) {
    assert(paths.includes(p), `missing ${p}`);
  }
});

Deno.test("nothing architecture-specific travels", () => {
  // The whole failure this manifest exists to prevent: a Mach-O interpreter or
  // funes binary arriving on a Linux box, where it fails at exec far from here.
  const paths = carriedPaths(bot(), { includeHfCache: true }).map((c) => c.path);
  for (
    const p of [
      "hermes/python",
      "hermes/hermes-agent",
      "hermes/bin",
      "hermes/cache",
      "tools",
      "logs",
    ]
  ) {
    assert(!paths.includes(p), `${p} must not be carried`);
  }
  // And each one is named in the report, so the size difference is explained
  // where someone will actually read it.
  const rebuilt = rebuiltPaths().map((r) => r.path);
  for (const p of ["hermes/python", "hermes/bin", "tools"]) {
    assert(rebuilt.includes(p), `${p} should be listed as rebuilt`);
  }
});

Deno.test("the WAL travels but the shared-memory index does not", () => {
  // A checkpoint that failed silently must not cost the last conversations, so
  // -wal is carried; -shm is pure shared memory and SQLite rebuilds it.
  const paths = carriedPaths(bot(), { includeHfCache: false }).map((c) => c.path);
  assert(paths.includes("hermes/state.db-wal"));
  assert(EXCLUDES.includes("*-shm"));
  assert(!EXCLUDES.includes("*-wal"));
  // Locks and sockets belong to a process on the other machine.
  for (const e of ["*.lock", "*.sock", "*.pid"]) assert(EXCLUDES.includes(e));
});

Deno.test("the embedding cache is opt-in", () => {
  const without = carriedPaths(bot(), { includeHfCache: false }).map((c) => c.path);
  const with_ = carriedPaths(bot(), { includeHfCache: true }).map((c) => c.path);
  assert(!without.includes("funes/hf"));
  assert(with_.includes("funes/hf"));
});

Deno.test("a bot's declared extra state is carried", () => {
  // Beta's curated knowledge/ is the real case: nothing but the declaration
  // knows it exists, so a path missed here is a path that does not survive.
  const paths = carriedPaths(
    bot({ state: { extraPaths: ["knowledge", "creative"] } }),
    { includeHfCache: false },
  ).map((c) => c.path);
  assert(paths.includes("knowledge"));
  assert(paths.includes("creative"));
});

// ---------------------------------------------------------------------------
// Rewriting the old host out
// ---------------------------------------------------------------------------

Deno.test("only files that are READ TO DECIDE are rewritten", () => {
  // config.yaml drives the funes MCP command and the post_llm_call hook.
  assert(rewritable("hermes/config.yaml"));
  assert(rewritable("hermes/gateway_state.json"));
  assert(rewritable("hermes/memories/MEMORY.md"));
  // Transcripts and databases are history. Editing them would make them claim
  // a command ran somewhere it never ran, and the paths in them are
  // descriptive rather than operative.
  assert(!rewritable("hermes/state.db"));
  assert(!rewritable("hermes/sessions/abc.jsonl"));
  assert(!rewritable("funes/memory/chunks.lance/data.lance"));
});

Deno.test("every mention of the old workdir is rewritten, not just the first", () => {
  const before = `mcp_servers:
  funes:
    command: /Users/x/agents/alpha/tools/funes
    env:
      FUNES_HOME: /Users/x/agents/alpha/funes
      HF_HOME: /Users/x/agents/alpha/funes/hf
hooks:
  post_llm_call:
  - command: bash "/Users/x/agents/alpha/tools/funes-index-hook.sh" 'hermes'
`;
  const { content, count } = rewritePrefix(
    before,
    "/Users/x/agents/alpha",
    "/home/x/agents/alpha",
  );
  assertEquals(count, 4);
  assert(!content.includes("/Users/x"));
  assert(content.includes("/home/x/agents/alpha/tools/funes"));
});

Deno.test("an identical prefix rewrites nothing and says so", () => {
  const { content, count } = rewritePrefix("a /x/y b", "/x/y", "/x/y");
  assertEquals(count, 0);
  assertEquals(content, "a /x/y b");
});

Deno.test("mentions of the old host that the rewrite cannot fix are reported", () => {
  // /Users/x/src/notes-vault is not under the workdir, so the prefix rewrite
  // never touches it — and it is exactly the kind of thing that must not be
  // discovered later, from a symptom.
  const content = `allow:
  - /home/x/agents/gamma
  - /Users/x/src/notes-vault
`;
  const left = residualMentions(content, "/Users/x");
  assertEquals(left.length, 1);
  assert(left[0].includes("notes-vault"));
  assertEquals(residualMentions(content, ""), []);
});

Deno.test("residual reporting is capped so one bad file cannot bury the rest", () => {
  const content = Array.from({ length: 50 }, (_, i) => `/Users/x/x${i}`).join("\n");
  assertEquals(residualMentions(content, "/Users/x").length, 5);
});
