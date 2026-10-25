import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { BotSchema } from "./decl.ts";
import type { Bot } from "./decl.ts";
import {
  configYaml,
  GIT_HARDEN,
  importCheckArgs,
  legacyRuntimePaths,
  localRefCandidates,
  migrateConfigTools,
  decideFile,
  directories,
  indexHook,
  providerExtras,
  refSteps,
  requiredImports,
  resolvedRuntime,
  resolvedWorkdir,
  runtimeDirectories,
  runtimeFiles,
  FUNES_ADD_ANSWER,
  funesPluginEnabled,
  sandboxedFetch,
  FUNES_INTEGRATION_CONTRACT,
  integrationContract,
  sandboxedFunesAdd,
  sandboxedIntegrationSetup,
  sandboxedPluginEnable,
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
const RT = "/Users/x/agents/.runtime/demo";
const INNER = { path: "/opt/tools/bin:/usr/bin", lang: "en_US.UTF-8" };

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
  // Code is not state: it lives in the runtime, outside the workdir.
  assert(!d.includes("hermes/python"));
  assert(!d.includes("tools"));
  assertEquals(runtimeDirectories(), ["tools", "python", "cache/uv"]);
});

Deno.test("runtime resolves $HOME, beside the workdirs and outside them", () => {
  assertEquals(resolvedRuntime(bot(), "/Users/x"), RT);
  assert(!RT.startsWith(`${WD}/`));
});

Deno.test("uv is pointed inside the runtime, interpreter and cache included", () => {
  const env = uvEnv(WD, RT);
  // The one that bites: without it the venv points at the shared interpreter
  // under ~/.local/share/uv/ and the gateway cannot exec its own python.
  assertEquals(env.UV_PYTHON_INSTALL_DIR, `${RT}/python`);
  // The cache provision syncs from is the runtime's: one in the workdir is a
  // place for the bot to plant a wheel the next sync installs.
  assertEquals(env.UV_CACHE_DIR, `${RT}/cache/uv`);
  assertEquals(env.NPM_CONFIG_CACHE, `${WD}/hermes/cache/npm`);
  // uv drops a python3.x symlink into ~/.local/bin unless told otherwise —
  // outside the runtime, on the host's PATH, and shared by every bot.
  assertEquals(env.UV_PYTHON_BIN_DIR, `${RT}/python/bin`);
  for (const v of Object.values(env)) {
    assert(v.startsWith(WD) || v.startsWith(RT), v);
  }
});

Deno.test("installing the interpreter puts nothing on the host's PATH", () => {
  const s = uvSteps(`${RT}/hermes-agent`, "3.11");
  assert(s.install.includes("--no-bin"));
});

Deno.test("the dependency sync is locked, never re-resolved", () => {
  const s = uvSteps(`${RT}/hermes-agent`, "3.11");
  assert(s.sync.includes("--locked"));
  assert(s.sync.includes("--extra"));
  assertEquals(s.install, ["python", "install", "--no-bin", "3.11"]);
  assert(s.venv.includes("--python"));
});

Deno.test("the chat platform comes from the lock, not a first-run pip install", () => {
  // Upstream lazy-installs Telegram from PyPI at gateway start. A bot with a
  // named egress allowlist cannot reach PyPI, so without this the gateway runs
  // with no platform at all.
  const s = uvSteps(`${RT}/hermes-agent`, "3.11");
  const extras = s.sync.flatMap((a, i) =>
    s.sync[i - 1] === "--extra" ? [a] : []
  );
  assertEquals(extras, ["all", "messaging"]);
  // The config provision writes enables Telegram, so the probe must prove the
  // venv can load it, or a venv missing it reports complete.
  assert(configYaml(bot(), WD, RT).includes("telegram:"));
  assert(requiredImports(bot()).includes("telegram"));
  assert(requiredImports(bot()).includes("hermes_cli"));
});

// Gamma, provider anthropic behind a four-host allowlist, connected to
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
  const s = uvSteps(`${RT}/hermes-agent`, "3.11", providerExtras(b));
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
  const s = refSteps("fleet-2026-09-25").tag;
  assertEquals(s.fetch, [
    "fetch",
    "--depth",
    "1",
    "--no-tags",
    "origin",
    "+refs/tags/fleet-2026-09-25:refs/tags/fleet-2026-09-25",
  ]);
  // Detached at the tag, never a branch tip that could move under the fleet.
  assertEquals(s.checkout, [
    "checkout",
    "--quiet",
    "--detach",
    "refs/tags/fleet-2026-09-25",
  ]);
});

// The default ref is `main`. An earlier version fetched `origin tag <ref>`
// only, so every provision after the first clone failed on it.
Deno.test("a branch ref resolves and moves too, not only a tag", () => {
  assertEquals(localRefCandidates("main"), [
    "refs/tags/main^{commit}",
    "refs/remotes/origin/main^{commit}",
  ]);
  const s = refSteps("main").branch;
  assertEquals(
    s.fetch.at(-1),
    "+refs/heads/main:refs/remotes/origin/main",
  );
  assertEquals(s.checkout.at(-1), "refs/remotes/origin/main");
});

/** A real git, a real remote with a branch and a tag, and a shallow clone of
 * each — the shape provision leaves on disk. */
async function gitRepoWithBranchAndTag(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "hermes-ref-" });
  const g = async (cwd: string, ...args: string[]) => {
    const out = await new Deno.Command("git", {
      args: [...GIT_HARDEN, "-C", cwd, ...args],
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        // The developer's own config (signing, hooks) must not leak in.
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
    return new TextDecoder().decode(out.stdout).trim();
  };
  await Deno.mkdir(`${dir}/remote`);
  await g(`${dir}/remote`, "init", "-q", "-b", "main");
  await Deno.writeTextFile(`${dir}/remote/f`, "1");
  await g(`${dir}/remote`, "add", "f");
  await g(`${dir}/remote`, "commit", "-qm", "one");
  await g(`${dir}/remote`, "tag", "fleet-1");
  for (const ref of ["main", "fleet-1"]) {
    await g(
      dir,
      "clone",
      "-q",
      "--depth",
      "1",
      "--branch",
      ref,
      `file://${dir}/remote`,
      `${dir}/clone-${ref}`,
    );
  }
  return dir;
}

Deno.test("a shallow clone of a branch or a tag is found on its ref locally", async () => {
  const dir = await gitRepoWithBranchAndTag();
  try {
    for (const ref of ["main", "fleet-1"]) {
      const clone = `${dir}/clone-${ref}`;
      const head = await new Deno.Command("git", {
        args: ["-C", clone, "rev-parse", "HEAD"],
      }).output();
      let found: string | null = null;
      for (const cand of localRefCandidates(ref)) {
        const r = await new Deno.Command("git", {
          args: ["-C", clone, "rev-parse", "--verify", "--quiet", cand],
        }).output();
        if (r.success) {
          found = new TextDecoder().decode(r.stdout).trim();
          break;
        }
      }
      assertEquals(found, new TextDecoder().decode(head.stdout).trim(), ref);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a branch checkout moves to the branch's new tip: tag fetch fails, branch fetch wins", async () => {
  const dir = await gitRepoWithBranchAndTag();
  const git = async (cwd: string, ...args: string[]) =>
    await new Deno.Command("git", {
      args: [...GIT_HARDEN, "-C", cwd, ...args],
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).output();
  const text = (o: { stdout: Uint8Array }) =>
    new TextDecoder().decode(o.stdout).trim();
  try {
    // The remote's main moves on after the clone.
    await Deno.writeTextFile(`${dir}/remote/f`, "2");
    await git(`${dir}/remote`, "commit", "-qam", "two");
    const tip = text(await git(`${dir}/remote`, "rev-parse", "HEAD"));

    // The same order provision uses.
    const clone = `${dir}/clone-main`;
    const steps = refSteps("main");
    assert(!(await git(clone, ...steps.tag.fetch)).success);
    assert((await git(clone, ...steps.branch.fetch)).success);
    assert((await git(clone, ...steps.branch.checkout)).success);
    assertEquals(text(await git(clone, "rev-parse", "HEAD")), tip);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("every git call disables fsmonitor, hooks and ext:: transports", () => {
  const joined = GIT_HARDEN.join(" ");
  assertStringIncludes(joined, "core.fsmonitor=false");
  assertStringIncludes(joined, "core.hooksPath=/dev/null");
  assertStringIncludes(joined, "protocol.ext.allow=never");
});

Deno.test("import checks run isolated, so the cwd cannot shadow a module", () => {
  assertEquals(importCheckArgs("telegram"), ["-I", "-c", "import telegram"]);
});

Deno.test("config.yaml reaches MCPs over loopback and never spawns them", () => {
  const y = configYaml(
    bot({
      sandbox: { openPorts: [8813] },
      mcps: [{ name: "gh-gate", port: 8813 }],
    }),
    WD,
    RT,
  );
  assertStringIncludes(y, "url: http://127.0.0.1:8813/mcp");
  // A spawned MCP would inherit nono's confinement and lose both its
  // credential and its network, so no MCP but funes may have a command.
  // The hook is `- command:`, a list item under hooks; an MCP's is a plain
  // mapping key. Only the latter would spawn a server inside the sandbox.
  const commands = y.split("\n").filter((l) => /^ +command:/.test(l));
  assertEquals(commands.length, 1);
  assertStringIncludes(commands[0], `${RT}/tools/funes`);
});

Deno.test("config.yaml keeps every funes path to this bot's own directories", () => {
  const y = configYaml(bot(), WD, RT);
  assertStringIncludes(y, `FUNES_HOME: ${WD}/funes`);
  assertStringIncludes(y, `HF_HOME: ${WD}/funes/hf`);
  // State in the workdir, code in the runtime; never another bot's of either.
  for (const line of y.split("\n")) {
    if (line.includes("/agents/")) {
      assert(line.includes(WD) || line.includes(RT), line);
    }
  }
  // Staged tools come from the runtime, which the bot cannot write.
  assert(!y.includes(`${WD}/tools/`));
});

Deno.test("an old config.yaml's tools/ paths move to the runtime, and only those", () => {
  const old = [
    "mcp_servers:",
    "  funes:",
    `    command: ${WD}/tools/funes`,
    "    env:",
    `      FUNES_HOME: ${WD}/funes`,
    "hooks:",
    `  - command: bash '${WD}/tools/funes-index-hook.sh' 'hermes'`,
  ].join("\n");
  const m = migrateConfigTools(old, WD, RT);
  assertEquals(m.count, 2);
  assertStringIncludes(m.content, `command: ${RT}/tools/funes`);
  assertStringIncludes(m.content, `'${RT}/tools/funes-index-hook.sh'`);
  // State paths are untouched.
  assertStringIncludes(m.content, `FUNES_HOME: ${WD}/funes`);
  // Already migrated: nothing to do.
  assertEquals(migrateConfigTools(m.content, WD, RT).count, 0);
});

Deno.test("the code paths an earlier layout left in the workdir are known", () => {
  assertEquals(legacyRuntimePaths(), [
    "tools",
    "hermes/hermes-agent",
    "hermes/python",
  ]);
});

Deno.test("hfOffline is what turns the allowlist into a loud failure", () => {
  assert(!configYaml(bot(), WD, RT).includes("HF_HUB_OFFLINE"));
  assertStringIncludes(
    configYaml(bot({ funes: { hfOffline: true } }), WD, RT),
    "HF_HUB_OFFLINE: '1'",
  );
});

Deno.test("a gateway has no terminal, so onboarding is pre-dismissed", () => {
  const y = configYaml(bot(), WD, RT);
  assertStringIncludes(y, "profile_build_offered: true");
  assertStringIncludes(y, "busy_input_prompt: true");
});

Deno.test("fallback providers render only when declared", () => {
  assert(!configYaml(bot(), WD, RT).includes("fallback_providers"));
  const y = configYaml(
    bot({
      runtime: {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        fallback: [{ provider: "anthropic", model: "anthropic/claude-opus-5" }],
      },
    }),
    WD,
    RT,
  );
  assertStringIncludes(y, "provider: openai-codex");
  assertStringIncludes(y, "fallback_providers:");
  assertStringIncludes(y, "  - provider: anthropic");
});

Deno.test("the index hook rewrites HOME and stages funes on PATH", () => {
  const h = indexHook(bot(), WD, RT);
  // Hermes runs hooks with the real HOME; without this the hook indexes the
  // host's empty ~/.hermes, exits 0, and logs "ok".
  assertStringIncludes(h, `W=${WD}`);
  assertStringIncludes(h, 'export HOME="$W"');
  assertStringIncludes(h, 'export FUNES_HOME="$W/funes"');
  // find_bin falls back to $HOME/.local/bin, which is empty once HOME moved.
  // The staged binary is the runtime's, which the bot can run but not replace.
  assertStringIncludes(h, `export PATH="${RT}/tools:$PATH"`);
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
  const files = workdirFiles(bot(), WD, RT);
  const byPath = new Map(files.map((f) => [f.path, f]));
  // Hermes writes to config.yaml at runtime (onboarding.seen), and SOUL.md is
  // the bot's character. Rewriting either on a re-run would undo a person.
  assertEquals(byPath.get("hermes/config.yaml")!.clobber, false);
  assertEquals(byPath.get("hermes/SOUL.md")!.clobber, false);
  // The hook is derived, so a fix to the template has to reach every bot —
  // and it is code the bot runs, so it lives in the runtime.
  assert(!byPath.has("tools/funes-index-hook.sh"));
  const hook = runtimeFiles(bot(), WD, RT)[0];
  assertEquals(hook.path, "tools/funes-index-hook.sh");
  assertEquals(hook.clobber, true);
  assertEquals(hook.mode, 0o755);
});

Deno.test("provision keeps what it found and owns what it produced", () => {
  const [hook, config] = [
    runtimeFiles(bot(), WD, RT)[0],
    workdirFiles(bot(), WD, RT).find((f) => !f.clobber)!,
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

// funes runs integration scripts from $HOME/.funes, and HOME is the workdir.
// On the host that was code the bot could write, run as the operator.
Deno.test("funes add hermes runs inside the sandbox, with HOME set inside it", () => {
  const a = sandboxedFunesAdd(
    "/r/profiles/demo.linux.nono.json",
    WD,
    `${RT}/tools/funes`,
    INNER,
  );
  assertEquals(a.slice(0, 7), [
    "run",
    "-s",
    "--profile",
    "/r/profiles/demo.linux.nono.json",
    "--workdir",
    WD,
    "--",
  ]);
  // After `--`, so nono itself keeps the real HOME (its state root).
  const sep = a.indexOf("--");
  assert(a.indexOf(`HOME=${WD}`) > sep);
  assertEquals(a.slice(-3), [`${RT}/tools/funes`, "add", "hermes"]);
});

// ---------------------------------------------------------------------------
// funes: shell hook (up to 1.3) or Hermes plugin (since its catalog)
// ---------------------------------------------------------------------------

Deno.test("plugins.enabled is read in every shape Hermes writes it", () => {
  // PyYAML's default: the sequence at the key's own indent.
  assert(funesPluginEnabled("plugins:\n  enabled:\n  - funes\n"));
  // Indented sequence, quoted, with a neighbour and a comment.
  assert(
    funesPluginEnabled(
      "model:\n  provider: x\nplugins:\n  enabled:\n    - other\n    - 'funes'  # memory\n",
    ),
  );
  // Flow list.
  assert(funesPluginEnabled('plugins:\n  enabled: [other, "funes"]\n'));
  // Not enabled: absent, elsewhere, or only on the deny-list.
  assert(!funesPluginEnabled("model:\n  provider: x\n"));
  assert(!funesPluginEnabled("plugins:\n  enabled:\n  - other\n"));
  assert(!funesPluginEnabled("plugins:\n  disabled:\n  - funes\n"));
  // An explicit disable wins over enabled, as it does in Hermes.
  assert(
    !funesPluginEnabled("plugins:\n  enabled:\n  - funes\n  disabled:\n  - funes\n"),
  );
  // Only direct children of plugins: count, not a key of that name deeper.
  assert(
    !funesPluginEnabled("plugins:\n  settings:\n    enabled:\n    - funes\n"),
  );
  assert(!funesPluginEnabled("plugins:\n  enabled: []\nother:\n  - funes\n"));
});

Deno.test("hook-era funes add answers its prompt and runs with the bot's paths", () => {
  // funes asks before indexing existing sessions and reads EOF as "no",
  // skipping the install while exiting 0.
  assertEquals(FUNES_ADD_ANSWER, "y\n");
  const a = sandboxedFunesAdd("/p.json", WD, `${RT}/tools/funes`, INNER, {
    hfOffline: true,
  });
  // funes downloads into TMPDIR and cannot read it back from /tmp in here.
  assert(a.includes(`TMPDIR=${WD}/hermes/cache/scratch`));
  assert(a.includes("HF_HUB_OFFLINE=1"));
  assertEquals(a.slice(-3), [`${RT}/tools/funes`, "add", "hermes"]);
});

// `funes add --from` asks a person to vouch for a local source, and a plain
// `funes add` needs the catalog, which an allowlisted bot cannot reach. The
// verified integration's own entry point needs neither.
Deno.test("a plugin-era install runs the runtime's integration setup, sandboxed", () => {
  const a = sandboxedIntegrationSetup("/p.json", WD, RT, INNER);
  assertEquals(a.slice(0, 7), [
    "run",
    "-s",
    "--profile",
    "/p.json",
    "--workdir",
    WD,
    "--",
  ]);
  assert(a.includes("FUNES_AGENT_ID=hermes"));
  assert(a.includes(`FUNES_BIN=${RT}/tools/funes`));
  // No hermes on PATH, or setup registers an MCP server without the bot's env.
  assert(a.includes(`PATH=${RT}/tools:${INNER.path}`));
  assertEquals(a.slice(-3), [
    "/bin/sh",
    `${RT}/funes-integrations/hermes/setup`,
    "add",
  ]);
});

Deno.test("only an integration contract this model knows is run", () => {
  assertEquals(FUNES_INTEGRATION_CONTRACT, 1);
  assertEquals(
    integrationContract('{"contract_version": 1, "id": "hermes"}'),
    1,
  );
  assertEquals(integrationContract('{"contract_version": 2}'), 2);
  assertEquals(integrationContract("{}"), null);
  assertEquals(integrationContract("not json"), null);
});

Deno.test("the plugin is enabled by the runtime's Hermes, inside the sandbox", () => {
  const a = sandboxedPluginEnable("/p.json", WD, RT, INNER);
  assertEquals(a.slice(0, 7), [
    "run",
    "-s",
    "--profile",
    "/p.json",
    "--workdir",
    WD,
    "--",
  ]);
  assert(a.indexOf(`HERMES_HOME=${WD}/hermes`) > a.indexOf("--"));
  assertEquals(a.slice(-7), [
    `${RT}/hermes-agent/venv/bin/python`,
    "-I",
    "-m",
    "hermes_cli.main",
    "plugins",
    "enable",
    "funes",
  ]);
});

// The fetch runs funes's own setup, so it runs inside nono, able to write
// only its private scratch directory, with nothing of the operator's
// environment but a PATH, a locale and proxy/CA settings.
Deno.test("the integration is fetched inside nono, in its scratch directory only", () => {
  const scratch = "/Users/x/agents/.runtime/.tmp/funes-fetch-1";
  const a = sandboxedFetch(scratch, RT, {
    ...INNER,
    extra: { HTTPS_PROXY: "http://proxy:3128" },
  });
  assertEquals(a.slice(0, 7), [
    "run",
    "-s",
    "--allow",
    scratch,
    "--read",
    `${RT}/tools`,
    "--",
  ]);
  assertEquals(a.slice(7, 9), ["/usr/bin/env", "-i"]);
  assert(a.includes(`HOME=${scratch}`));
  assert(a.includes(`FUNES_HOME=${scratch}/funes`));
  assert(a.includes("HTTPS_PROXY=http://proxy:3128"));
  assert(!a.some((x) => x.startsWith("HERMES_HOME=")));
  assertEquals(a.slice(-3), [`${RT}/tools/funes`, "add", "hermes"]);
});

// Whatever runs in a bot's sandbox may be code the bot planted; it must not
// see the operator's environment.
Deno.test("every sandboxed step clears the environment and lists what it passes", () => {
  for (
    const a of [
      sandboxedFunesAdd("/p.json", WD, `${RT}/tools/funes`, INNER),
      sandboxedIntegrationSetup("/p.json", WD, RT, INNER),
      sandboxedPluginEnable("/p.json", WD, RT, INNER),
    ]
  ) {
    const sep = a.indexOf("--");
    assertEquals(a.slice(sep + 1, sep + 3), ["/usr/bin/env", "-i"]);
    assert(a.includes(`HOME=${WD}`));
    assert(a.includes("LANG=en_US.UTF-8"));
  }
  // The integration's setup finds the runtime's funes first.
  assert(
    sandboxedIntegrationSetup("/p.json", WD, RT, INNER).includes(
      `PATH=${RT}/tools:/opt/tools/bin:/usr/bin`,
    ),
  );
});

Deno.test("a plugin-era config has no shell hook; a hook-era one keeps it", () => {
  assert(configYaml(bot(), WD, RT).includes("post_llm_call"));
  const y = configYaml(bot(), WD, RT, { funesPlugin: true });
  assert(!y.includes("hooks:"));
  assert(!y.includes("funes-index-hook.sh"));
  // The funes MCP stays: the plugin only indexes.
  assertStringIncludes(y, `command: ${RT}/tools/funes`);
});

Deno.test("the hook wrapper steps aside once the plugin is installed", () => {
  const h = indexHook(bot(), WD, RT);
  const guard = h.indexOf('[ -f "$W/hermes/plugins/funes/plugin.yaml" ] && exit 0');
  assert(guard !== -1);
  // Before it does anything else.
  assert(guard < h.indexOf('export HOME="$W"'));
});
