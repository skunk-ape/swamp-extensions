import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { BotSchema } from "./decl.ts";
import type { Bot } from "./decl.ts";
import {
  configYaml,
  decideFile,
  directories,
  indexHook,
  providerExtras,
  refSteps,
  requiredImports,
  resolvedWorkdir,
  soulMd,
  uvEnv,
  uvSteps,
  workdirFiles,
} from "./provision.ts";

function bot(over: Record<string, unknown> = {}): Bot {
  return BotSchema.parse({
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
  });
}

const WD = "/Users/x/agents/demo";

Deno.test("workdir resolves $HOME", () => {
  assertEquals(resolvedWorkdir(bot(), "/Users/x"), WD);
});

Deno.test("the tree covers what launchd and Hermes will not create", () => {
  const d = directories(bot());
  // launchd writes a job's stdio here and refuses to create the directory.
  assert(d.includes("logs"));
  // nono refuses a state root it was not told about, so the XDG tree has to
  // exist before the first run rather than after it.
  assert(d.includes("hermes/xdg/state"));
  assert(d.includes("workspace/inbox"));
  assert(d.includes("workspace/outbox"));
  assert(d.includes("hermes/python"));
});

Deno.test("uv is pointed inside the workdir, interpreter included", () => {
  const env = uvEnv(WD);
  // The one that bites: without it the venv points at the shared interpreter
  // under ~/.local/share/uv/ and the gateway cannot exec its own python.
  assertEquals(env.UV_PYTHON_INSTALL_DIR, `${WD}/hermes/python`);
  assertEquals(env.UV_CACHE_DIR, `${WD}/hermes/cache/uv`);
  assertEquals(env.NPM_CONFIG_CACHE, `${WD}/hermes/cache/npm`);
  // uv drops a python3.x symlink into ~/.local/bin unless told otherwise —
  // outside the workdir, on the host's PATH, and shared by every bot.
  assertEquals(env.UV_PYTHON_BIN_DIR, `${WD}/hermes/python/bin`);
  for (const v of Object.values(env)) assert(v.startsWith(WD));
});

Deno.test("installing the interpreter puts nothing on the host's PATH", () => {
  const s = uvSteps(`${WD}/hermes/hermes-agent`, "3.11");
  assert(s.install.includes("--no-bin"));
});

Deno.test("the dependency sync is locked, never re-resolved", () => {
  const s = uvSteps(`${WD}/hermes/hermes-agent`, "3.11");
  assert(s.sync.includes("--locked"));
  assert(s.sync.includes("--extra"));
  assertEquals(s.install, ["python", "install", "--no-bin", "3.11"]);
  assert(s.venv.includes("--python"));
});

Deno.test("the chat platform comes from the lock, not a first-run pip install", () => {
  // Upstream lazy-installs Telegram from PyPI at gateway start. A bot with a
  // named egress allowlist cannot reach PyPI, so without this the gateway runs
  // with no platform at all.
  const s = uvSteps(`${WD}/hermes/hermes-agent`, "3.11");
  const extras = s.sync.flatMap((a, i) =>
    s.sync[i - 1] === "--extra" ? [a] : []
  );
  assertEquals(extras, ["all", "messaging"]);
  // The config provision writes enables Telegram, so the probe must prove the
  // venv can load it, or a venv missing it reports complete.
  assert(configYaml(bot(), WD).includes("telegram:"));
  assert(requiredImports(bot()).includes("telegram"));
  assert(requiredImports(bot()).includes("hermes_cli"));
});

// Stuart, provider anthropic behind a four-host allowlist, connected to
// Telegram and then failed every turn: upstream lazy-installs the provider SDK
// from PyPI, which the allowlist cannot reach.
Deno.test("each declared provider's SDK comes from the lock and must import", () => {
  const b = bot({
    runtime: {
      provider: "anthropic",
      model: "claude-opus-5",
      fallback: [
        { provider: "openai-codex", model: "gpt-5.6-sol" },
        { provider: "anthropic", model: "claude-sonnet-5" },
      ],
    },
  });
  // Deduplicated, and a provider on core dependencies adds nothing.
  assertEquals(providerExtras(b), ["anthropic"]);
  assert(requiredImports(b).includes("anthropic"));
  const s = uvSteps(`${WD}/hermes/hermes-agent`, "3.11", providerExtras(b));
  const extras = s.sync.flatMap((a, i) =>
    s.sync[i - 1] === "--extra" ? [a] : []
  );
  assertEquals(extras, ["all", "messaging", "anthropic"]);
  assertEquals(s.sync.at(-1), "--locked");
  // A fallback counts: it is only useful if it can be constructed.
  const viaFallback = bot({
    runtime: {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      fallback: [{ provider: "bedrock", model: "x" }],
    },
  });
  assertEquals(providerExtras(viaFallback), ["bedrock"]);
  assert(requiredImports(viaFallback).includes("boto3"));
});

// A ref edit in the declaration used to reach no existing workdir: provision
// saw a checkout, called it present, and --check reported complete.
Deno.test("moving a checkout fetches exactly the declared tag, shallow", () => {
  const s = refSteps("fleet-2026-09-25");
  assertEquals(s.fetch, [
    "fetch",
    "--depth",
    "1",
    "--no-tags",
    "origin",
    "tag",
    "fleet-2026-09-25",
  ]);
  // Detached at the tag, never a branch tip that could move under the fleet.
  assertEquals(s.checkout, [
    "checkout",
    "--quiet",
    "--detach",
    "refs/tags/fleet-2026-09-25",
  ]);
});

Deno.test("config.yaml reaches MCPs over loopback and never spawns them", () => {
  const y = configYaml(
    bot({
      sandbox: { openPorts: [8813] },
      mcps: [{ name: "gh-gate", port: 8813 }],
    }),
    WD,
  );
  assertStringIncludes(y, "url: http://127.0.0.1:8813/mcp");
  // A spawned MCP would inherit nono's confinement and lose both its
  // credential and its network, so no MCP but funes may have a command.
  // The hook is `- command:`, a list item under hooks; an MCP's is a plain
  // mapping key. Only the latter would spawn a server inside the sandbox.
  const commands = y.split("\n").filter((l) => /^ +command:/.test(l));
  assertEquals(commands.length, 1);
  assertStringIncludes(commands[0], `${WD}/tools/funes`);
});

Deno.test("config.yaml keeps every funes path inside this bot's workdir", () => {
  const y = configYaml(bot(), WD);
  assertStringIncludes(y, `FUNES_HOME: ${WD}/funes`);
  assertStringIncludes(y, `HF_HOME: ${WD}/funes/hf`);
  for (const line of y.split("\n")) {
    if (line.includes("/agents/")) assertStringIncludes(line, "/agents/demo");
  }
});

Deno.test("hfOffline is what turns the allowlist into a loud failure", () => {
  assert(!configYaml(bot(), WD).includes("HF_HUB_OFFLINE"));
  assertStringIncludes(
    configYaml(bot({ funes: { hfOffline: true } }), WD),
    "HF_HUB_OFFLINE: '1'",
  );
});

Deno.test("a gateway has no terminal, so onboarding is pre-dismissed", () => {
  const y = configYaml(bot(), WD);
  assertStringIncludes(y, "profile_build_offered: true");
  assertStringIncludes(y, "busy_input_prompt: true");
});

Deno.test("fallback providers render only when declared", () => {
  assert(!configYaml(bot(), WD).includes("fallback_providers"));
  const y = configYaml(
    bot({
      runtime: {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        fallback: [{ provider: "anthropic", model: "anthropic/claude-opus-5" }],
      },
    }),
    WD,
  );
  assertStringIncludes(y, "provider: openai-codex");
  assertStringIncludes(y, "fallback_providers:");
  assertStringIncludes(y, "  - provider: anthropic");
});

Deno.test("the index hook rewrites HOME and stages funes on PATH", () => {
  const h = indexHook(bot(), WD);
  // Hermes runs hooks with the real HOME; without this the hook indexes the
  // host's empty ~/.hermes, exits 0, and logs "ok".
  assertStringIncludes(h, `W=${WD}`);
  assertStringIncludes(h, 'export HOME="$W"');
  assertStringIncludes(h, 'export FUNES_HOME="$W/funes"');
  // find_bin falls back to $HOME/.local/bin, which is empty once HOME moved.
  assertStringIncludes(h, 'export PATH="$W/tools:$PATH"');
  assertStringIncludes(h, '"$W/.hermes/hooks/funes-index.sh"');
});

Deno.test("SOUL.md tells the agent what its boundary actually is", () => {
  const open = soulMd(bot(), WD);
  assertStringIncludes(open, "any host");
  const closed = soulMd(
    bot({
      sandbox: {
        egress: ["api.anthropic.com", "api.telegram.org"],
        filesystemAllow: ["/Users/x/src/vault"],
      },
    }),
    WD,
  );
  assertStringIncludes(closed, "api.telegram.org");
  assertStringIncludes(closed, "/Users/x/src/vault");
  assertStringIncludes(closed, "workspace/outbox");
});

Deno.test("state is never clobbered; derived files always are", () => {
  const files = workdirFiles(bot(), WD);
  const byPath = new Map(files.map((f) => [f.path, f]));
  // Hermes writes to config.yaml at runtime (onboarding.seen), and SOUL.md is
  // the bot's character. Rewriting either on a re-run would undo a person.
  assertEquals(byPath.get("hermes/config.yaml")!.clobber, false);
  assertEquals(byPath.get("hermes/SOUL.md")!.clobber, false);
  // The hook is derived, so a fix to the template has to reach every bot.
  assertEquals(byPath.get("tools/funes-index-hook.sh")!.clobber, true);
  assertEquals(byPath.get("tools/funes-index-hook.sh")!.mode, 0o755);
});

Deno.test("provision keeps what it found and owns what it produced", () => {
  const [hook, config] = [
    workdirFiles(bot(), WD).find((f) => f.clobber)!,
    workdirFiles(bot(), WD).find((f) => !f.clobber)!,
  ];

  // Nothing there: write it.
  assertEquals(decideFile(config, null, false), "created");

  // A config.yaml that was already on disk before this run is state Hermes or
  // a person owns, whatever it says.
  assertEquals(
    decideFile(config, "model:\n  provider: openai\n", true),
    "kept",
  );

  // A config.yaml that appeared DURING this run is boilerplate one of our own
  // steps caused — `funes add hermes` writes one — so the declaration wins.
  assertEquals(
    decideFile(config, "mcp_servers:\n  funes:\n", false),
    "replaced",
  );

  // Derived files track the template in both cases.
  assertEquals(decideFile(hook, "#!/bin/sh\nold\n", true), "updated");
  assertEquals(decideFile(hook, hook.content, true), "kept");
});
