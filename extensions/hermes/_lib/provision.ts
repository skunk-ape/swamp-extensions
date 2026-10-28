// Tier 2: the per-bot payload inside $WORKDIR.
//
// The dependency surface splits cleanly at the sandbox boundary, and this file
// is the inside half. Tier 1 — nono, swamp, uv, node, python3 — is host
// packaging: four provenance classes on this one machine (brew, nix,
// ~/.local/bin curl installers, Apple), so a model that picked a package
// manager would be wrong on somebody's host every time. Tier 2 is file layout
// in a directory we own completely, so it is ours to get right.
//
// Everything here is a scar:
//
//   - UV_PYTHON_INSTALL_DIR, because uv's interpreters resolve `sys.prefix`
//     back to their original install path. Copying one into the workdir does
//     not work; it has to be installed there.
//   - the HF cache seeded from a sibling bot rather than downloaded, so a bot
//     with a four-domain egress allowlist does not grow a fifth domain for a
//     one-time model fetch.
//   - the `.hermes` symlink, because Hermes runs post_llm_call hooks with the
//     real HOME, and `funes index --harness hermes` resolves sessions from
//     $HOME/.hermes/state.db. Without it the hook reads the host's empty husk,
//     finds nothing, exits 0, and logs "ok".
//   - config.yaml and SOUL.md written only when absent, because Hermes writes
//     to config.yaml itself (onboarding.seen) and SOUL.md is the bot's
//     character. Provisioning is not allowed to overwrite either.
//   - the code in a runtime directory OUTSIDE the workdir (runtimeOf), granted
//     to the sandbox read-only. Provision runs the venv's python, git, uv and
//     funes on the host as the operator; while they lived in the workdir the
//     bot could plant code in any of them — a .pth file, a .git/config
//     fsmonitor, a swapped binary — and it ran unsandboxed on the next
//     provision. State stays in the workdir; code the bot runs, it can no
//     longer write.
//
// What this deliberately does NOT do is run the upstream `setup-hermes.sh`.
// That script appends a PATH line to the user's shell rc, symlinks
// `hermes` into ~/.local/bin (so the last bot provisioned would win the host's
// CLI), offers to `brew install ripgrep`, `rm -rf`s an existing venv on every
// run, and ends in an interactive setup wizard. The three uv commands it wraps
// are reproduced here directly: no host mutation, no package manager, no
// prompt, and re-running is a no-op instead of a rebuild.

import type { Bot } from "./decl.ts";
import { runtimeOf, workdirOf } from "./decl.ts";

/**
 * A file provisioning puts in the workdir.
 *
 * `clobber` is the whole distinction between derived and stateful. A derived
 * file is rewritten every run so a fix to this template reaches every bot; a
 * stateful one is written once and never again, because the runtime owns it
 * from then on.
 */
export type WorkdirFile = {
  /** Relative to the workdir. */
  path: string;
  content: string;
  mode: number;
  clobber: boolean;
  /** Shown when the file is skipped, so "unchanged" is never mysterious. */
  because: string;
};

/** Absolute workdir with $HOME already resolved. */
export function resolvedWorkdir(b: Bot, home: string): string {
  return workdirOf(b).replace("$HOME", home);
}

/** Absolute runtime directory with $HOME already resolved. */
export function resolvedRuntime(b: Bot, home: string): string {
  return runtimeOf(b).replace("$HOME", home);
}

/**
 * Every directory the runtime expects to exist.
 *
 * launchd will not create the directory it writes a job's stdio into, and
 * Hermes will not create its own state root, so a missing one here is a job
 * that fails at exec with nothing in a log to say why.
 */
export function directories(_b: Bot): string[] {
  return [
    "logs",
    "funes/hf",
    "funes/memory",
    "workspace/inbox",
    "workspace/outbox",
    "hermes",
    "hermes/cache/uv",
    "hermes/cache/npm",
    // TMPDIR inside the sandbox. Without it SQLite's temp files land in
    // /var/tmp, which the sandbox refuses.
    "hermes/cache/scratch",
    "hermes/hooks",
    "hermes/memories",
    "hermes/sessions",
    "hermes/cron",
    "hermes/logs",
    // The XDG tree is exported into the inner shell rather than the launcher's
    // environment, because nono refuses a state root it was not told about.
    "hermes/xdg/cache",
    "hermes/xdg/config",
    "hermes/xdg/data",
    "hermes/xdg/state",
  ];
}

/**
 * Directories under the runtime (runtimeOf). The checkout is not listed: git
 * clone creates it, and refuses to clone into one that already exists.
 */
export function runtimeDirectories(): string[] {
  return ["tools", "python", "cache/uv"];
}

/**
 * Where earlier versions kept code inside the workdir.
 *
 * Nothing runs these any more. They are reported rather than deleted: the bot
 * could have written to them, so they are untrusted and never moved into the
 * runtime, but they are the operator's to remove once the new runtime is
 * confirmed working.
 */
export function legacyRuntimePaths(): string[] {
  return ["tools", "hermes/hermes-agent", "hermes/python"];
}

/**
 * Point a config.yaml written by an earlier provision at the runtime's tools.
 *
 * config.yaml is the runtime's and provision never rewrites it, with this one
 * exception: the funes MCP command and the index hook were written as
 * `<workdir>/tools/...`, a directory the bot can write. Left alone, an existing
 * bot would keep running tools it can modify. Only that exact prefix changes.
 */
export function migrateConfigTools(
  content: string,
  workdir: string,
  runtime: string,
): { content: string; count: number } {
  const from = `${workdir}/tools/`;
  const parts = content.split(from);
  return {
    content: parts.join(`${runtime}/tools/`),
    count: parts.length - 1,
  };
}

/**
 * git options for every call provision makes.
 *
 * The checkout is no longer bot-writable, so these are the second layer, not
 * the first: they stop a `.git/config` from running anything — an fsmonitor
 * command on `git status`, a hook on checkout, an `ext::` transport — should
 * that ever change.
 */
export const GIT_HARDEN = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.ext.allow=never",
];

/**
 * Arguments for "can the venv import this module".
 *
 * `-I` is isolated mode: no current directory on sys.path, no PYTHON*
 * variables, no user site-packages. Without it `python -c "import telegram"`
 * looks in the working directory first, and a `telegram.py` there wins.
 */
export function importCheckArgs(mod: string): string[] {
  return ["-I", "-c", `import ${mod}`];
}

/** YAML-quote a scalar that might contain something YAML would reinterpret. */
function q(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The starter `hermes/config.yaml`.
 *
 * Written once. Hermes edits this file at runtime — `onboarding.seen` grows as
 * prompts are dismissed — so a provisioner that rewrote it would undo the
 * agent's own state on every run.
 *
 * The MCP block is where the architecture shows: every credential-holding MCP
 * is an HTTP URL on loopback, reached but never spawned, because nono's
 * confinement is inherited and a gateway-spawned server would lose both the
 * credential it exists to hold and its network. Funes is the one stdio entry
 * and the exception that proves it: it holds no credential and reads a memory
 * inside this workdir, so running it inside the sandbox is what we want.
 */
export function configYaml(
  b: Bot,
  workdir: string,
  runtime: string,
  opts: { funesPlugin?: boolean } = {},
): string {
  const L: string[] = [];
  L.push(`# ${b.displayName} — starter configuration, written by provision.`);
  L.push(`#`);
  L.push(`# Hermes owns this file from here on and writes to it at runtime.`);
  L.push(`# Provision will not overwrite it: re-running is safe, and a change`);
  L.push(
    `# you make here survives. config.yaml.example in the hermes-agent checkout`,
  );
  L.push(`# lists every key this one leaves at its default.`);
  L.push(``);
  L.push(`model:`);
  L.push(`  provider: ${b.runtime.provider}`);
  L.push(`  default: ${b.runtime.model}`);
  L.push(`display:`);
  L.push(`  personality: none`);
  if (b.runtime.skin) L.push(`  skin: ${b.runtime.skin}`);
  L.push(`memory:`);
  L.push(`  memory_enabled: true`);
  L.push(`  user_profile_enabled: true`);
  L.push(`mcp_servers:`);
  for (const m of b.mcps) {
    L.push(`  ${m.name}:`);
    L.push(`    url: http://127.0.0.1:${m.port}/mcp`);
    // The gateway and its MCPs come up under launchd in no particular order.
    // A short connect timeout here is a parked MCP and a toolless agent.
    L.push(`    connect_timeout: 15`);
  }
  L.push(`  funes:`);
  L.push(`    command: ${runtime}/tools/funes`);
  L.push(`    args:`);
  L.push(`      - mcp`);
  L.push(`    env:`);
  L.push(`      FUNES_HOME: ${workdir}/funes`);
  L.push(`      HF_HOME: ${workdir}/funes/hf`);
  if (b.funes.hfOffline) {
    // Failing loudly beats reaching for a domain the sandbox will refuse: with
    // a named egress allowlist the embedding fetch cannot succeed, and a
    // timeout is a much worse way to learn that than an immediate error.
    L.push(`      HF_HUB_OFFLINE: '1'`);
  }
  L.push(`gateway:`);
  L.push(`  platforms:`);
  L.push(`    telegram:`);
  L.push(`      enabled: true`);
  L.push(`onboarding:`);
  // A gateway has no terminal to answer an onboarding prompt on, so every one
  // of them is pre-dismissed. Left unset they block the first real message.
  L.push(`  seen:`);
  L.push(`    profile_build_offered: true`);
  L.push(`    busy_input_prompt: true`);
  L.push(`    tool_progress_prompt: true`);
  // A hook-era funes indexes through this shell hook; a plugin-era one indexes
  // from its own Hermes plugin, and the hook would only run a wrapper that has
  // nothing to do.
  if (!opts.funesPlugin) {
    L.push(`hooks:`);
    L.push(`  post_llm_call:`);
    L.push(
      `    - command: bash ${
        q(`${runtime}/tools/funes-index-hook.sh`)
      } 'hermes'`,
    );
    L.push(`      timeout: 30`);
  }
  if (b.runtime.fallback.length > 0) {
    L.push(`fallback_providers:`);
    for (const f of b.runtime.fallback) {
      L.push(`  - provider: ${f.provider}`);
      L.push(`    model: ${f.model}`);
    }
  }
  L.push(`agent:`);
  // One retry, not the default. A gateway that retries for minutes looks alive
  // and answers nothing; failing fast puts the error in the chat where it can
  // be seen.
  L.push(`  api_max_retries: 1`);
  L.push(``);
  return L.join("\n");
}

/**
 * The starter `hermes/SOUL.md`.
 *
 * Written once, and deliberately thin. This is the bot's character and it is
 * written by a person; what provisioning can supply is the part a person would
 * otherwise have to rediscover — that this agent is sandboxed, what it can and
 * cannot reach, and where the file handoff happens.
 */
export function soulMd(b: Bot, workdir: string): string {
  const egress = b.sandbox.egress.includes("*")
    ? "You may reach any host on the network."
    : `Your network egress is restricted to: ${
      b.sandbox.egress.join(", ")
    }. Anything else is refused by the sandbox, not by a policy you can talk your way around.`;
  const extra = b.sandbox.filesystemAllow.length > 0
    ? `\nBeyond the workdir you can also read and write:\n${
      b.sandbox.filesystemAllow.map((p) => `- \`${p}\``).join("\n")
    }\n`
    : "";
  return `# ${b.displayName}

You are **${b.displayName}**${
    b.rationale ? `. ${b.rationale.split("\n")[0]}` : ""
  }

This file is yours to grow. Provision wrote the starting point and will never
overwrite it.

## Where you are

You run inside a nono sandbox, confined to \`${workdir}\`. Everything you write
must land inside it — a path outside is not a permissions error you can retry,
it is a boundary.
${extra}
${egress}

## Handing files back and forth

- \`workspace/outbox/\` — write here, and it can be read from outside.
- \`workspace/inbox/\` — files handed to you appear here. You cannot see
  anything outside this workdir, so a file you were not handed does not exist.

## Your memory

Funes indexes your sessions after every turn. \`recall\` searches what you have
already done, which is usually faster than re-deriving it.
`;
}

/**
 * `tools/funes-index-hook.sh`, in the runtime.
 *
 * Derived, and rewritten every run. It lives in the runtime with the binary it
 * runs, so the bot can execute it but not edit it. Three things it exists to fix, all of them
 * silent failures that look like success:
 *
 *   - Hermes runs post_llm_call hooks with the REAL home, so the hook's
 *     `funes index --harness hermes` would read the host's ~/.hermes and find
 *     nothing. HOME is rewritten to the workdir, where `.hermes` symlinks to
 *     the Hermes home this bot actually runs on.
 *   - FUNES_HOME and HF_HOME are set explicitly rather than left to fall out
 *     of HOME, so the memory cannot silently move if this file changes.
 *   - find_bin in funes' own script tries `command -v` then $HOME/.local/bin,
 *     and with HOME rewritten that fallback points somewhere empty. The staged
 *     binary goes on PATH explicitly.
 *
 * The paths in it are this bot's and no other's. A session's text landing in a
 * sibling's memory would make personal context retrievable from a work agent,
 * which is the entire reason these runtimes are separate.
 */
export function indexHook(b: Bot, workdir: string, runtime: string): string {
  return `#!/bin/sh
# Wrapper around funes's own funes-index.sh, supplying the environment the hook
# does not otherwise get. Generated by @skunk-ape/hermes/bot provision for
# ${b.slug} — edit the declaration, not this file.
#
# Hermes runs post_llm_call hooks with HOME set to the real home, outside this
# workdir. \`funes index --harness hermes\` takes no path argument and resolves
# sessions from \$HOME/.hermes/state.db, so under the gateway's HOME it reads
# the host's ~/.hermes and silently finds nothing: a no-op that logs "ok".
#
# Setting HOME to the workdir points that lookup at \$W/.hermes, which symlinks
# to the Hermes home ${b.slug} actually runs on. FUNES_HOME and HF_HOME are set
# explicitly rather than left to fall out of HOME, so the memory location does
# not silently move if this file changes.
#
# These paths are ${b.slug}'s and no other bot's.
set -eu
W=${workdir}
# A funes that installs the Hermes plugin indexes each turn from inside the
# gateway and deletes the hook script below. A config.yaml written before the
# switch still calls this wrapper, so it steps aside rather than fail.
[ -f "\$W/hermes/plugins/funes/plugin.yaml" ] && exit 0
export HOME="\$W"
export FUNES_HOME="\$W/funes"
export HF_HOME="\$W/funes/hf"
# find_bin in funes-index.sh tries \`command -v\` then \$HOME/.local/bin. With
# HOME rewritten above, that fallback points somewhere empty — so put the
# staged binary on PATH explicitly rather than relying on either. It is the
# runtime's copy, which the bot can run but not replace.
export PATH="${runtime}/tools:\$PATH"
exec bash "\$W/.hermes/hooks/funes-index.sh" "\$@"
`;
}

/** Every file provisioning writes into the runtime. All derived. */
export function runtimeFiles(
  b: Bot,
  workdir: string,
  runtime: string,
): WorkdirFile[] {
  return [
    {
      path: "tools/funes-index-hook.sh",
      content: indexHook(b, workdir, runtime),
      mode: 0o755,
      clobber: true,
      because: "derived from the declaration",
    },
  ];
}

/** Every file provisioning writes into the workdir. Both are stateful. */
export function workdirFiles(
  b: Bot,
  workdir: string,
  runtime: string,
  opts: { funesPlugin?: boolean } = {},
): WorkdirFile[] {
  return [
    {
      path: "hermes/config.yaml",
      content: configYaml(b, workdir, runtime, opts),
      mode: 0o644,
      clobber: false,
      because: "Hermes writes to it at runtime; provision never overwrites it",
    },
    {
      path: "hermes/SOUL.md",
      content: soulMd(b, workdir),
      mode: 0o644,
      clobber: false,
      because: "the bot's character, written by a person",
    },
  ];
}

/**
 * What to do about one workdir file.
 *
 * `kept` is the interesting outcome and the rule behind it is narrower than
 * "never overwrite": provision never overwrites what it FOUND, and does own
 * what its own steps PRODUCED. `funes add hermes` writes a generic config.yaml
 * as a side effect — a bare `command: funes` that depends on PATH, with none of
 * the bot's own funes environment — and treating that as untouchable state left
 * the first provisioned bot running funes' config instead of its own.
 *
 * @param current what is on disk now, or null when nothing is
 * @param preexisting whether the file was there BEFORE this run touched anything
 */
export function decideFile(
  f: WorkdirFile,
  current: string | null,
  preexisting: boolean,
): "created" | "updated" | "replaced" | "kept" {
  if (current === null) return "created";
  // State the runtime or a person owns. Found, so left alone.
  if (!f.clobber && preexisting) return "kept";
  if (current === f.content) return "kept";
  return preexisting ? "updated" : "replaced";
}

/**
 * The uv invocations, in order, as argv arrays.
 *
 * Split out so a test can assert the flags rather than trusting a comment.
 * `--locked` is the one that matters: it makes the install reproduce the
 * checkout's uv.lock instead of re-resolving, which is the difference between
 * two bots on the same ref running the same dependency set and merely
 * believing they do.
 */
export function uvSteps(
  agentDir: string,
  pythonVersion: string,
  extras: string[] = [],
): { install: string[]; venv: string[]; sync: string[] } {
  return {
    // `--no-bin` is not a nicety. Without it `uv python install` also writes a
    // `python3.x` symlink into UV_PYTHON_BIN_DIR, which defaults to
    // ~/.local/bin — outside the workdir, on the host's PATH, and shared by
    // every bot, so the last one provisioned would own the host's `python3.11`
    // and point it into its own sandbox. That is the same failure this method
    // refuses to inherit from setup-hermes.sh, and it was reintroduced here:
    // a probe run left a dangling ~/.local/bin/python3.11 aimed at a workdir
    // that had been deleted. The env var below closes the same hole a second
    // way, for a uv that ever changes what the flag means.
    install: ["python", "install", "--no-bin", pythonVersion],
    venv: ["venv", `${agentDir}/venv`, "--python", pythonVersion],
    // `messaging` because upstream took the Telegram adapter out of `[all]`
    // and now pip-installs it the first time the gateway starts. That works
    // for a bot with unrestricted egress and fails for one with a named
    // allowlist, which has no route to PyPI: Gamma ran for a day as a healthy
    // service with no chat platform, logging "requirements not met" on every
    // start. Every bot this model provisions enables Telegram, so every bot
    // gets it from the lock, on the host, before the sandbox ever starts.
    //
    // `extras` are the declaration's own: the SDK behind each model provider
    // it names, which upstream lazy-installs the same way (providerDeps).
    sync: [
      "sync",
      "--extra",
      "all",
      "--extra",
      "messaging",
      ...extras.flatMap((e) => ["--extra", e]),
      "--locked",
    ],
  };
}

/**
 * Model providers whose SDK upstream installs from PyPI on first use rather
 * than shipping in `[all]`: the uv.lock extra that pins it, and the module
 * that proves it is there. Mirrors the `provider.*` entries in the checkout's
 * `tools/lazy_deps.py`. A provider absent here needs nothing beyond `[all]`
 * (openai-codex rides on the core `openai` dependency).
 *
 * After the Linux cutover Gamma, provider `anthropic` behind a four-host
 * allowlist, failed every turn at agent construction — "The 'anthropic'
 * package is required" — before its fallback provider was ever consulted.
 */
export const PROVIDER_DEPS: Record<string, { extra: string; module: string }> =
  {
    anthropic: { extra: "anthropic", module: "anthropic" },
    bedrock: { extra: "bedrock", module: "boto3" },
    vertex: { extra: "vertex", module: "google.auth" },
  };

/** The declared providers, primary then fallbacks, deduplicated. */
function declaredProviders(b: Bot): string[] {
  return [
    ...new Set([
      b.runtime.provider,
      ...b.runtime.fallback.map((f) => f.provider),
    ]),
  ];
}

/** The uv.lock extras this bot's declared providers need. */
export function providerExtras(b: Bot): string[] {
  return declaredProviders(b).flatMap((p) =>
    PROVIDER_DEPS[p] ? [PROVIDER_DEPS[p].extra] : []
  );
}

/**
 * Local refs that name the declared ref, tag first.
 *
 * `agent.ref` is a branch or a tag. A tag is what pins a fleet; a branch is
 * the default (`main`) and what the clone's `--branch` accepts either way. The
 * shallow clone records a tag under refs/tags and a branch under
 * refs/remotes/origin, so both are tried, locally, without touching the
 * network — check mode must not fetch.
 */
export function localRefCandidates(ref: string): string[] {
  return [`refs/tags/${ref}^{commit}`, `refs/remotes/origin/${ref}^{commit}`];
}

/**
 * The git invocations that move an existing checkout to the declared ref.
 *
 * Without these a ref edit in the declaration reached no existing workdir:
 * provision saw a checkout, called it present, and `--check` reported the
 * workdir complete while it ran the old commit. Shallow like the clone, and a
 * detached checkout of exactly the named ref.
 *
 * An earlier version fetched `origin tag <ref>` only, so the default ref
 * `main` failed every run after the first clone. The tag is tried first, then
 * the branch; whichever fetch succeeds decides which checkout runs.
 */
export function refSteps(ref: string): {
  tag: { fetch: string[]; checkout: string[] };
  branch: { fetch: string[]; checkout: string[] };
} {
  return {
    tag: {
      fetch: [
        "fetch",
        "--depth",
        "1",
        "--no-tags",
        "origin",
        `+refs/tags/${ref}:refs/tags/${ref}`,
      ],
      checkout: ["checkout", "--quiet", "--detach", `refs/tags/${ref}`],
    },
    branch: {
      fetch: [
        "fetch",
        "--depth",
        "1",
        "--no-tags",
        "origin",
        `+refs/heads/${ref}:refs/remotes/origin/${ref}`,
      ],
      checkout: [
        "checkout",
        "--quiet",
        "--detach",
        `refs/remotes/origin/${ref}`,
      ],
    },
  };
}

/**
 * Modules the venv must import before its dependencies count as present.
 *
 * `hermes_cli` proves the project is installed; it does not prove the gateway
 * can reach anyone. The platform adapter is imported lazily and installed on
 * first use, so a venv without it passes every other test here and then starts
 * a gateway that talks to nothing. The same is true of a provider SDK, except
 * the gateway connects fine and then fails every turn. Each entry is one that
 * the provisioned config.yaml needs.
 */
export function requiredImports(b: Bot): string[] {
  return [
    "hermes_cli",
    "telegram",
    ...declaredProviders(b).flatMap((p) =>
      PROVIDER_DEPS[p] ? [PROVIDER_DEPS[p].module] : []
    ),
  ];
}

/** The environment every uv step runs with. Each variable keeps a write inside
 * this bot's runtime that would otherwise land in a shared cache on the host.
 *
 * The cache is the runtime's, not the workdir's: a uv cache the bot could
 * write is a place to plant a wheel the next `uv sync` installs. The workdir's
 * own uv cache stays for whatever the bot runs inside its sandbox. */
export function uvEnv(
  workdir: string,
  runtime: string,
): Record<string, string> {
  return {
    UV_CACHE_DIR: `${runtime}/cache/uv`,
    // The one that bites on a fresh install. Without it the venv points at the
    // shared interpreter under ~/.local/share/uv/, outside the runtime, and
    // the gateway cannot exec its own python.
    UV_PYTHON_INSTALL_DIR: `${runtime}/python`,
    NPM_CONFIG_CACHE: `${workdir}/hermes/cache/npm`,
    // Where uv would otherwise drop a python3.x symlink on the host's PATH.
    // Pointed inside the runtime so nothing lands outside it even if the
    // `--no-bin` flag on the install step is ever dropped or renamed.
    UV_PYTHON_BIN_DIR: `${runtime}/python/bin`,
    HERMES_HOME: `${workdir}/hermes`,
  };
}

// ---------------------------------------------------------------------------
// funes integration
// ---------------------------------------------------------------------------
//
// funes has wired itself into Hermes two ways. Up to 1.3 it installed a
// post_llm_call SHELL hook, `hooks/funes-index.sh`, which this model's
// runtime wrapper (indexHook) supplies an environment to. From the release
// that introduced its integration catalog it installs a Hermes PLUGIN at
// `hermes/plugins/funes/`, fetched as a versioned integration, which indexes
// each turn inside the gateway and deletes the old hook script. Which one a
// bot gets is decided by the funes it has staged, not by a setting here.

/** `funes add` asks before indexing existing sessions and reads end-of-file
 * as "no" — skipping the install and still exiting 0. This is the answer. */
export const FUNES_ADD_ANSWER = "y\n";

/** Where provision keeps the fetched funes integration: in the runtime, so
 * the setup script a sandboxed install runs is one the bot cannot edit. */
export function funesIntegrationDir(runtime: string): string {
  return `${runtime}/funes-integrations/hermes`;
}

/** The marker of a plugin-era install. */
export function funesPluginManifest(workdir: string): string {
  return `${workdir}/hermes/plugins/funes/plugin.yaml`;
}

/** The marker of a hook-era install. */
export function funesHookScript(workdir: string): string {
  return `${workdir}/hermes/hooks/funes-index.sh`;
}

/** Host variables the integration fetch keeps: what reaching the catalog
 * through a proxy, or with a non-default CA bundle (NixOS), needs. */
export const FETCH_PASSTHROUGH = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NIX_SSL_CERT_FILE",
];

/**
 * argv for fetching the integration: `nono run` with a throwaway grant.
 *
 * The fetch IS `funes add hermes` — funes has no fetch-only command — and that
 * runs the integration's setup too. So it runs inside nono, able to write only
 * `scratch` (a private directory under .runtime/.tmp, never /tmp, which every
 * bot can write) and read the runtime's tools, with `env -i` and a HOME that
 * is the scratch directory: whatever the catalog's setup does, it does there.
 * funes checks the integration against the catalog's sha256; the sandbox is
 * for everything that check cannot rule out.
 */
export function sandboxedFetch(
  scratch: string,
  runtime: string,
  inner: InnerEnv & { extra?: Record<string, string> },
): string[] {
  return [
    "run",
    "-s",
    "--allow",
    scratch,
    "--read",
    `${runtime}/tools`,
    "--",
    "/usr/bin/env",
    "-i",
    `HOME=${scratch}`,
    `FUNES_HOME=${scratch}/funes`,
    `HF_HOME=${scratch}/funes/hf`,
    `TMPDIR=${scratch}`,
    `PATH=${inner.path}`,
    `LANG=${inner.lang}`,
    ...Object.entries(inner.extra ?? {}).map(([k, v]) => `${k}=${v}`),
    `${runtime}/tools/funes`,
    "add",
    "hermes",
  ];
}

/** Where a host-side fetch left the integration, under its throwaway HOME. */
export function fetchedIntegration(scratch: string): string {
  return `${scratch}/.funes/agents/hermes`;
}

/** What a command run inside a sandbox may inherit from the host: a PATH for
 * its tools and a locale. Everything else it is given explicitly. */
export type InnerEnv = { path: string; lang: string };

/** The common head of a command run inside the bot's own sandbox. */
function inSandbox(
  profile: string,
  workdir: string,
  inner: InnerEnv,
): string[] {
  return [
    "run",
    "-s",
    "--profile",
    profile,
    "--workdir",
    workdir,
    "--",
    // `env -i`: the command gets exactly what is listed here and nothing of
    // the operator's environment. Whatever runs in the sandbox may be code
    // the bot planted — a module beside a script python runs, say — and the
    // operator's environment holds cloud credentials and tokens.
    //
    // HOME goes to the command here, not to nono: nono keeps its state under
    // $HOME/.nono and refuses a grant that overlaps it, so a workdir HOME
    // handed to nono fails before anything starts (nono 0.78.0).
    "/usr/bin/env",
    "-i",
    `HOME=${workdir}`,
    `PATH=${inner.path}`,
    `LANG=${inner.lang}`,
    // The default is outside the workdir: funes downloads its catalog into
    // TMPDIR and then cannot read it back. The gateway uses this directory.
    `TMPDIR=${workdir}/hermes/cache/scratch`,
  ];
}

/**
 * argv for `funes add hermes`, run inside the bot's own sandbox. Hook-era
 * funes only: it carries its hook scripts and needs no catalog.
 *
 * Never on the host: funes runs scripts it keeps under $HOME/.funes, and HOME
 * here is the workdir, which the bot can write. Inside nono a planted script
 * gets the bot's own access and nothing more.
 */
export function sandboxedFunesAdd(
  profile: string,
  workdir: string,
  funes: string,
  inner: InnerEnv,
  opts: { hfOffline?: boolean } = {},
): string[] {
  return [
    ...inSandbox(profile, workdir, inner),
    `FUNES_HOME=${workdir}/funes`,
    `HF_HOME=${workdir}/funes/hf`,
    ...(opts.hfOffline ? ["HF_HUB_OFFLINE=1"] : []),
    funes,
    "add",
    "hermes",
  ];
}

/** The integration contract this model knows how to run. */
export const FUNES_INTEGRATION_CONTRACT = 1;

/** The `contract_version` an integration's manifest.json declares, or null. */
export function integrationContract(manifest: string): number | null {
  try {
    const v = JSON.parse(manifest)?.contract_version;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/**
 * argv for a plugin-era install: the integration's own `setup add`, from the
 * runtime, inside the bot's sandbox.
 *
 * Not `funes add hermes --from <runtime copy>`: funes will not vouch for a
 * local source and asks a person at a terminal to confirm it, so that path
 * cannot run unattended. Not a plain `funes add hermes` either: that fetches
 * from the catalog, and a bot with a named egress allowlist has no route to
 * it. The integration was fetched — and checked against the catalog's sha256
 * by funes — on the host; what runs here is its documented entry point
 * (contract_version 1: `setup add [MEMORY]`, configured by FUNES_BIN,
 * FUNES_HOME and FUNES_AGENT_ID). No network, and nothing the bot can edit.
 */
export function sandboxedIntegrationSetup(
  profile: string,
  workdir: string,
  runtime: string,
  inner: InnerEnv,
): string[] {
  return [
    ...inSandbox(profile, workdir, {
      ...inner,
      path: `${runtime}/tools:${inner.path}`,
    }),
    `FUNES_HOME=${workdir}/funes`,
    `HF_HOME=${workdir}/funes/hf`,
    "FUNES_AGENT_ID=hermes",
    `FUNES_BIN=${runtime}/tools/funes`,
    // The runtime's funes first. No hermes on that PATH, deliberately — the
    // caller drops any directory holding one: setup would register funes as
    // an MCP server with none of this bot's environment, and config.yaml
    // already has the right one. The plugin is enabled separately.
    "/bin/sh",
    `${funesIntegrationDir(runtime)}/setup`,
    "add",
  ];
}

/**
 * argv for `hermes plugins enable funes`, inside the bot's own sandbox.
 *
 * funes's setup runs this itself only when `hermes` is on PATH, which inside
 * the sandbox it is not, so a plugin-era install leaves the plugin on disk and
 * switched off. The runtime's Hermes does it here; it writes
 * `plugins.enabled` in config.yaml, which is why this runs after provision has
 * written that file.
 */
export function sandboxedPluginEnable(
  profile: string,
  workdir: string,
  runtime: string,
  inner: InnerEnv,
): string[] {
  return [
    ...inSandbox(profile, workdir, inner),
    `HERMES_HOME=${workdir}/hermes`,
    `${runtime}/hermes-agent/venv/bin/python`,
    "-I",
    "-m",
    "hermes_cli.main",
    "plugins",
    "enable",
    "funes",
  ];
}

/**
 * Whether config.yaml has funes enabled, as Hermes decides it: listed under
 * `plugins.enabled` and not under `plugins.disabled`, which wins.
 *
 * Read as text rather than parsed: this model takes no YAML dependency. Only
 * the direct children of a top-level `plugins:` count, in the shapes Hermes
 * writes — a block list (its own) or a flow list. Anything this cannot read
 * reads as "not enabled", which costs one idempotent re-enable and a step
 * that reports itself unsettled rather than a wrong "present".
 */
export function funesPluginEnabled(config: string): boolean {
  const lists = pluginLists(config);
  return lists.enabled.includes("funes") && !lists.disabled.includes("funes");
}

/** The `enabled` and `disabled` lists directly under a top-level `plugins:`. */
function pluginLists(
  config: string,
): { enabled: string[]; disabled: string[] } {
  const out = { enabled: [] as string[], disabled: [] as string[] };
  const lines = config.split("\n");
  const top = lines.findIndex((l) => /^plugins:\s*(#.*)?$/.test(l));
  if (top === -1) return out;
  const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, "");
  let childIndent = -1;
  for (let i = top + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(#.*)?$/.test(l)) continue;
    if (/^\S/.test(l)) break; // left the plugins block
    const indent = l.length - l.trimStart().length;
    if (childIndent === -1) childIndent = indent;
    if (indent !== childIndent) continue; // deeper than a direct child
    const key = l.match(/^\s+(enabled|disabled):\s*(.*?)\s*(#.*)?$/);
    if (!key) continue;
    const name = key[1] as "enabled" | "disabled";
    const flow = key[2].match(/^\[(.*)\]$/);
    if (flow) {
      out[name] = flow[1].split(",").map(unquote).filter((s) => s !== "");
      continue;
    }
    if (key[2] !== "") continue; // a scalar, or a shape not read here
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^(\s*)-\s*(.*?)\s*(#.*)?$/);
      if (!item || item[1].length < childIndent) break;
      out[name].push(unquote(item[2]));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hermes shell-hook consent
// ---------------------------------------------------------------------------
//
// Hermes runs a config.yaml shell hook only once it is on its allowlist
// (`hermes/shell-hooks-allowlist.json`), matched on the exact event and
// command string; otherwise it logs "not allowlisted — skipped" and the bot
// indexes nothing. Approval normally happens at a terminal prompt, which a
// gateway does not have, or by accepting every hook (`hooks_auto_accept`),
// which is far wider than needed. So provision approves its OWN wrapper and
// nothing else: the script lives in the runtime, which the bot cannot write,
// so what was approved is what runs.

/** The `post_llm_call` commands in config.yaml that run this model's wrapper,
 * as Hermes reads them: a quoted YAML scalar unquoted, a plain one as is. */
export function wrapperHookCommands(config: string): string[] {
  const out: string[] = [];
  for (const line of config.split("\n")) {
    const m = line.match(/^\s*(?:-\s*)?command:\s*(.+?)\s*$/);
    if (!m || !m[1].includes("funes-index-hook.sh")) continue;
    const v = m[1];
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
      out.push(v.slice(1, -1).replace(/''/g, "'"));
    } else if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      out.push(JSON.parse(v));
    } else {
      out.push(v);
    }
  }
  return out;
}

/**
 * The allowlist with `commands` approved for post_llm_call, in Hermes's own
 * format, and how many were added. An allowlist that is absent or not the
 * shape Hermes writes starts empty rather than being guessed at.
 */
export function approveWrapperHooks(
  allowlist: string | null,
  commands: string[],
  nowIso: string,
  scriptMtimeIso: string,
): { text: string; added: number } {
  let data: { approvals: Array<Record<string, unknown>> } = { approvals: [] };
  try {
    const parsed = allowlist ? JSON.parse(allowlist) : null;
    if (parsed && Array.isArray(parsed.approvals)) data = parsed;
  } catch { /* unreadable: start empty */ }
  let added = 0;
  for (const command of commands) {
    const known = data.approvals.some((a) =>
      a.event === "post_llm_call" && a.command === command
    );
    if (known) continue;
    data.approvals.push({
      approved_at: nowIso,
      command,
      event: "post_llm_call",
      script_mtime_at_approval: scriptMtimeIso,
    });
    added++;
  }
  return { text: JSON.stringify(data, null, 2) + "\n", added };
}
