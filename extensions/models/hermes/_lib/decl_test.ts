import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  BotSchema,
  crossCheck,
  gatewayLabel,
  homeEnvVar,
  workdirOf,
} from "./decl.ts";

/** The smallest declaration that validates. */
function minimal(over: Record<string, unknown> = {}) {
  return {
    slug: "demo",
    displayName: "Demo",
    summary: "Demo: general egress, one directory.",
    vault: "demo-secrets",
    telegram: {
      allowedUsers: ["12345"],
      homeChannel: "12345",
      homeChannelName: "DM",
    },
    sandbox: {},
    ...over,
  };
}

Deno.test("minimal declaration validates and fills defaults", () => {
  const b = BotSchema.parse(minimal());
  assertEquals(b.workdirRoot, "$HOME/agents");
  assertEquals(b.sandbox.egress, ["*"]);
  assertEquals(b.sandbox.openPorts, []);
  assertEquals(b.sandbox.filesystemAllow, []);
  assertEquals(b.entrypoints, ["gateway"]);
  assertEquals(b.funes.hfOffline, false);
  assertEquals(b.secretKeys.anthropic, "anthropic-key");
  assertEquals(b.secretKeys.telegram, "telegram-bot-token");
  assertEquals(b.rationale, null);
});

Deno.test("derived names", () => {
  const b = BotSchema.parse(minimal({ slug: "gh-bot" }));
  assertEquals(workdirOf(b), "$HOME/agents/gh-bot");
  assertEquals(homeEnvVar(b), "GH_BOT_HOME");
  assertEquals(gatewayLabel(b), "sh.gh-bot.gateway");
});

// The failure this catches is a gateway that starts with no tools at all: the
// launcher waits for an MCP the profile never opened a port for, warns into a
// log nobody reads, and starts anyway.
Deno.test("an MCP without a matching open port is reported", () => {
  const problems = crossCheck(BotSchema.parse(minimal({
    mcps: [{ name: "gh-gate", port: 8813 }],
    sandbox: { openPorts: [8811] },
  })));
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "gh-gate");
  assertStringIncludes(problems[0], "starts toolless");
});

Deno.test("an MCP with its port declared is clean", () => {
  assertEquals(
    crossCheck(BotSchema.parse(minimal({
      mcps: [{ name: "gh-gate", port: 8813 }],
      sandbox: { openPorts: [8813] },
    }))),
    [],
  );
});

Deno.test("chat entrypoint requires a chat block", () => {
  const bad = crossCheck(
    BotSchema.parse(minimal({ entrypoints: ["gateway", "chat"] })),
  );
  assertEquals(bad.length, 1);
  assertStringIncludes(bad[0], "no chat block");

  assertEquals(
    crossCheck(BotSchema.parse(minimal({
      entrypoints: ["gateway", "chat"],
      chat: { workIn: "$HOME/src/notes", workInEnvVar: "DEMO_CHAT_DIR" },
    }))),
    [],
  );
});

// nono resolves a relative grant against nothing, so it silently grants
// nothing — the worst kind of failure for a filesystem boundary.
Deno.test("relative filesystem grants are reported", () => {
  const problems = crossCheck(
    BotSchema.parse(minimal({ sandbox: { filesystemAllow: ["src/lifeos"] } })),
  );
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "not absolute");
});

Deno.test("absolute and $-rooted filesystem grants are clean", () => {
  assertEquals(
    crossCheck(BotSchema.parse(minimal({
      sandbox: { filesystemAllow: ["/Users/x/src/notes-vault", "$HOME/notes"] },
    }))),
    [],
  );
});

// The schema itself must stay unrefined: swamp calls .partial() on it.
Deno.test("BotSchema supports .partial(), which swamp requires", () => {
  const partial = BotSchema.partial();
  assert(partial.safeParse({ slug: "demo" }).success);
});

Deno.test("an empty egress list is rejected", () => {
  const r = BotSchema.safeParse(minimal({ sandbox: { egress: [] } }));
  assert(!r.success);
});

Deno.test("an empty Telegram allowlist is rejected", () => {
  const r = BotSchema.safeParse(minimal({
    telegram: { allowedUsers: [], homeChannel: "1", homeChannelName: "DM" },
  }));
  assert(!r.success);
});

Deno.test("slug must be lowercase and start with a letter", () => {
  for (const slug of ["Alpha", "9lives", "has_underscore", ""]) {
    assert(!BotSchema.safeParse(minimal({ slug })).success, `accepted ${slug}`);
  }
  for (const slug of ["alpha", "gh-bot", "a"]) {
    assert(BotSchema.safeParse(minimal({ slug })).success, `rejected ${slug}`);
  }
});

// ---------------------------------------------------------------------------
// Which Hermes a bot runs
// ---------------------------------------------------------------------------

Deno.test("a bot records its own Hermes, and defaults to upstream main", () => {
  // The default has to stay generic: this model type is published, and a
  // personal fork is not a sensible default for anyone else.
  const d = BotSchema.parse(minimal());
  assertEquals(
    d.agent.repo,
    "https://github.com/NousResearch/hermes-agent.git",
  );
  assertEquals(d.agent.ref, "main");
});

Deno.test("a bot can pin a fork and a tag", () => {
  const d = BotSchema.parse({
    ...minimal(),
    agent: {
      repo: "https://github.com/example/hermes-agent.git",
      ref: "fleet-2026-09-23",
    },
  });
  assertEquals(d.agent.ref, "fleet-2026-09-23");
});

Deno.test("agent is not named hermesRepo/hermesRef, and that is deliberate", () => {
  // swamp merges globalArguments into a method's arguments and the GLOBAL
  // value wins, so a declaration field sharing a name with provision's
  // argument would make that argument impossible to override. Same trap that
  // forced RestartArgs to say `only` rather than `mcps`.
  const shape = Object.keys(BotSchema.shape);
  assert(shape.includes("agent"));
  assert(
    !shape.includes("hermesRepo"),
    "would collide with provision's argument",
  );
  assert(
    !shape.includes("hermesRef"),
    "would collide with provision's argument",
  );
});

Deno.test("a narrow allowlist and loopback MCPs cannot both be honoured", () => {
  // nono serves a named allowlist through its proxy, and on Linux that proxy
  // denies direct loopback connect even to a declared port. Rendering this
  // combination would promise MCPs that the gateway then parks, reporting
  // Permission denied against servers that are plainly running.
  const problems = crossCheck(BotSchema.parse({
    ...minimal(),
    sandbox: { egress: ["api.anthropic.com"], openPorts: [8813] },
    mcps: [{ name: "gh-gate", port: 8813 }],
  }));
  assert(
    problems.some((p) => p.includes("named egress allowlist")),
    "should reject allowlist + open ports",
  );
});

Deno.test("unrestricted egress with loopback MCPs is fine", () => {
  const problems = crossCheck(BotSchema.parse({
    ...minimal(),
    sandbox: { egress: ["*"], openPorts: [8813] },
    mcps: [{ name: "gh-gate", port: 8813 }],
  }));
  assertEquals(problems, []);
});
