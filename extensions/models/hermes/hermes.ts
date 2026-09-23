// @skunk-ape/hermes/bot — one sandboxed Hermes agent, declared rather than
// hand-assembled.
//
// A bot on this pattern is a handful of files that have to agree with each
// other: a nono profile, a launcher that resolves secrets and applies that
// profile, a sourced environment library, and a service definition for whatever
// supervises it — a launchd plist on macOS, a systemd user unit on Linux, and
// both are rendered on both platforms. Written by hand they drift, and the
// drift is quiet — a profile description that no longer matches what the
// profile does, an MCP port opened in one file and forgotten in another, a
// launcher that says `nono wrap` and therefore enforces none of the network
// block it appears to configure.
//
// So the declaration is the source of truth and those files are output.
// Everything invariant lives in the templates: HERMES_HOME and the uv/npm cache
// redirections, TERMINAL_CWD, the Funes paths, the XDG exports deferred into
// the inner shell, and `nono run`. Every one of those is a scar. None of them
// is a per-bot decision, and none of them should have to be rediscovered.
//
//   scaffold   Write a starter declaration for a NEW bot, with every field a
//              person has to decide left where they will see it.
//
//   render     Write those files, or with `check: true` report what would
//              change and write nothing. The check mode is the drift detector:
//              it is what tells you someone edited a generated launcher by hand.
//
//   provision  Build the workdir payload: the directory tree, the Hermes
//              checkout and its venv on an interpreter installed INSIDE the
//              workdir, the staged funes binary and its index hook, and a
//              starter config.yaml and SOUL.md. Idempotent, and it never
//              overwrites anything the runtime owns.
//
//   verify     Run a probe INSIDE the sandbox, built from this bot's own
//              declaration, and report what the boundary actually enforces. A
//              probe that could not prove anything reports VACUOUS, never PASS.
//
//   install    Substitute the unit placeholders into the platform's unit
//              directory and load every service this bot owns, MCPs before
//              gateway. Refuses first on a host that cannot enforce the
//              boundary the declaration describes.
//
//   uninstall  Boot the services out and remove their plists. Never touches
//              the workdir: the memory outlives the deployment.
//
//   status     What is actually running: launchd state and pid per service,
//              whether each MCP port answers, and whether the gateway holds a
//              live session to it. Writes the data a fleet report reads.
//
//   restart    Bounce the MCPs, wait for their ports, bounce the gateway, then
//              confirm the sessions came back. Restarting an MCP alone is not
//              enough and this method is the reason nobody has to remember why.
//
// The artifacts are committed to the repository rather than rendered at boot.
// They are security artifacts, so a reviewer needs to read the real file, and
// a renderer in the boot path would mean one bad render takes every bot down
// at once.

import { z } from "npm:zod@4";
import {
  BotSchema,
  crossCheck,
  gatewayLabel,
  homeEnvVar,
  workdirOf,
} from "./_lib/decl.ts";
import type { Bot } from "./_lib/decl.ts";
import { renderBot } from "./_lib/render.ts";
import type { RenderedFile } from "./_lib/render.ts";
import {
  gatewayLabelFor,
  hasLiveSession,
  mcpLabelFor,
  portOpen,
  run,
  sleep,
  substitutePlaceholders,
  unresolvedPlaceholders,
  waitPort,
  which,
} from "./_lib/proc.ts";
import { hostFacts } from "./_lib/host.ts";
import type { HostFacts } from "./_lib/host.ts";
import type { ServiceState } from "./_lib/supervisor.ts";
import {
  buildProbe,
  deniedPaths,
  parseProbeOutput,
  probePath,
  summarize,
} from "./_lib/verify.ts";
import type { Check, ForeignPort, PathCheck } from "./_lib/verify.ts";
import {
  decideFile,
  directories,
  resolvedWorkdir,
  uvEnv,
  uvSteps,
  workdirFiles,
} from "./_lib/provision.ts";
import { scaffoldYaml } from "./_lib/scaffold.ts";
import {
  carriedPaths,
  checkpointables,
  EXCLUDES,
  rebuiltPaths,
  residualMentions,
  rewritable,
  rewritePrefix,
} from "./_lib/migrate.ts";

// Deno is available in the swamp model host. Declared so the type checker does
// not need --unstable for the namespace.
// deno-lint-ignore no-explicit-any
declare const Deno: any;

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

type Logger = {
  info: (msg: string, props?: Record<string, unknown>) => void;
  warning: (msg: string, props?: Record<string, unknown>) => void;
};
type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Digest of a file's bytes. Separate from sha256() because a 180MB binary
 * must not be decoded to text first. */
async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  // Cast rather than copy: this hashes a 180MB binary and a second copy of it
  // in memory is a real cost for no benefit.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/** What is on disk now, or null when nothing is. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "." : path.slice(0, i);
}

/** Every regular file under a root, as paths relative to it.
 *
 * Symlinks are not followed and not recreated. Nothing in a snapshot is
 * supposed to be one — the workdir's only symlink is `.hermes`, which provision
 * rebuilds — and following one out of the staging directory would write
 * wherever it pointed on the machine the archive came from.
 */
async function* walkFiles(root: string, prefix = ""): AsyncGenerator<string> {
  for await (const e of Deno.readDir(prefix ? `${root}/${prefix}` : root)) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) {
      yield* walkFiles(root, rel);
    } else if (e.isFile) {
      yield rel;
    }
  }
}

/** Do two files hold the same bytes? Used to tell a genuine conflict from a
 * re-run, which must stay quiet or nobody will re-run it. */
async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([Deno.readFile(a), Deno.readFile(b)]);
    if (x.length !== y.length) return false;
    return await sha256Bytes(x) === await sha256Bytes(y);
  } catch {
    return false;
  }
}

type Status = "created" | "updated" | "unchanged";

type FileOutcome = {
  path: string;
  kind: string;
  status: Status;
  sha256: string;
  /** Digest of what was on disk before, when it differed. */
  previousSha256: string | null;
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

type MethodCtx = {
  globalArgs: Bot;
  repoDir: string;
  logger: Logger;
  signal: AbortSignal;
  writeResource: WriteResource;
};

const InstallArgs = z.object({
  stageOnly: z.boolean().default(false).describe(
    "Write the unit files into the platform's unit directory (~/Library/LaunchAgents, or ~/.config/systemd/user) but do not load them. Use when installing on a machine you are not ready to start the bot on.",
  ),
  ignorePreflight: z.boolean().default(false).describe(
    "Install even though the host reported a blocking problem. The Linux problems are a kernel too old for Landlock's network rules (open_port and allow_domain silently enforce nothing) and a user manager without lingering (every bot stops at logout). Both produce a deployment that reports healthy while enforcing less than it claims, which is why they block by default. Set this only when you have read the specific problem and decided to accept it.",
  ),
});
type InstallArgs = z.infer<typeof InstallArgs>;

// The argument is `only`, not `mcps`, and the name is not cosmetic: swamp
// merges globalArguments into a method's arguments, so a method argument that
// shares a name with a global argument receives the GLOBAL value. Naming this
// `mcps` made every run fail with "expected string, received object" — the
// declaration's own MCP list arriving where a list of names was expected.
const RestartArgs = z.object({
  only: z.array(z.string()).default([]).describe(
    "Which MCPs to bounce by name. Empty means all of them. The gateway is ALWAYS restarted regardless — Hermes parks an MCP whose connection drops and does not retry until a reconnect is requested, so bouncing a server on its own leaves the gateway holding a dead handle and the agent reporting it cannot reach something that is plainly running.",
  ),
});
type RestartArgs = z.infer<typeof RestartArgs>;

const VerifyArgs = z.object({
  probePort: z.number().int().min(1024).max(65535).default(9099).describe(
    "An unlisted loopback port to bind a real listener on before probing. Without a listener the loopback check proves nothing — a closed port refuses the connection whether or not the sandbox blocks it — and reports VACUOUS instead.",
  ),
  deniedHost: z.string().default("example.com").describe(
    'A host outside every bot\'s allowlist, used to prove the egress denial actually denies. Only meaningful for a bot whose egress is not ["*"].',
  ),
  foreignPorts: z.array(z.object({
    port: z.number().int().min(1).max(65535),
    label: z.string().default(""),
  })).default([]).describe(
    "Loopback services on this host that belong to somebody else — typically another bot's credential-holding MCPs. Ports this bot declares are skipped, and so are ports with nothing listening: only a live listener can answer the loopback question, since a closed port refuses the connection either way. Empty means the probe asks about no foreign ports at all, which is the honest default on a machine this type knows nothing about.",
  ),
});
type VerifyArgs = z.infer<typeof VerifyArgs>;

const ProvisionArgs = z.object({
  check: z.boolean().default(false).describe(
    'Report what is missing and change nothing. The honest answer to "is this workdir complete?", which `status` can only approximate from the outside.',
  ),
  hermesRepo: z.string().default("").describe(
    "Override the declaration's agent.repo for this run. Empty means use the declaration, which is where this belongs: a bot's Hermes is a property of the bot, not of the person who last ran provision.",
  ),
  hermesRef: z.string().default("").describe(
    "Override the declaration's agent.ref for this run. Empty means use the declaration. Cloned shallow, so a branch or tag, not an arbitrary commit.",
  ),
  pythonVersion: z.string().default("3.11").describe(
    "Interpreter version uv installs INSIDE the workdir. Never the host's: uv's pythons resolve sys.prefix back to their install path, so a copied interpreter cannot run from anywhere else.",
  ),
  seedHfFrom: z.string().default("").describe(
    "Slug of a sibling bot whose Hugging Face embedding cache to copy. A bot with a named egress allowlist cannot download it, and widening the allowlist for a one-time fetch is the wrong trade. Empty means do not seed.",
  ),
  funesBin: z.string().default("$HOME/.local/bin/funes").describe(
    "Host funes binary to stage into tools/. Staged rather than shared so a bot's memory tooling cannot change under it when the host's copy updates.",
  ),
  skipDeps: z.boolean().default(false).describe(
    "Create the venv but do not sync dependencies. For a fast structural test of everything around the slowest step.",
  ),
});
type ProvisionArgs = z.infer<typeof ProvisionArgs>;

const ScaffoldArgs = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).describe(
    "Slug of the NEW bot. Names its workdir, profile, launcher and launchd label.",
  ),
  displayName: z.string().default("").describe(
    "The new bot's name as a person says it. Defaults to the slug, capitalized.",
  ),
  vault: z.string().default("").describe(
    "Swamp vault for its secrets. Defaults to `<slug>-secrets`. One vault per bot is the point: a work credential and a personal one are never reachable from the same place.",
  ),
  force: z.boolean().default(false).describe(
    "Overwrite an existing declaration. Off by default — a declaration is hand-edited after scaffolding, and that edit is the valuable part.",
  ),
});
type ScaffoldArgs = z.infer<typeof ScaffoldArgs>;

const SnapshotArgs = z.object({
  out: z.string().default("").describe(
    "Where to write the archive. Empty means `<repo>/snapshots/<slug>-<timestamp>.tar.gz`.",
  ),
  includeHfCache: z.boolean().default(false).describe(
    "Carry funes/hf as well. It is 1.2GB, architecture-independent, and re-obtainable — by download for a bot with open egress, and by `provision --input seedHfFrom=<sibling>` for one whose allowlist forbids huggingface.co. Off by default because including it makes the archive roughly forty times larger to save a step that already exists.",
  ),
  force: z.boolean().default(false).describe(
    "Snapshot even though the gateway is still running. Off by default: state.db is written on every turn, and an archive taken mid-write carries a torn database. Stop the bot instead.",
  ),
});
type SnapshotArgs = z.infer<typeof SnapshotArgs>;

const RestoreArgs = z.object({
  archive: z.string().describe(
    "Path to the archive written by `snapshot` on the other machine.",
  ),
  fromHome: z.string().default("").describe(
    "The HOME the snapshot was taken under, e.g. /Users/x. Every mention of `<fromHome>/agents/<slug>` in the files that are read to decide what to do — config.yaml above all — is rewritten to this host's workdir. Leave empty ONLY when both hosts share a home path: without it a restored config.yaml points the funes MCP at a directory that does not exist, and the gateway comes up healthy with no memory tool and nothing to say about it.",
  ),
  force: z.boolean().default(false).describe(
    "Overwrite files that already exist and differ. Off by default, so restoring onto a workdir that has already been used reports the conflicts instead of silently resolving them.",
  ),
});
type RestoreArgs = z.infer<typeof RestoreArgs>;

const RenderArgs = z.object({
  check: z.boolean().default(false).describe(
    "Report what would change and write nothing. Use this to detect a generated file that has been edited by hand — the failure mode that makes a declaration stop being the source of truth.",
  ),
  outputDir: z.string().default("").describe(
    "Where to write, relative to the repository root. Empty means the repository root itself, which is what an ops repo wants: profiles/, bin/ and launchd/ land in their usual places.",
  ),
});
type RenderArgs = z.infer<typeof RenderArgs>;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const RenderedSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  renderedAt: z.string(),
  checkOnly: z.boolean(),
  /** True when every file on disk already matched. In check mode this is the
   * whole answer: false means something drifted. */
  clean: z.boolean(),
  workdir: z.string(),
  homeEnvVar: z.string(),
  gatewayLabel: z.string(),
  vault: z.string(),
  /** A flat summary of the boundary, so a fleet report can compare bots
   * without re-reading and re-parsing every nono profile. */
  egress: z.array(z.string()),
  egressUnrestricted: z.boolean(),
  extraFilesystemGrants: z.array(z.string()),
  openPorts: z.array(z.number()),
  mcps: z.array(z.object({ name: z.string(), port: z.number() })),
  entrypoints: z.array(z.string()),
  files: z.array(z.object({
    path: z.string(),
    kind: z.string(),
    status: z.string(),
    sha256: z.string(),
    previousSha256: z.string().nullable(),
  })),
  changedCount: z.number(),
});

const ProvisionedSchema = z.object({
  slug: z.string(),
  provisionedAt: z.string(),
  checkOnly: z.boolean(),
  /** True when nothing had to be done: every step found what it needed. */
  complete: z.boolean(),
  workdir: z.string(),
  hermesRepo: z.string(),
  hermesRef: z.string(),
  hermesHead: z.string().nullable(),
  pythonVersion: z.string(),
  venvPython: z.string().nullable(),
  /** The staged binary's digest beside the host's. They drift the moment the
   * host updates, and a bot running an old memory tool while the host runs a
   * new one is worth being able to see. */
  funesStagedSha256: z.string().nullable(),
  funesHostSha256: z.string().nullable(),
  funesMatchesHost: z.boolean(),
  steps: z.array(z.object({
    name: z.string(),
    status: z.string(),
    detail: z.string(),
  })),
  missingCount: z.number(),
});

const SnapshotSchema = z.object({
  slug: z.string(),
  takenAt: z.string(),
  archive: z.string(),
  bytes: z.number(),
  sha256: z.string(),
  /** The HOME and workdir it was taken under. `restore` needs both, and a
   * person reading the archive months later needs them more. */
  fromHome: z.string(),
  fromWorkdir: z.string(),
  includeHfCache: z.boolean(),
  gatewayWasRunning: z.boolean(),
  checkpointed: z.array(z.string()),
  carried: z.array(z.object({
    path: z.string(),
    why: z.string(),
    present: z.boolean(),
  })),
  /** Named so the report can answer "why is this 30MB when the workdir is 4GB"
   * without anyone reading the source. */
  leftBehind: z.array(z.object({ path: z.string(), why: z.string() })),
  missingCount: z.number(),
});

const RestoredSchema = z.object({
  slug: z.string(),
  restoredAt: z.string(),
  archive: z.string(),
  fromWorkdir: z.string(),
  toWorkdir: z.string(),
  /** True when everything landed and nothing still mentions the old host. */
  clean: z.boolean(),
  placed: z.array(z.object({
    path: z.string(),
    action: z.string(),
    rewrites: z.number(),
  })),
  conflicts: z.array(z.string()),
  /** Paths still naming the old host after the rewrite. Not necessarily wrong
   * — they may point at repositories that also moved — but never something to
   * discover later, from a symptom. */
  residual: z.array(
    z.object({ path: z.string(), mentions: z.array(z.string()) }),
  ),
});

const ServiceStateSchema = z.object({
  label: z.string(),
  kind: z.string(),
  loaded: z.boolean(),
  state: z.string().nullable(),
  pid: z.number().nullable(),
  lastExitStatus: z.number().nullable(),
});

const VerificationSchema = z.object({
  slug: z.string(),
  verifiedAt: z.string(),
  profile: z.string(),
  /** No FAILs. Vacuous checks do not fail a run — but they are not evidence
   * either, so they are counted where a reader will see them. */
  clean: z.boolean(),
  pass: z.number(),
  fail: z.number(),
  vacuous: z.number(),
  gap: z.number(),
  probePort: z.number(),
  checks: z.array(z.object({
    label: z.string(),
    outcome: z.string(),
    detail: z.string(),
  })),
});

const StatusSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  checkedAt: z.string(),
  /** True when every service is loaded and running and every declared MCP has
   * a live session. The single field a fleet report sorts on. */
  healthy: z.boolean(),
  problems: z.array(z.string()),
  services: z.array(ServiceStateSchema),
  ports: z.array(z.object({
    name: z.string(),
    port: z.number(),
    listening: z.boolean(),
    established: z.number(),
    liveSession: z.boolean(),
  })),
  workdir: z.string(),
  workdirPresent: z.boolean(),
  hermesPresent: z.boolean(),
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

type Service = {
  label: string;
  /** Path of the committed unit file for THIS host, relative to the repository
   * root: `launchd/<label>.plist` on macOS, `systemd/<label>.service` on Linux.
   * Both are committed for every bot; only one is installed. */
  unit: string;
  kind: "mcp" | "gateway";
  /** Loopback port, for an MCP. */
  port: number | null;
};

/**
 * Every service this bot owns, in start order.
 *
 * MCPs first. launchd has no ordering between jobs at all, and systemd's
 * `After=` orders starts rather than readiness, so on both platforms a gateway
 * can win the race and register no tools: Hermes parks an MCP that fails its
 * initial connection and does not retry until a reconnect is requested.
 *
 * The MCP unit files are hand-written — an MCP is a host service holding its
 * own credential, not a sandboxed bot, and nothing about it derives from a
 * sandbox declaration — but their labels follow the bot, so the declaration
 * still knows where to find them.
 */
function servicesOf(b: Bot, h: HostFacts): Service[] {
  const mcps: Service[] = b.mcps.map((m) => ({
    label: mcpLabelFor(b.slug, m.name),
    unit: h.supervisor.committedUnit(mcpLabelFor(b.slug, m.name)),
    kind: "mcp" as const,
    port: m.port,
  }));
  return [...mcps, {
    label: gatewayLabelFor(b.slug),
    unit: h.supervisor.committedUnit(gatewayLabelFor(b.slug)),
    kind: "gateway" as const,
    port: null,
  }];
}

type PortReport = {
  name: string;
  port: number;
  listening: boolean;
  established: number;
  liveSession: boolean;
};

/** What is true right now, for one bot. */
async function collectStatus(
  b: Bot,
  h: HostFacts,
  signal: AbortSignal,
): Promise<{ services: ServiceState[]; ports: PortReport[] }> {
  const services: ServiceState[] = [];
  for (const svc of servicesOf(b, h)) {
    services.push(await h.supervisor.state(svc.label, signal));
  }
  const ports: PortReport[] = [];
  for (const m of b.mcps) {
    const listening = await portOpen(m.port);
    const established = listening
      ? await h.supervisor.established(m.port, signal)
      : 0;
    ports.push({
      name: m.name,
      port: m.port,
      listening,
      established,
      liveSession: hasLiveSession(established),
    });
  }
  return { services, ports };
}

/** Whether a path exists at all. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Judge and record what was found.
 *
 * `healthy` is the one field a fleet report sorts on, so what feeds it is
 * deliberately narrow: every service loaded and running, and every declared MCP
 * holding a live session. A listening port is not enough — that is exactly the
 * state a parked MCP presents.
 */
async function writeStatus(
  ctx: MethodCtx,
  b: Bot,
  h: HostFacts,
  services: ServiceState[],
  ports: PortReport[],
): Promise<{ name: string }> {
  const svcKind = new Map(servicesOf(b, h).map((s) => [s.label, s.kind]));
  const problems: string[] = [];

  for (const s of services) {
    if (!s.loaded) problems.push(`${s.label} is not loaded`);
    else if (s.state !== "running") {
      problems.push(
        `${s.label} is ${s.state ?? "in an unknown state"}${
          s.lastExitStatus !== null ? ` (last exit ${s.lastExitStatus})` : ""
        }`,
      );
    }
  }
  for (const p of ports) {
    if (!p.listening) problems.push(`${p.name} is not listening on ${p.port}`);
    else if (!p.liveSession) {
      problems.push(
        `${p.name} is listening on ${p.port} but the gateway holds no live session to it — the shape of a parked MCP`,
      );
    }
  }

  const workdir = workdirOf(b).replace("$HOME", h.home);
  const workdirPresent = await exists(workdir);
  const hermesPresent = await exists(
    `${workdir}/hermes/hermes-agent/venv/bin/python`,
  );
  if (!workdirPresent) problems.push(`workdir ${workdir} does not exist`);
  else if (!hermesPresent) {
    problems.push(`no Hermes venv python under ${workdir}/hermes`);
  }

  return await ctx.writeResource("status", `status-${b.slug}`, {
    slug: b.slug,
    displayName: b.displayName,
    checkedAt: new Date().toISOString(),
    healthy: problems.length === 0,
    problems,
    services: services.map((s) => ({
      label: s.label,
      kind: svcKind.get(s.label) ?? "unknown",
      loaded: s.loaded,
      state: s.state,
      pid: s.pid,
      lastExitStatus: s.lastExitStatus,
    })),
    ports,
    workdir,
    workdirPresent,
    hermesPresent,
  });
}

// ---------------------------------------------------------------------------

/**
 * One sandboxed Hermes agent, declared rather than hand-assembled.
 *
 * The declaration is the source of truth and the nono profile, environment
 * library, entrypoints and service definitions are output. `scaffold` writes the
 * declaration, `provision` builds the workdir it will run in, `render` writes
 * the runtime, `install` loads it, `verify` proves what its sandbox actually
 * enforces, and `status`/`restart` are what you reach for when something is
 * wrong at two in the morning.
 *
 * macOS only, deliberately: launchd is macOS, and `nono run` versus `nono wrap`
 * is a macOS-proxy fact.
 */
export const model = {
  type: "@skunk-ape/hermes/bot",
  version: "2026.09.22.1",
  globalArguments: BotSchema,
  resources: {
    "rendered": {
      description:
        "What this bot's runtime looks like: the files that make it up, their digests, and a flat summary of the sandbox boundary for reporting.",
      schema: RenderedSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "verification": {
      description:
        "What this bot's sandbox actually enforces, probed from inside it: which paths are readable, which hosts are reachable, and which claims could not be proven either way.",
      schema: VerificationSchema,
      lifetime: "90d",
      garbageCollection: 20,
    },
    "provisioned": {
      description:
        "What this bot's workdir contains: the Hermes checkout and its ref, the interpreter and venv inside the workdir, the staged funes binary beside the host's, and which steps had to do work.",
      schema: ProvisionedSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "status": {
      description:
        "What is actually running for this bot: supervisor state per service, whether each MCP port answers, and whether the gateway holds a live session to it.",
      schema: StatusSchema,
      lifetime: "30d",
      garbageCollection: 50,
    },
    "snapshot": {
      description:
        "An archive of everything about this bot that a new machine cannot rebuild, and a record of what was deliberately left behind because provision will rebuild it.",
      schema: SnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "restored": {
      description:
        "What a snapshot put back on this machine: which files landed, how many absolute paths were rewritten from the old host, and which mentions of it survived.",
      schema: RestoredSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  files: {},
  methods: {
    scaffold: {
      description:
        "Write a starter declaration for a NEW bot: every field present, safe defaults filled in, and a comment on each decision a person has to make. It does not render or install anything — the declaration is meant to be edited first.",
      arguments: ScaffoldArgs,
      execute: async (args: ScaffoldArgs, ctx: MethodCtx) => {
        const path =
          `${ctx.repoDir}/models/@skunk-ape/hermes/bot/${args.slug}.yaml`;
        const existing = await readIfPresent(path);

        // Keep the id of a stub written by `swamp model create`, so scaffolding
        // an already-created model keeps its identity and its data lineage
        // instead of orphaning both.
        let id: string = crypto.randomUUID();
        if (existing) {
          const m = existing.match(/^id:\s*(\S+)\s*$/m);
          if (m) id = m[1];
          const hasArgs = /^globalArguments:\s*$/m.test(existing);
          if (hasArgs && !args.force) {
            throw new Error(
              `${args.slug}.yaml already has a filled-in declaration. Scaffolding over it would discard hand-written boundaries and notes — pass force: true if that is really what you want.`,
            );
          }
        }

        const displayName = args.displayName ||
          args.slug.charAt(0).toUpperCase() + args.slug.slice(1);
        const content = scaffoldYaml({
          slug: args.slug,
          displayName,
          vault: args.vault || `${args.slug}-secrets`,
          typeVersion: model.version,
          id,
        });

        await ensureDir(dirOf(path));
        await Deno.writeTextFile(path, content);

        ctx.logger.info("wrote models/@skunk-ape/hermes/bot/{slug}.yaml", {
          slug: args.slug,
        });
        // Named individually rather than as "edit the EDIT ME lines", because
        // the egress line is the one that matters and a list makes it hard to
        // skip past.
        ctx.logger.warning(
          "{slug} is NOT ready to render: sandbox.egress is empty, telegram.allowedUsers is empty, and summary/rationale say EDIT ME.",
          { slug: args.slug },
        );
        ctx.logger.info(
          "Then: swamp model method run {slug} render --input check=true, provision, install.",
          { slug: args.slug },
        );
        return {};
      },
    },

    // -----------------------------------------------------------------------
    render: {
      description:
        "Render this bot's nono profile, environment library, entrypoints and service definitions — a launchd plist and a systemd unit, both on both platforms — from the declaration. With `check: true`, report what would change and write nothing.",
      arguments: RenderArgs,
      execute: async (
        args: RenderArgs,
        ctx: {
          globalArgs: Bot;
          repoDir: string;
          logger: Logger;
          signal: AbortSignal;
          writeResource: WriteResource;
        },
      ) => {
        const b = ctx.globalArgs;

        // Relationships between fields, checked here rather than in the schema:
        // swamp calls .partial() on globalArguments and zod refuses that on a
        // refined object. Refusing to render is the right response — a bot
        // rendered from an inconsistent declaration is a bot that starts and
        // then does not work.
        const problems = crossCheck(b);
        if (problems.length > 0) {
          throw new Error(
            `${b.slug}: the declaration is inconsistent:\n  - ${
              problems.join("\n  - ")
            }`,
          );
        }

        const root = args.outputDir
          ? `${ctx.repoDir}/${args.outputDir.replace(/\/+$/, "")}`
          : ctx.repoDir;

        const files: RenderedFile[] = renderBot(b);
        const outcomes: FileOutcome[] = [];

        for (const f of files) {
          const abs = `${root}/${f.path}`;
          const existing = await readIfPresent(abs);
          const digest = await sha256(f.content);
          const status: Status = existing === null
            ? "created"
            : existing === f.content
            ? "unchanged"
            : "updated";

          if (status !== "unchanged" && !args.check) {
            await ensureDir(dirOf(abs));
            // Write to a neighbouring temp and rename, so a launchd job that
            // starts mid-render reads the old file or the new one and never a
            // half-written one.
            const tmp = `${abs}.rendering`;
            await Deno.writeTextFile(tmp, f.content);
            await Deno.chmod(tmp, f.mode);
            await Deno.rename(tmp, abs);
          }

          outcomes.push({
            path: f.path,
            kind: f.kind,
            status,
            sha256: digest,
            previousSha256: status === "updated" && existing !== null
              ? await sha256(existing)
              : null,
          });
        }

        const changed = outcomes.filter((o) => o.status !== "unchanged");
        const clean = changed.length === 0;

        for (const o of changed) {
          ctx.logger.info("{status} {path}", {
            status: args.check
              ? `would ${o.status.replace(/d$/, "")}`
              : o.status,
            path: o.path,
          });
        }

        if (args.check && !clean) {
          // Not an error: this method reports drift, it does not adjudicate it.
          // A generated file edited by hand is sometimes a fix that belongs in
          // the declaration, and finding out is the point.
          ctx.logger.warning(
            "{count} file(s) differ from the declaration for {slug}. Run render without check to overwrite, or move the change into the declaration.",
            { count: changed.length, slug: b.slug },
          );
        } else if (clean) {
          ctx.logger.info("{slug}: all {count} file(s) already match", {
            slug: b.slug,
            count: outcomes.length,
          });
        }

        // A bot whose only egress rule is "*" has no exfiltration boundary at
        // all. That is a legitimate choice for an agent with shallow data, and
        // exactly the wrong one for an agent with deep data — so it is recorded
        // as its own field rather than left for a reader to infer from a list.
        const unrestricted = b.sandbox.egress.includes("*");
        if (unrestricted && b.sandbox.filesystemAllow.length > 0) {
          ctx.logger.warning(
            "{slug} has unrestricted egress AND {n} filesystem grant(s) beyond its workdir. Deep data plus open egress is the shape an injected prompt needs.",
            { slug: b.slug, n: b.sandbox.filesystemAllow.length },
          );
        }

        const handle = await ctx.writeResource(
          "rendered",
          `rendered-${b.slug}`,
          {
            slug: b.slug,
            displayName: b.displayName,
            renderedAt: new Date().toISOString(),
            checkOnly: args.check,
            clean,
            workdir: workdirOf(b),
            homeEnvVar: homeEnvVar(b),
            gatewayLabel: gatewayLabel(b),
            vault: b.vault,
            egress: b.sandbox.egress,
            egressUnrestricted: unrestricted,
            extraFilesystemGrants: b.sandbox.filesystemAllow,
            openPorts: b.sandbox.openPorts,
            mcps: b.mcps,
            entrypoints: b.entrypoints,
            files: outcomes,
            changedCount: changed.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    provision: {
      description:
        "Build this bot's workdir payload: directory tree, Hermes checkout, an interpreter and venv INSIDE the workdir, the staged funes binary and its index hook, and a starter config.yaml and SOUL.md. Idempotent — every step skips what it finds, and nothing the runtime owns is ever overwritten.",
      arguments: ProvisionArgs,
      execute: async (args: ProvisionArgs, ctx: MethodCtx) => {
        const b = ctx.globalArgs;
        const problems = crossCheck(b);
        if (problems.length > 0) {
          throw new Error(
            `${b.slug}: the declaration is inconsistent:\n  - ${
              problems.join("\n  - ")
            }`,
          );
        }

        const h = hostFacts();
        const workdir = resolvedWorkdir(b, h.home);

        // The declaration says which Hermes this bot runs; the arguments only
        // override it for a one-off. That direction matters: as a flag, the
        // answer lived in whoever last typed the command, and the three bots on
        // the original host ended up on three different commits of two
        // different repositories with nothing recording that they had.
        const hermesRepo = args.hermesRepo || b.agent.repo;
        const hermesRef = args.hermesRef || b.agent.ref;
        const agentDir = `${workdir}/hermes/hermes-agent`;
        const venvPy = `${agentDir}/venv/bin/python`;
        const env = { ...Deno.env.toObject(), ...uvEnv(workdir) };

        // What was here BEFORE this run touched anything.
        //
        // `funes add hermes` and the Hermes CLI it drives write a default
        // config.yaml and SOUL.md of their own as a side effect. Those are
        // boilerplate this method caused, not state a person or a runtime
        // owns, and treating them as untouchable is how the first probe run
        // ended up with funes' generic config — a bare `command: funes` that
        // depends on PATH, with none of this bot's own funes environment —
        // instead of the one derived from the declaration.
        //
        // So the rule is narrower than "never overwrite": provision never
        // overwrites what it FOUND, and does own what its own steps produced.
        const preexisting = new Set<string>();
        for (const f of workdirFiles(b, workdir)) {
          if (await exists(`${workdir}/${f.path}`)) preexisting.add(f.path);
        }

        type Step = { name: string; status: string; detail: string };
        const steps: Step[] = [];
        const say = (name: string, status: string, detail = ""): void => {
          steps.push({ name, status, detail });
          const line = detail ? `${name} — ${detail}` : name;
          if (status === "missing") {
            ctx.logger.warning("MISSING  {line}", { line });
          } else {ctx.logger.info("{status} {line}", {
              status: status.padEnd(8),
              line,
            });}
        };
        // In check mode every step reports and none of them acts. `missing` is
        // therefore the whole answer, and it is counted rather than inferred.
        const wouldChange = (name: string, detail: string): boolean => {
          if (args.check) {
            say(name, "missing", detail);
            return true;
          }
          return false;
        };

        // -- the tree ------------------------------------------------------
        const absent: string[] = [];
        for (const d of directories(b)) {
          if (!await exists(`${workdir}/${d}`)) absent.push(d);
        }
        if (absent.length === 0) {
          say("directories", "present", `all ${directories(b).length} present`);
        } else if (
          !wouldChange(
            "directories",
            `${absent.length} to create: ${absent.join(", ")}`,
          )
        ) {
          for (const d of absent) await ensureDir(`${workdir}/${d}`);
          say("directories", "created", absent.join(", "));
        }

        // -- .hermes -------------------------------------------------------
        // Hermes runs post_llm_call hooks with the REAL home, and funes
        // resolves its session db from $HOME/.hermes. The hook rewrites HOME to
        // the workdir; this symlink is what makes that point somewhere real.
        const dotHermes = `${workdir}/.hermes`;
        if (await exists(dotHermes)) {
          say(".hermes symlink", "present");
        } else if (!wouldChange(".hermes symlink", `-> ${workdir}/hermes`)) {
          await Deno.symlink(`${workdir}/hermes`, dotHermes);
          say(".hermes symlink", "created", `-> ${workdir}/hermes`);
        }

        // -- the checkout --------------------------------------------------
        let head: string | null = null;
        if (await exists(`${agentDir}/.git`)) {
          const r = await run(
            "git",
            ["-C", agentDir, "rev-parse", "HEAD"],
            ctx.signal,
          );
          head = r.code === 0 ? r.stdout.trim() : null;
          say(
            "hermes-agent",
            "present",
            `${hermesRef} at ${head?.slice(0, 12) ?? "unknown"}`,
          );
        } else if (
          !wouldChange(
            "hermes-agent",
            `clone ${hermesRepo} @ ${hermesRef}`,
          )
        ) {
          // Shallow: this is a runtime, not a place to do git archaeology, and
          // a full history is several hundred megabytes per bot.
          const r = await run("git", [
            "clone",
            "--depth",
            "1",
            "--branch",
            hermesRef,
            hermesRepo,
            agentDir,
          ], ctx.signal);
          if (r.code !== 0) {
            throw new Error(
              `clone failed: ${
                (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")
              }`,
            );
          }
          const rev = await run(
            "git",
            ["-C", agentDir, "rev-parse", "HEAD"],
            ctx.signal,
          );
          head = rev.code === 0 ? rev.stdout.trim() : null;
          say(
            "hermes-agent",
            "created",
            `${hermesRef} at ${head?.slice(0, 12) ?? "unknown"}`,
          );
        }

        const uv = uvSteps(agentDir, args.pythonVersion);

        // -- the interpreter, INSIDE the workdir ---------------------------
        // The one that bites on a fresh install. Copying a uv interpreter in
        // does not work: uv's pythons resolve sys.prefix back to their original
        // install path, so it has to be installed here in the first place.
        const pythonDir = `${workdir}/hermes/python`;
        let havePython = false;
        try {
          for await (const e of Deno.readDir(pythonDir)) {
            if (e.name.startsWith("cpython-")) havePython = true;
          }
        } catch { /* the directory may not exist yet */ }
        if (havePython) {
          say(
            "interpreter",
            "present",
            `cpython ${args.pythonVersion} under hermes/python`,
          );
        } else if (
          !wouldChange(
            "interpreter",
            `uv python install ${args.pythonVersion} into hermes/python`,
          )
        ) {
          const r = await run("uv", uv.install, ctx.signal, {
            env,
            cwd: workdir,
          });
          if (r.code !== 0) {
            throw new Error(
              `uv python install failed: ${
                (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")
              }`,
            );
          }
          say(
            "interpreter",
            "created",
            `cpython ${args.pythonVersion} in hermes/python`,
          );
        }

        // -- the venv ------------------------------------------------------
        if (await exists(venvPy)) {
          say("venv", "present");
        } else if (
          !wouldChange("venv", `uv venv on python ${args.pythonVersion}`)
        ) {
          const r = await run("uv", uv.venv, ctx.signal, {
            env,
            cwd: agentDir,
          });
          if (r.code !== 0) {
            throw new Error(
              `uv venv failed: ${
                (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")
              }`,
            );
          }
          say("venv", "created");
        }

        // -- dependencies --------------------------------------------------
        // Importing the CLI is the test, not the presence of a directory: a
        // half-finished sync leaves a venv that exists and cannot start a
        // gateway.
        // The cwd is deliberately NOT the checkout. Run from inside it and
        // `import hermes_cli` resolves from the source tree next door and
        // succeeds against a venv with nothing in it at all — which is how the
        // first probe run reported dependencies "present" one line after
        // creating an empty venv. From outside, only an installed project
        // answers.
        const imports = await exists(venvPy)
          ? (await run(venvPy, ["-c", "import hermes_cli"], ctx.signal, {
            env,
            cwd: workdir,
          })).code === 0
          : false;
        if (imports) {
          say("dependencies", "present", "hermes_cli imports");
        } else if (args.skipDeps) {
          say("dependencies", "skipped", "skipDeps");
        } else if (
          !wouldChange("dependencies", "uv sync --extra all --locked")
        ) {
          // `--locked` reproduces the checkout's uv.lock instead of
          // re-resolving, which is the difference between two bots on one ref
          // running the same dependency set and merely believing they do.
          //
          // uv.lock records resolver settings from this checkout's [tool.uv],
          // so the ambient user config is redirected at an empty directory
          // rather than hidden with UV_NO_CONFIG — which would make uv 0.12+
          // reject a perfectly valid lock.
          const emptyConf = await Deno.makeTempDir();
          const r = await run("uv", uv.sync, ctx.signal, {
            cwd: agentDir,
            env: {
              ...env,
              UV_PROJECT_ENVIRONMENT: `${agentDir}/venv`,
              VIRTUAL_ENV: `${agentDir}/venv`,
              XDG_CONFIG_HOME: emptyConf,
              XDG_CONFIG_DIRS: emptyConf,
            },
          });
          try {
            await Deno.remove(emptyConf);
          } catch { /* uv may have written into it */ }
          if (r.code !== 0) {
            throw new Error(
              `uv sync failed: ${
                (r.stderr || r.stdout).trim().split("\n").slice(-5).join(" ")
              }`,
            );
          }
          say("dependencies", "created", "uv sync --extra all --locked");
        }

        let venvPythonVersion: string | null = null;
        if (await exists(venvPy)) {
          const r = await run(venvPy, ["--version"], ctx.signal);
          venvPythonVersion = r.code === 0
            ? (r.stdout + r.stderr).trim()
            : null;
        }

        // -- funes, staged -------------------------------------------------
        // Staged rather than shared: a bot's memory tooling must not change
        // under it because the host updated. The two digests are recorded side
        // by side so the drift is visible instead of assumed.
        const hostFunes = args.funesBin.replace("$HOME", h.home);
        const stagedFunes = `${workdir}/tools/funes`;
        const digestOf = async (path: string): Promise<string | null> => {
          try {
            return await sha256Bytes(await Deno.readFile(path));
          } catch {
            return null;
          }
        };
        const hostDigest = await digestOf(hostFunes);
        let stagedDigest = await digestOf(stagedFunes);
        if (stagedDigest !== null) {
          say(
            "funes binary",
            "present",
            stagedDigest === hostDigest
              ? "matches the host's"
              : `DIFFERS from ${hostFunes} (staged ${
                stagedDigest.slice(0, 12)
              }, host ${hostDigest?.slice(0, 12) ?? "absent"})`,
          );
        } else if (hostDigest === null) {
          say("funes binary", "skipped", `no host binary at ${hostFunes}`);
        } else if (
          !wouldChange("funes binary", `stage ${hostFunes} into tools/`)
        ) {
          await Deno.copyFile(hostFunes, stagedFunes);
          await Deno.chmod(stagedFunes, 0o755);
          stagedDigest = hostDigest;
          say("funes binary", "created", `staged from ${hostFunes}`);
        }

        // -- funes hooks ---------------------------------------------------
        // `funes add hermes` writes its own scripts into $HOME/.hermes/hooks.
        // HOME is the workdir, so they land in this bot's Hermes home through
        // the symlink above and nothing touches the host's.
        const hookScript = `${workdir}/hermes/hooks/funes-index.sh`;
        if (await exists(hookScript)) {
          say("funes hooks", "present");
        } else if (stagedDigest === null) {
          say("funes hooks", "skipped", "no staged funes to install them with");
        } else if (!wouldChange("funes hooks", "funes add hermes")) {
          const r = await run(stagedFunes, ["add", "hermes"], ctx.signal, {
            cwd: workdir,
            env: {
              ...env,
              HOME: workdir,
              FUNES_HOME: `${workdir}/funes`,
              HF_HOME: `${workdir}/funes/hf`,
            },
          });
          if (r.code !== 0) {
            ctx.logger.warning("funes add hermes failed: {err}", {
              err: (r.stderr || r.stdout).trim().split("\n").slice(-2).join(
                " ",
              ),
            });
            say(
              "funes hooks",
              "skipped",
              "funes add hermes failed; see the warning",
            );
          } else {
            say("funes hooks", "created");
          }
        }

        // -- the embedding cache -------------------------------------------
        // Seeded from a sibling rather than downloaded. A bot whose egress is a
        // named allowlist cannot fetch it, and growing that allowlist by a
        // domain for a one-time model download is exactly the wrong trade.
        const hubDir = `${workdir}/funes/hf/hub`;
        if (await exists(hubDir)) {
          say("embedding cache", "present");
        } else if (!args.seedHfFrom) {
          say(
            "embedding cache",
            "skipped",
            b.funes.hfOffline
              ? "no seedHfFrom given — with hfOffline set, funes cannot download it either"
              : "no seedHfFrom given; funes will download it on first use",
          );
        } else {
          const src = `${
            b.workdirRoot.replace("$HOME", h.home)
          }/${args.seedHfFrom}/funes/hf/hub`;
          if (!await exists(src)) {
            say("embedding cache", "skipped", `nothing to copy at ${src}`);
          } else if (
            !wouldChange("embedding cache", `copy from ${args.seedHfFrom}`)
          ) {
            const r = await run("cp", ["-R", src, hubDir], ctx.signal);
            if (r.code !== 0) {
              throw new Error(
                `seeding the HF cache failed: ${(r.stderr || r.stdout).trim()}`,
              );
            }
            say("embedding cache", "created", `copied from ${args.seedHfFrom}`);
          }
        }

        // -- the files -----------------------------------------------------
        for (const f of workdirFiles(b, workdir)) {
          const abs = `${workdir}/${f.path}`;
          const current = await readIfPresent(abs);
          const what = decideFile(f, current, preexisting.has(f.path));
          if (what === "kept") {
            say(f.path, "present", current === f.content ? "" : f.because);
            continue;
          }
          if (wouldChange(f.path, `would be ${what} — ${f.because}`)) continue;
          await ensureDir(dirOf(abs));
          const tmp = `${abs}.provisioning`;
          await Deno.writeTextFile(tmp, f.content);
          await Deno.chmod(tmp, f.mode);
          await Deno.rename(tmp, abs);
          say(f.path, what, f.because);
        }

        const missing = steps.filter((s) => s.status === "missing").length;
        const acted =
          steps.filter((s) =>
            s.status === "created" || s.status === "updated" ||
            s.status === "replaced"
          ).length;
        const complete = missing === 0 && acted === 0;

        if (args.check) {
          if (missing > 0) {
            ctx.logger.warning(
              "{slug}: {n} step(s) incomplete. Run provision without check to finish the workdir.",
              { slug: b.slug, n: missing },
            );
          } else {
            ctx.logger.info("{slug}: workdir is complete", { slug: b.slug });
          }
        } else {
          ctx.logger.info(
            "{slug}: {acted} step(s) did work, {rest} already in place",
            { slug: b.slug, acted, rest: steps.length - acted },
          );
        }

        const handle = await ctx.writeResource(
          "provisioned",
          `provisioned-${b.slug}`,
          {
            slug: b.slug,
            provisionedAt: new Date().toISOString(),
            checkOnly: args.check,
            complete,
            workdir,
            hermesRepo,
            hermesRef,
            hermesHead: head,
            pythonVersion: args.pythonVersion,
            venvPython: venvPythonVersion,
            funesStagedSha256: stagedDigest,
            funesHostSha256: hostDigest,
            funesMatchesHost: stagedDigest !== null &&
              stagedDigest === hostDigest,
            steps,
            missingCount: missing,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    verify: {
      description:
        "Probe this bot's sandbox from inside it, using assertions built from its own declaration. Reports PASS, FAIL, VACUOUS (the probe proved nothing) or GAP (a known, documented hole).",
      arguments: VerifyArgs,
      execute: async (args: VerifyArgs, ctx: MethodCtx) => {
        const b = ctx.globalArgs;
        const h = hostFacts();
        const workdir = workdirOf(b).replace("$HOME", h.home);
        // This host's profile, not "the" profile: the two are not
        // interchangeable, and verifying the wrong one would report a boundary
        // that is not the one running.
        const profileRel = `profiles/${b.slug}.${h.platform}.nono.json`;
        const profile = `${ctx.repoDir}/${profileRel}`;

        if (!await exists(profile)) {
          throw new Error(
            `no profile at ${profileRel} — run render first.`,
          );
        }

        // Bind a REAL listener on the unlisted port before probing. This is the
        // whole difference between a meaningful loopback check and one that has
        // been printing PASS for months because nothing was ever listening.
        let listener: { close: () => void } | null = null;
        let probePort = args.probePort;
        try {
          listener = Deno.listen({ hostname: "127.0.0.1", port: probePort });
        } catch {
          ctx.logger.warning(
            "could not bind 127.0.0.1:{port}; the loopback check will report VACUOUS",
            { port: probePort },
          );
          probePort = 0;
        }

        // Existence is resolved out here, on the host. Inside the sandbox a
        // denied stat is indistinguishable from a missing file, so a probe that
        // decided this for itself would report VACUOUS for every denial that
        // was actually working — including the repository holding the vault.
        const resolve = (p: string) =>
          p.replace(/^~/, h.home).replace("$HOME", h.home);
        const checkPaths = async (paths: string[]): Promise<PathCheck[]> =>
          await Promise.all(paths.map(async (path) => ({
            path,
            existsOnHost: await exists(resolve(path)),
          })));

        const granted = await checkPaths(b.sandbox.filesystemAllow);
        const denied = await checkPaths(deniedPaths(ctx.repoDir, h.platform));

        // Ports something is really listening on that this bot never declared.
        // Only a port with a live listener can answer the loopback question —
        // a closed one refuses the connection either way.
        const declared = new Set([
          ...b.sandbox.openPorts,
          ...b.mcps.map((m) => m.port),
        ]);
        // Which foreign ports are worth asking about is the caller's to say.
        // Naming them in the type would bake one machine's MCP layout into a
        // published extension: on any other host those labels are fiction and
        // the ports that actually matter there would never be probed — a
        // narrower question than the report appears to be answering.
        const foreignPorts: ForeignPort[] = [];
        for (const other of args.foreignPorts) {
          if (declared.has(other.port)) continue;
          if (await portOpen(other.port)) {
            foreignPorts.push({
              port: other.port,
              label: other.label || `port ${other.port}`,
            });
          }
        }
        if (foreignPorts.length > 0) {
          ctx.logger.info(
            "probing {n} undeclared port(s) with live listeners: {ports}",
            {
              n: foreignPorts.length,
              ports: foreignPorts.map((f) => f.port).join(", "),
            },
          );
        }

        // The probe is Python because it is what the sandbox can reach without
        // any of the bot's own toolchain being installed or working — a probe
        // that needed the venv could not tell "the sandbox denied it" from "the
        // install is broken". Resolved rather than hardcoded to
        // /usr/bin/python3: that path is right on macOS and on most Linux
        // distributions, and wrong on NixOS, where the hardcoded version
        // produced a probe that ran nothing and a verify that proved nothing.
        const python = await which("python3", ctx.signal);
        if (python === null) {
          throw new Error(
            "no python3 on PATH. The sandbox probe is a Python program, and without an interpreter `verify` cannot prove anything about this bot's boundary.",
          );
        }

        const script = probePath(b, h.home);
        let checks: Check[] = [];
        try {
          await Deno.writeTextFile(
            script,
            buildProbe({
              bot: b,
              workdir,
              granted,
              denied,
              foreignPorts,
              probePort,
              deniedHost: args.deniedHost,
            }),
          );

          // `nono run`, not `wrap`: wrap applies filesystem confinement only
          // and leaves the whole network block inert, so verifying under wrap
          // would test a policy the runtime does not enforce. The entrypoints
          // use run for the same reason.
          const r = await run("nono", [
            "run",
            "-s",
            "--profile",
            profile,
            "--workdir",
            workdir,
            "--",
            python,
            script,
          ], ctx.signal);
          checks = parseProbeOutput(r.stdout + "\n" + r.stderr);
        } finally {
          listener?.close();
          try {
            await Deno.remove(script);
          } catch { /* the probe may never have been written */ }
        }

        const sum = summarize(checks);
        for (const c of checks) {
          const line = c.detail ? `${c.label} — ${c.detail}` : c.label;
          if (c.outcome === "FAIL") {
            ctx.logger.warning("FAIL  {line}", { line });
          } else {ctx.logger.info("{outcome}  {line}", {
              outcome: c.outcome.padEnd(7),
              line,
            });}
        }
        ctx.logger.info(
          "{slug}: {pass} pass, {fail} fail, {vacuous} vacuous, {gap} known gap",
          { slug: b.slug, ...sum },
        );

        const handle = await ctx.writeResource(
          "verification",
          `verification-${b.slug}`,
          {
            slug: b.slug,
            verifiedAt: new Date().toISOString(),
            profile: profileRel,
            clean: sum.clean,
            pass: sum.pass,
            fail: sum.fail,
            vacuous: sum.vacuous,
            gap: sum.gap,
            probePort,
            checks,
          },
        );

        if (!sum.clean) {
          throw new Error(
            `${b.slug}: ${sum.fail} sandbox claim(s) do not hold: ${
              checks.filter((c) => c.outcome === "FAIL").map((c) => c.label)
                .join("; ")
            }`,
          );
        }
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    snapshot: {
      description:
        "Archive everything about this bot that another machine cannot rebuild — state.db, the Funes memory, cron, skills, SOUL.md and the live config.yaml — and nothing that it can. Refuses while the gateway is running, because state.db is written on every turn.",
      arguments: SnapshotArgs,
      execute: async (args: SnapshotArgs, ctx: MethodCtx) => {
        const b = ctx.globalArgs;
        const h = hostFacts();
        const workdir = workdirOf(b).replace("$HOME", h.home);

        if (!await exists(workdir)) {
          throw new Error(`no workdir at ${workdir}; nothing to snapshot.`);
        }

        // A gateway writes state.db on every turn. An archive taken underneath
        // one carries a torn database, and the tear shows up much later as a
        // bot that has forgotten a week.
        const gw = await h.supervisor.state(gatewayLabel(b), ctx.signal);
        const running = gw.loaded && gw.state === "running";
        if (running && !args.force) {
          throw new Error(
            `${
              gatewayLabel(b)
            } is running. state.db is written on every turn, so an archive taken now would carry a torn database. Stop it first (\`uninstall\`, or stop the service), or pass force=true if you have decided to accept that.`,
          );
        }
        if (running) {
          ctx.logger.warning(
            "snapshotting a RUNNING gateway (force): state.db may be inconsistent",
          );
        }

        // Checkpoint the WAL so the archive's .db files are self-contained.
        // Python rather than a sqlite3 binary: the module is in every Python 3
        // and the binary is not on every host. The -wal files are carried
        // anyway, so a failure here costs nothing.
        const checkpointed: string[] = [];
        const python = await which("python3", ctx.signal);
        for (const rel of checkpointables()) {
          const db = `${workdir}/${rel}`;
          if (python === null || !await exists(db)) continue;
          const r = await run(python, [
            "-c",
            "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA wal_checkpoint(TRUNCATE)'); c.close()",
            db,
          ], ctx.signal);
          if (r.code === 0) {
            checkpointed.push(rel);
          } else {
            ctx.logger.warning(
              "could not checkpoint {db}: {err} (the -wal file is carried anyway)",
              { db: rel, err: (r.stderr || r.stdout).trim().split("\n")[0] },
            );
          }
        }

        // What travels, and what is on disk to travel. A declared path that is
        // absent is reported rather than skipped silently: on the far side it
        // is indistinguishable from one that was never declared.
        const wanted = carriedPaths(b, { includeHfCache: args.includeHfCache });
        const carried: { path: string; why: string; present: boolean }[] = [];
        for (const c of wanted) {
          carried.push({
            ...c,
            present: await exists(`${workdir}/${c.path}`),
          });
        }
        const present = carried.filter((c) => c.present);
        if (present.length === 0) {
          throw new Error(
            `nothing to carry: none of the ${carried.length} expected paths exist under ${workdir}.`,
          );
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const out = args.out ||
          `${ctx.repoDir}/snapshots/${b.slug}-${stamp}.tar.gz`;
        await ensureDir(dirOf(out));

        // -T with a list file rather than a long argv: the carried set is
        // small today and a path list has no length limit to rediscover later.
        const listFile = await Deno.makeTempFile();
        await Deno.writeTextFile(
          listFile,
          present.map((c) => c.path).join("\n") + "\n",
        );
        try {
          const r = await run("tar", [
            "-czf",
            out,
            "-C",
            workdir,
            ...EXCLUDES.flatMap((e) => ["--exclude", e]),
            "-T",
            listFile,
          ], ctx.signal);
          if (r.code !== 0) {
            throw new Error(
              `tar failed: ${
                (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")
              }`,
            );
          }
        } finally {
          try {
            await Deno.remove(listFile);
          } catch { /* already gone */ }
        }

        const bytes = (await Deno.stat(out)).size;
        const digest = await sha256Bytes(await Deno.readFile(out));
        const missing = carried.filter((c) => !c.present);
        for (const m of missing) {
          ctx.logger.info("not present, not carried: {path} ({why})", m);
        }
        ctx.logger.info(
          "{slug}: {n} path(s) -> {out} ({mb} MB)",
          {
            slug: b.slug,
            n: present.length,
            out,
            mb: (bytes / 1048576).toFixed(1),
          },
        );
        ctx.logger.info(
          "left behind for provision to rebuild: {paths}",
          { paths: rebuiltPaths().map((r) => r.path).join(", ") },
        );

        const handle = await ctx.writeResource(
          "snapshot",
          `snapshot-${b.slug}`,
          {
            slug: b.slug,
            takenAt: new Date().toISOString(),
            archive: out,
            bytes,
            sha256: digest,
            fromHome: h.home,
            fromWorkdir: workdir,
            includeHfCache: args.includeHfCache,
            gatewayWasRunning: running,
            checkpointed,
            carried,
            leftBehind: rebuiltPaths(),
            missingCount: missing.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    restore: {
      description:
        "Unpack a snapshot into this host's workdir and rewrite the old machine's absolute paths. Run it AFTER provision: it restores state, it does not build a runtime.",
      arguments: RestoreArgs,
      execute: async (args: RestoreArgs, ctx: MethodCtx) => {
        const b = ctx.globalArgs;
        const h = hostFacts();
        const toWorkdir = workdirOf(b).replace("$HOME", h.home);

        if (!await exists(args.archive)) {
          throw new Error(`no archive at ${args.archive}`);
        }
        if (!await exists(toWorkdir)) {
          throw new Error(
            `no workdir at ${toWorkdir}. Run \`provision\` first: restore puts state back into a runtime, it does not build one.`,
          );
        }

        // The prefix being rewritten. Derived from fromHome rather than taken
        // as a literal so a caller cannot half-specify it.
        const fromWorkdir = args.fromHome
          ? `${b.workdirRoot.replace("$HOME", args.fromHome)}/${b.slug}`
          : toWorkdir;
        if (fromWorkdir === toWorkdir) {
          ctx.logger.warning(
            "no fromHome given, so no paths will be rewritten. This is correct ONLY if both machines use the same home directory; otherwise the restored config.yaml will point the funes MCP at a path that does not exist and the gateway will come up with no memory tool.",
          );
        }

        // Unpack to a staging directory first. Extracting straight over a live
        // workdir would half-apply on any failure, and there would be no way
        // to tell which half.
        const stage = await Deno.makeTempDir();
        const placed: { path: string; action: string; rewrites: number }[] = [];
        const conflicts: string[] = [];
        const residual: { path: string; mentions: string[] }[] = [];
        try {
          const r = await run("tar", [
            "-xzf",
            args.archive,
            "-C",
            stage,
          ], ctx.signal);
          if (r.code !== 0) {
            throw new Error(
              `tar failed: ${
                (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")
              }`,
            );
          }

          // Walk what was actually in the archive rather than what the manifest
          // says should have been: an archive from an older version of this
          // model type is still a valid thing to restore.
          for await (const rel of walkFiles(stage)) {
            const src = `${stage}/${rel}`;
            const dest = `${toWorkdir}/${rel}`;

            let rewrites = 0;
            let body: string | null = null;
            if (rewritable(rel)) {
              const raw = await readIfPresent(src);
              if (raw !== null) {
                const done = rewritePrefix(raw, fromWorkdir, toWorkdir);
                body = done.content;
                rewrites = done.count;
              }
            }

            const existing = await readIfPresent(dest);
            const incoming = body ?? null;
            if (existing !== null && !args.force) {
              // Only a *differing* file is a conflict. An identical one is a
              // re-run, which must stay silent or nobody will re-run it.
              const same = incoming !== null
                ? existing === incoming
                : await sameBytes(src, dest);
              if (!same) {
                conflicts.push(rel);
                continue;
              }
              placed.push({ path: rel, action: "unchanged", rewrites: 0 });
              continue;
            }

            await ensureDir(dirOf(dest));
            if (incoming !== null) {
              await Deno.writeTextFile(dest, incoming);
            } else {
              await Deno.copyFile(src, dest);
            }
            placed.push({
              path: rel,
              action: existing === null ? "created" : "replaced",
              rewrites,
            });
            // Residuals are reported only for a file that was actually
            // written. Reporting one for a skipped conflict would warn about
            // the contents of a file that is not on disk, which sends someone
            // looking for a problem they do not have.
            if (incoming !== null) {
              const left = residualMentions(incoming, args.fromHome);
              if (left.length > 0) {
                residual.push({ path: rel, mentions: left });
              }
            }
          }
        } finally {
          try {
            await Deno.remove(stage, { recursive: true });
          } catch { /* best effort */ }
        }

        const rewritten = placed.reduce((n, p) => n + p.rewrites, 0);
        ctx.logger.info(
          "{slug}: {n} file(s) restored, {r} path(s) rewritten from {from}",
          { slug: b.slug, n: placed.length, r: rewritten, from: fromWorkdir },
        );
        for (const c of conflicts) {
          ctx.logger.warning(
            "conflict, left alone: {path} (pass force=true to overwrite)",
            { path: c },
          );
        }
        for (const rz of residual) {
          ctx.logger.warning(
            "{path} still mentions {home}: {mentions}",
            {
              path: rz.path,
              home: args.fromHome,
              mentions: rz.mentions.join(" | "),
            },
          );
        }

        const clean = conflicts.length === 0 && residual.length === 0;
        const handle = await ctx.writeResource(
          "restored",
          `restored-${b.slug}`,
          {
            slug: b.slug,
            restoredAt: new Date().toISOString(),
            archive: args.archive,
            fromWorkdir,
            toWorkdir,
            clean,
            placed,
            conflicts,
            residual,
          },
        );
        if (conflicts.length > 0) {
          throw new Error(
            `${conflicts.length} file(s) already exist and differ: ${
              conflicts.slice(0, 5).join(", ")
            }. Nothing was overwritten. Re-run with force=true to take the archive's version.`,
          );
        }
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    install: {
      description:
        "Substitute the unit placeholders into this platform's unit directory and load every service this bot owns, MCPs before the gateway. Refuses first if the host cannot enforce the boundary the declaration describes. Idempotent: an already-loaded service is replaced.",
      arguments: InstallArgs,
      execute: async (
        args: InstallArgs,
        ctx: MethodCtx,
      ) => {
        const b = ctx.globalArgs;
        const h = hostFacts();
        const services = servicesOf(b, h);

        // Ask the host whether it can enforce what this bot's declaration
        // claims, BEFORE installing anything. On Linux there are two ways to
        // end up with a deployment that reports perfect health and enforces
        // half of its boundary — a kernel too old for Landlock's network rules,
        // and a user manager without lingering — and neither announces itself.
        // This is the same class of failure as `nono wrap` and gets the same
        // answer: refuse.
        const problems = await h.supervisor.preflight(ctx.signal);
        for (const pr of problems) {
          if (pr.blocking) {
            ctx.logger.warning("preflight: {d}", { d: pr.detail });
          } else ctx.logger.info("preflight: {d}", { d: pr.detail });
        }
        const blocking = problems.filter((pr) => pr.blocking);
        if (blocking.length > 0 && !args.ignorePreflight) {
          throw new Error(
            `${h.platform} host cannot support this deployment as declared:\n  - ${
              blocking.map((pr) => pr.detail).join("\n  - ")
            }\nFix these, or pass ignorePreflight=true if you have decided to accept them.`,
          );
        }

        // Render every unit to its destination before loading ANY of them.
        // Rendering is cheap and total; interleaving it with loading means one
        // failure leaves later services with no unit on disk at all, so a
        // re-run cannot even find them.
        const staged: { svc: Service; dest: string }[] = [];
        for (const svc of services) {
          const src = `${ctx.repoDir}/${svc.unit}`;
          const raw = await readIfPresent(src);
          if (raw === null) {
            throw new Error(
              `${svc.label}: no unit file at ${svc.unit}. Gateway units come from \`render\`; MCP units are hand-written and must exist for this platform.`,
            );
          }
          const content = substitutePlaceholders(raw, {
            repo: ctx.repoDir,
            home: h.home,
            user: h.user,
          });
          const left = unresolvedPlaceholders(content);
          if (left.length > 0) {
            throw new Error(
              `${svc.label}: unresolved placeholder(s) ${
                left.join(", ")
              } after substitution. Installing this would produce a job that fails at exec.`,
            );
          }
          const dest = `${h.unitDir}/${h.supervisor.unitFile(svc.label)}`;
          await ensureDir(h.unitDir);
          await Deno.writeTextFile(dest, content);
          staged.push({ svc, dest });
        }

        // Neither supervisor creates the directory it writes a job's stdio to.
        await ensureDir(`${workdirOf(b).replace("$HOME", h.home)}/logs`);

        if (args.stageOnly) {
          ctx.logger.info(
            "Staged {count} unit file(s); not loading (stageOnly)",
            { count: staged.length },
          );
          const { services: st, ports } = await collectStatus(b, h, ctx.signal);
          return {
            dataHandles: [await writeStatus(ctx, b, h, st, ports)],
          };
        }

        // A load failure must not abort the loop. Aborting would leave earlier
        // services unloaded and never restarted, turning a partial failure into
        // an outage of things that were working.
        const failed: string[] = [];
        for (const { svc, dest } of staged) {
          const r = await h.supervisor.load(dest, svc.label, ctx.signal);
          if (r.code === 0) {
            ctx.logger.info("loaded {label}", { label: svc.label });
          } else {
            failed.push(svc.label);
            ctx.logger.warning("FAILED to load {label}: {err}", {
              label: svc.label,
              err: (r.stderr || r.stdout).trim().split("\n")[0],
            });
          }
        }

        const { services: st, ports } = await collectStatus(b, h, ctx.signal);
        const handle = await writeStatus(ctx, b, h, st, ports);
        if (failed.length > 0) {
          throw new Error(
            `${failed.length} service(s) did not load: ${
              failed.join(", ")
            }. Logs: ${workdirOf(b)}/logs/`,
          );
        }
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    uninstall: {
      description:
        "Unload this bot's services and remove their unit files from the platform's unit directory. Never touches the workdir — the Funes memory and session history outlive the deployment.",
      arguments: z.object({}),
      execute: async (_args: unknown, ctx: MethodCtx) => {
        const b = ctx.globalArgs;
        const h = hostFacts();
        // Gateway first on the way down, so it is not left talking to MCPs
        // that have gone away.
        for (const svc of servicesOf(b, h).reverse()) {
          await h.supervisor.unload(svc.label, ctx.signal);
          const dest = `${h.unitDir}/${h.supervisor.unitFile(svc.label)}`;
          try {
            await Deno.remove(dest);
            ctx.logger.info("unloaded {label}", { label: svc.label });
          } catch {
            ctx.logger.info("{label} had no unit file installed", {
              label: svc.label,
            });
          }
        }
        const { services: st, ports } = await collectStatus(b, h, ctx.signal);
        return { dataHandles: [await writeStatus(ctx, b, h, st, ports)] };
      },
    },

    // -----------------------------------------------------------------------
    status: {
      description:
        "Report what is actually running: supervisor state and pid per service, whether each declared MCP port answers, and whether the gateway holds a live session to it.",
      arguments: z.object({}),
      execute: async (_args: unknown, ctx: MethodCtx) => {
        const b = ctx.globalArgs;
        const h = hostFacts();
        const { services: st, ports } = await collectStatus(b, h, ctx.signal);
        for (const s of st) {
          ctx.logger.info("{label}: {state}{pid}", {
            label: s.label,
            state: s.loaded ? (s.state ?? "loaded") : "not loaded",
            pid: s.pid ? ` pid=${s.pid}` : "",
          });
        }
        for (const p of ports) {
          ctx.logger.info("{name} :{port} {listening}, {session}", {
            name: p.name,
            port: p.port,
            listening: p.listening ? "listening" : "NOT listening",
            session: p.liveSession
              ? "session live"
              : `no live session (${p.established} established)`,
          });
        }
        return { dataHandles: [await writeStatus(ctx, b, h, st, ports)] };
      },
    },

    // -----------------------------------------------------------------------
    restart: {
      description:
        "Bounce this bot's MCPs, wait for their ports, bounce the gateway, then confirm the sessions came back. Restarting an MCP without the gateway is never enough.",
      arguments: RestartArgs,
      execute: async (args: RestartArgs, ctx: MethodCtx) => {
        const b = ctx.globalArgs;
        const h = hostFacts();

        const wanted = args.only.length > 0
          ? args.only
          : b.mcps.map((m) => m.name);
        const unknown = wanted.filter((n) => !b.mcps.some((m) => m.name === n));
        if (unknown.length > 0) {
          throw new Error(
            `${b.slug} declares no MCP named ${unknown.join(", ")}. Declared: ${
              b.mcps.map((m) => m.name).join(", ") || "none"
            }`,
          );
        }
        const targets = b.mcps.filter((m) => wanted.includes(m.name));

        for (const m of targets) {
          const label = mcpLabelFor(b.slug, m.name);
          ctx.logger.info("restarting {label}", { label });
          await h.supervisor.kick(label, ctx.signal);
        }

        // Wait for the ports before bouncing the gateway, so it does not race
        // the servers it is about to connect to.
        for (const m of targets) {
          const up = await waitPort(m.port, 40, 2000, ctx.signal);
          if (up) {
            ctx.logger.info("  {name} listening on {port}", {
              name: m.name,
              port: m.port,
            });
          } else {
            ctx.logger.warning("  {name} NOT listening on {port}", {
              name: m.name,
              port: m.port,
            });
          }
        }

        const gw = gatewayLabelFor(b.slug);
        ctx.logger.info("restarting {label}", { label: gw });
        await h.supervisor.kick(gw, ctx.signal);

        // The gateway re-establishes its MCP sessions on startup. This is the
        // check that separates "the server is running" from "the agent can
        // actually reach it" — the distinction Hermes' parking behaviour makes
        // load-bearing.
        let ports = (await collectStatus(b, h, ctx.signal)).ports;
        if (b.mcps.length > 0) {
          for (let i = 0; i < 45; i++) {
            ports = (await collectStatus(b, h, ctx.signal)).ports;
            if (ports.every((p) => p.liveSession)) break;
            await sleep(3000, ctx.signal);
          }
          const live = ports.filter((p) => p.liveSession).length;
          ctx.logger.info("gateway sessions live: {live}/{total}", {
            live,
            total: ports.length,
          });
        }

        const st = (await collectStatus(b, h, ctx.signal)).services;
        const handle = await writeStatus(ctx, b, h, st, ports);
        const dead = ports.filter((p) => !p.liveSession).map((p) => p.name);
        if (dead.length > 0) {
          throw new Error(
            `no live session for ${dead.join(", ")} after restart. Check ${
              workdirOf(b)
            }/logs/`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
