// What one sandboxed Hermes bot is, as data.
//
// The schema holds only what differs between bots. Everything invariant —
// HERMES_HOME, the uv and npm cache redirections, TERMINAL_CWD, the Funes
// paths, the deferred XDG exports, `nono run` rather than `nono wrap` — lives
// in the templates in render.ts, because every one of those lines exists
// because something broke once and none of them is a per-bot decision.
//
// Three real deployments (a personal agent with four host-side MCPs, a work
// agent with none, and a lifeos agent with deep filesystem access and a
// four-host egress allowlist) reduce to 34-55 lines of this each.

import { z } from "npm:zod@4";

/** A Telegram identity. Never shared between bots: a shared token would put
 * two agents' conversations in one chat history and one session database. */
const TelegramSchema = z.object({
  allowedUsers: z.array(z.string().regex(/^\d+$/, "numeric Telegram user id"))
    .min(1)
    .describe(
      "Telegram user ids allowed to talk to this bot. Not a secret, so it lives in the declaration rather than the vault and a wrong id is a one-line fix. An empty list would make the gateway deny every sender.",
    ),
  homeChannel: z.string().regex(/^-?\d+$/).describe(
    "Where cron results and restart notices land. For a DM this is the same as the user id. `/sethome` in a chat does the same thing but writes to gateway state; setting it here survives a state reset.",
  ),
  homeChannelName: z.string().min(1).describe(
    "Human label for the home channel, shown in the gateway UI.",
  ),
});

/** The sandbox, as nono will see it. */
const SandboxSchema = z.object({
  filesystemAllow: z.array(z.string()).default([]).describe(
    "Absolute paths granted IN ADDITION to $WORKDIR. Every entry widens the blast radius of a prompt injection — a bot that can read a directory can be made to read it. Empty is the default and the safe answer.",
  ),
  egress: z.array(z.string()).min(1).default(["*"]).describe(
    'Domains the bot may reach. `["*"]` is unrestricted. A named list is the exfiltration leg of the lethal trifecta: a bot with deep data access should have a short list here, because that is what an injected prompt needs and cannot get.',
  ),
  openPorts: z.array(z.number().int().min(1).max(65535)).default([]).describe(
    "Loopback ports the bot may reach. Under `nono run` this is enforced for connect as well as bind, so it is a real allowlist: a bot with [] cannot reach any local service, including another bot's credential-holding MCP. It is NOT enforced under `nono wrap`, which leaves the whole network block inert — which is why every entrypoint uses run.",
  ),
});

/** A host-side MCP this bot expects to find on loopback.
 *
 * MCPs are declared here rather than spawned, and that is load-bearing: nono's
 * confinement is inherited by child processes, so an MCP the gateway spawned
 * would run inside the sandbox and lose both the credential it exists to hold
 * and its network. Every one is a long-lived HTTP server started outside the
 * box by its own launchd job. */
const McpSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/).describe(
    "Service name, e.g. `gh-gate`. Becomes the launchd label suffix.",
  ),
  port: z.number().int().min(1).max(65535).describe(
    "Loopback port it listens on.",
  ),
});

const ChatSchema = z.object({
  workIn: z.string().min(1).describe(
    "Directory the terminal session starts in. May use $HOME. nono's --workdir stays the bot's workdir regardless, so this must be a path the profile already grants.",
  ),
  workInEnvVar: z.string().regex(/^[A-Z][A-Z0-9_]*$/).describe(
    "Environment variable that overrides workIn at invocation time.",
  ),
});

/** Prose that would otherwise be lost.
 *
 * Rendering hand-written launchers from a declaration destroys their comments,
 * and in this codebase the comments are the most valuable thing in the file:
 * why this bot's vault is separate, why its Hugging Face cache is staged
 * instead of downloaded, why it has no port-wait loop. Each key is rendered as
 * a comment above the block it explains. */
/** A `swamp serve` on loopback this bot may run workflows against.
 *
 * The same split as an MCP, with grants instead of a tool list: serve runs on
 * the host and resolves the vault there, so the bot holds a server token for
 * its own principal and never the credentials its workflows use. What that
 * principal may run is decided by the serving repo's grants/, not here.
 *
 * Three secrets cross into the sandbox, all scoped to that purpose: the server
 * token, and a swamp-club collective token plus its sign-in proof, because the
 * swamp CLI refuses to run at all without a club credential — even when every
 * step executes on the serve. Mint the collective token with the narrowest
 * scope there is (`extensions:read`); the CLI only needs it to exist. */
const SwampSchema = z.object({
  serverPort: z.number().int().min(1).max(65535).describe(
    "Loopback port of the swamp serve. Must also be in sandbox.openPorts.",
  ),
  // Each field is the NAME of a key in the bot's vault, not the secret: the
  // launcher reads the value from the vault at start. Nothing here is sensitive.
  secretKeys: z.object({
    // swamp-quality-ignore credentials-sensitive-field
    serverToken: z.string().default("swamp-server-token"),
    // swamp-quality-ignore credentials-sensitive-field
    apiKey: z.string().default("swamp-api-key"),
    // swamp-quality-ignore credentials-sensitive-field
    signinToken: z.string().default("swamp-signin-token"),
  }).default({
    serverToken: "swamp-server-token",
    apiKey: "swamp-api-key",
    signinToken: "swamp-signin-token",
  }).describe(
    "Which KEYS in the bot's vault hold the server token (`swamp access token mint`), the collective API token and its sign-in proof (`swamp auth token create`).",
  ),
});

const NotesSchema = z.object({
  vault: z.string().optional(),
  telegram: z.string().optional(),
  homeChannel: z.string().optional(),
  funes: z.string().optional(),
  network: z.string().optional(),
}).default({});

export const BotSchema = z.object({
  slug: z.string().regex(
    /^[a-z][a-z0-9-]{0,31}$/,
    "lowercase, starts with a letter, max 32 chars",
  ).describe(
    "Short name. Names the workdir, the profile, the launcher, and the launchd label, so it is the one field that cannot change without renaming everything.",
  ),
  displayName: z.string().min(1).describe(
    "The bot's name as a person says it, e.g. `Beta Unit`.",
  ),
  summary: z.string().min(1).describe(
    "One line describing what this bot's sandbox does. Becomes the nono profile description.",
  ),
  rationale: z.string().nullable().default(null).describe(
    "Why this bot exists and why its boundaries are shaped this way. Rendered as the launcher's header comment.",
  ),

  workdirRoot: z.string().default("$HOME/agents").describe(
    "Parent of every bot workdir. The workdir is `<workdirRoot>/<slug>` and is the ONLY path the sandbox grants by default.",
  ),

  vault: z.string().min(1).describe(
    "Swamp vault holding this bot's secrets. One vault per bot: the point of separate runtimes is that a work credential and a personal one are never reachable from the same place.",
  ),
  secretKeys: z.object({
    anthropic: z.string().default("anthropic-key"),
    telegram: z.string().default("telegram-bot-token"),
  }).default({
    anthropic: "anthropic-key",
    telegram: "telegram-bot-token",
  })
    .describe(
      "Which KEY in the vault holds each secret — never the secret itself. Values are resolved at launch by the entrypoint and held in process memory; nothing lands on disk.",
    ),

  telegram: TelegramSchema,
  sandbox: SandboxSchema,

  /** What the agent runs on. Only what a starter config.yaml needs: once
   * provision has written that file, Hermes owns it and this block stops being
   * consulted, so it is a seed rather than a source of truth. */
  runtime: z.object({
    provider: z.string().default("anthropic").describe(
      "Model provider for `model.provider` in the starter config.yaml.",
    ),
    model: z.string().default("anthropic/claude-opus-5").describe(
      "Default model id.",
    ),
    fallback: z.array(z.object({
      provider: z.string(),
      model: z.string(),
    })).default([]).describe(
      "Providers to fall back to, in order. A second provider is what keeps a gateway answering through one vendor's outage.",
    ),
    skin: z.string().nullable().default(null).describe(
      "Hermes display skin, if this bot has one.",
    ),
  }).default({
    provider: "anthropic",
    model: "anthropic/claude-opus-5",
    fallback: [],
    skin: null,
  }),

  /** Which Hermes this bot runs.
   *
   * In the declaration rather than a `provision` flag, because it is a
   * property of the bot and a flag is a thing someone has to remember. It was
   * a flag once, and the three bots on this host silently ended up on three
   * different commits of two different repositories — which nothing reported,
   * because nothing recorded what they were supposed to be on.
   *
   * NOT named `hermesRepo`/`hermesRef` to match provision's arguments: swamp
   * merges globalArguments into a method's arguments and the GLOBAL value
   * wins, so identical names would make the arguments impossible to override.
   * See the note on RestartArgs in hermes.ts.
   */
  agent: z.object({
    repo: z.string().min(1).default(
      "https://github.com/NousResearch/hermes-agent.git",
    ).describe("Where the agent comes from."),
    ref: z.string().min(1).default("main").describe(
      "Branch or tag to check out. Cloned shallow, so this is a branch or tag and not an arbitrary commit.",
    ),
  }).default({
    repo: "https://github.com/NousResearch/hermes-agent.git",
    ref: "main",
  }),

  funes: z.object({
    hfOffline: z.boolean().default(false).describe(
      "Set HF_HUB_OFFLINE=1. Use when the egress allowlist does not include huggingface.co and the embedding cache is staged from elsewhere — failing loudly beats reaching for a domain the sandbox will refuse.",
    ),
  }).default({ hfOffline: false }),

  mcps: z.array(McpSchema).default([]).describe(
    "Host-side MCP servers this gateway waits for at startup.",
  ),

  swamp: SwampSchema.nullable().default(null).describe(
    "A swamp serve this bot runs workflows against, or null for none.",
  ),

  /** State this bot accumulated that provision did not create.
   *
   * Everything provision builds is rebuildable by definition, and everything in
   * the standard tree is known. What is left is whatever a particular agent
   * grew for itself — Beta's curated `knowledge/`, for instance — and
   * nothing but the declaration knows it is there. A path missed here is a path
   * that does not survive a move to a new machine, and nothing reports its
   * absence, because nothing knew to expect it.
   */
  state: z.object({
    extraPaths: z.array(z.string()).default([]).describe(
      "Workdir-relative paths, beyond the standard tree, that `snapshot` must carry. Directories are taken whole. Leave empty unless this bot writes somewhere provision does not create.",
    ),
  }).default({ extraPaths: [] }),

  entrypoints: z.array(z.enum(["gateway", "chat"])).min(1).default(["gateway"])
    .describe(
      "Which launchers to render. Every entrypoint sources the same environment library, so a terminal session cannot drift into being the same agent with different boundaries.",
    ),
  chat: ChatSchema.optional(),

  notes: NotesSchema,
});
export type Bot = z.infer<typeof BotSchema>;

/**
 * Cross-field checks, deliberately NOT a `superRefine` on BotSchema.
 *
 * Swamp calls `.partial()` on a model's globalArguments schema so a method run
 * can override individual fields, and zod refuses `.partial()` on a refined
 * object ("cannot be used on object schemas containing refinements"). So the
 * schema stays a plain object and the relationships between fields are checked
 * here, by every method that acts on a declaration.
 *
 * Each of these is a mistake that is otherwise found at runtime, in a log file,
 * usually at night.
 */
export function crossCheck(b: Bot): string[] {
  const problems: string[] = [];

  // Landlock grants add up. An allowed path that contains the runtimes — the
  // home directory, workdirRoot — or sits inside them makes this bot's code
  // writable again, and another bot's with it. Compared as written, so a
  // different spelling of the same directory is not caught here; `verify`
  // proves the runtime unwritable from inside regardless.
  const runtimes = `${b.workdirRoot}/.runtime`;
  for (const p of b.sandbox.filesystemAllow) {
    const path = p.replace(/\/+$/, "");
    if (
      runtimes === path || runtimes.startsWith(`${path}/`) ||
      path.startsWith(`${runtimes}/`)
    ) {
      problems.push(
        `sandbox.filesystemAllow grants ${p}, which covers ${runtimes}. That makes the code this bot runs writable, and provision runs it on the host. Grant a narrower path.`,
      );
    }
  }

  // A gateway whose MCP port the profile never opened starts with no tools at
  // all: the entrypoint waits, warns into a log nobody reads, and starts
  // anyway. The port and the MCP have to be declared together.
  const open = new Set(b.sandbox.openPorts);
  for (const m of b.mcps) {
    if (!open.has(m.port)) {
      problems.push(
        `MCP '${m.name}' listens on ${m.port} but sandbox.openPorts does not include it. Add the port and the MCP together, or the gateway starts toolless.`,
      );
    }
  }

  // Same failure as an undeclared MCP port, quieter: every swamp command from
  // inside the box fails to connect, and the bot reports swamp as down.
  if (b.swamp && !open.has(b.swamp.serverPort)) {
    problems.push(
      `swamp serve is on ${b.swamp.serverPort} but sandbox.openPorts does not include it. Add the port with the swamp block.`,
    );
  }

  // A named egress allowlist puts nono into proxy mode, and on Linux that proxy
  // denies direct loopback connect even to a port in `open_port` — measured on
  // kernel 7.2.5 with nono 0.78.0, and not fixable with `--open-port` or
  // `--allow-connect-port`. So these two cannot both be satisfied, and a
  // profile promising both would produce a gateway that parks every MCP and
  // reports Permission denied against a server that is plainly running.
  if (!b.sandbox.egress.includes("*") && b.sandbox.openPorts.length > 0) {
    problems.push(
      `sandbox has a named egress allowlist (${
        b.sandbox.egress.join(", ")
      }) AND open ports (${
        b.sandbox.openPorts.join(", ")
      }). nono serves a named allowlist through its proxy, and on Linux that denies direct loopback connect even to a declared port, so the MCPs behind those ports would be unreachable. Pick one: unrestricted egress with loopback MCPs, or a narrow allowlist with none.`,
    );
  }

  if (b.entrypoints.includes("chat") && !b.chat) {
    problems.push(
      "entrypoints includes 'chat' but no chat block is declared.",
    );
  }

  // A snapshot path is resolved against the workdir and handed to tar. An
  // absolute one would silently pull in a path from outside the bot entirely,
  // and `..` would do the same more quietly.
  for (const p of b.state.extraPaths) {
    if (p.startsWith("/") || p.startsWith("$")) {
      problems.push(
        `state.extraPaths entry '${p}' is absolute. These are workdir-relative: an absolute path would snapshot something that is not this bot's.`,
      );
    }
    if (p.split("/").includes("..")) {
      problems.push(
        `state.extraPaths entry '${p}' escapes the workdir with '..'.`,
      );
    }
  }

  // nono resolves a relative grant against nothing, so it silently grants
  // nothing — the worst possible failure for a filesystem boundary.
  for (const p of b.sandbox.filesystemAllow) {
    if (!p.startsWith("/") && !p.startsWith("$")) {
      problems.push(
        `filesystemAllow entry '${p}' is not absolute. nono resolves these against nothing, so a relative grant silently grants nothing.`,
      );
    }
  }

  return problems;
}

/** The workdir this bot is confined to. */
export function workdirOf(b: Bot): string {
  return `${b.workdirRoot}/${b.slug}`;
}

/**
 * Where this bot's code lives: the Hermes checkout and venv, its interpreter,
 * and the staged tools. A sibling of the workdirs rather than a directory in
 * one, because the sandbox grants the workdir read-write and Landlock can only
 * add access, never carve a read-only directory out of a writable one.
 *
 * The bot gets this read-only. Provision runs what is here on the host, as the
 * operator, so a bot able to write it could plant code that runs outside its
 * sandbox the next time anyone provisions.
 */
export function runtimeOf(b: Bot): string {
  return `${b.workdirRoot}/.runtime/${b.slug}`;
}

/** The environment variable that overrides the workdir, e.g. STUART_HOME. */
export function homeEnvVar(b: Bot): string {
  return `${b.slug.toUpperCase().replace(/-/g, "_")}_HOME`;
}

/** The launchd label for this bot's gateway. */
export function gatewayLabel(b: Bot): string {
  return `sh.${b.slug}.gateway`;
}
