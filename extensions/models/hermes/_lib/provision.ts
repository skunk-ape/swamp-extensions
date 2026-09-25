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
//
// What this deliberately does NOT do is run the upstream `setup-hermes.sh`.
// That script appends a PATH line to the user's shell rc, symlinks
// `hermes` into ~/.local/bin (so the last bot provisioned would win the host's
// CLI), offers to `brew install ripgrep`, `rm -rf`s an existing venv on every
// run, and ends in an interactive setup wizard. The three uv commands it wraps
// are reproduced here directly: no host mutation, no package manager, no
// prompt, and re-running is a no-op instead of a rebuild.

import type { Bot } from "./decl.ts";
import { workdirOf } from "./decl.ts";

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
    "tools",
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
    "hermes/python",
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
export function configYaml(b: Bot, workdir: string): string {
  const L: string[] = [];
  L.push(`# ${b.displayName} — starter configuration, written by provision.`);
  L.push(`#`);
  L.push(`# Hermes owns this file from here on and writes to it at runtime.`);
  L.push(`# Provision will not overwrite it: re-running is safe, and a change`);
  L.push(
    `# you make here survives. config.yaml.example in hermes-agent/ lists`,
  );
  L.push(`# every key this one leaves at its default.`);
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
  L.push(`    command: ${workdir}/tools/funes`);
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
  L.push(`hooks:`);
  L.push(`  post_llm_call:`);
  L.push(
    `    - command: bash ${q(`${workdir}/tools/funes-index-hook.sh`)} 'hermes'`,
  );
  L.push(`      timeout: 30`);
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
 * `tools/funes-index-hook.sh`.
 *
 * Derived, and rewritten every run. Three things it exists to fix, all of them
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
export function indexHook(b: Bot, workdir: string): string {
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
export HOME="\$W"
export FUNES_HOME="\$W/funes"
export HF_HOME="\$W/funes/hf"
# find_bin in funes-index.sh tries \`command -v\` then \$HOME/.local/bin. With
# HOME rewritten above, that fallback points somewhere empty — so put the
# staged binary on PATH explicitly rather than relying on either.
export PATH="\$W/tools:\$PATH"
exec bash "\$W/.hermes/hooks/funes-index.sh" "\$@"
`;
}

/** Every file provisioning writes into the workdir, derived and stateful alike. */
export function workdirFiles(b: Bot, workdir: string): WorkdirFile[] {
  return [
    {
      path: "tools/funes-index-hook.sh",
      content: indexHook(b, workdir),
      mode: 0o755,
      clobber: true,
      because: "derived from the declaration",
    },
    {
      path: "hermes/config.yaml",
      content: configYaml(b, workdir),
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
    // allowlist, which has no route to PyPI: Stuart ran for a day as a healthy
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
 * After the Linux cutover Stuart, provider `anthropic` behind a four-host
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
 * The git invocations that move an existing checkout to the declared ref.
 *
 * Without these a ref edit in the declaration reached no existing workdir:
 * provision saw a checkout, called it present, and `--check` reported the
 * workdir complete while it ran the old commit. Shallow like the clone, and a
 * detached checkout of exactly the named ref, because a tag is what pins a
 * fleet and a branch tip would move under it.
 */
export function refSteps(ref: string): {
  fetch: string[];
  checkout: string[];
} {
  return {
    fetch: ["fetch", "--depth", "1", "--no-tags", "origin", "tag", ref],
    checkout: ["checkout", "--quiet", "--detach", `refs/tags/${ref}`],
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
 * the workdir that would otherwise land in a shared cache on the host. */
export function uvEnv(workdir: string): Record<string, string> {
  return {
    UV_CACHE_DIR: `${workdir}/hermes/cache/uv`,
    // The one that bites on a fresh install. Without it the venv points at the
    // shared interpreter under ~/.local/share/uv/, outside the workdir, and
    // the gateway cannot exec its own python.
    UV_PYTHON_INSTALL_DIR: `${workdir}/hermes/python`,
    NPM_CONFIG_CACHE: `${workdir}/hermes/cache/npm`,
    // Where uv would otherwise drop a python3.x symlink on the host's PATH.
    // Pointed inside the workdir so nothing lands outside it even if the
    // `--no-bin` flag on the install step is ever dropped or renamed.
    UV_PYTHON_BIN_DIR: `${workdir}/hermes/python/bin`,
    HERMES_HOME: `${workdir}/hermes`,
  };
}
