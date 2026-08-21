/**
 * @skunk-ape/hermes — install and configure the Hermes agent on a host.
 *
 * Upstream ships one interactive installer that tracks `main`. Wrapping that
 * command would add nothing, so this model inverts it: every choice the
 * upstream wizard asks for at runtime is a field decided once, in version
 * control, before anything touches the host. See DESIGN.md.
 *
 * Every method reaches the host through the single `runScript` seam in
 * `_lib/exec.ts`, so the architecture can change without touching the install.
 *
 * The flags and paths below are read from `scripts/install.sh`,
 * `scripts/hermes-gateway`, and `hermes_cli/env_loader.py` in
 * NousResearch/hermes-agent rather than inferred from its documentation. Where
 * the two disagree, the source wins and the disagreement is noted in a comment.
 */
import { z } from "npm:zod@4";
import {
  LOCAL,
  parseKv,
  runProbe,
  runScript,
  shellEsc,
  stripAnsi,
  type Transport,
  writeFileScript,
} from "./_lib/exec.ts";

// Swamp wires args and context at runtime; the model loader does not expose
// types for them.
// deno-lint-ignore no-explicit-any
type Ctx = any;

const REPO_URL = "https://github.com/NousResearch/hermes-agent.git";

// The installer is fetched at the resolved commit rather than from the
// upstream vanity URL. `curl … /install.sh | bash` is a moving target: the
// script that runs is whatever was published a second ago, and pinning the
// *code* while leaving the *installer* unpinned pins the smaller half. A raw
// URL carrying a commit SHA is an immutable object.
const RAW_BASE = "https://raw.githubusercontent.com/NousResearch/hermes-agent";

// The upstream systemd unit is a *user* unit, installed by `hermes gateway
// install` to ~/.config/systemd/user/hermes-gateway.service with
// `WantedBy=default.target`. It is not a system unit, and this is why `service`
// deals with linger and the user bus at all.
const GATEWAY_UNIT = "hermes-gateway";

// --- configuration -------------------------------------------------------

const GlobalArgsSchema = z.object({
  transport: z.enum(["local", "ssh"]).default("local").describe(
    'How methods reach the target. "local" runs on whatever machine executes the method — correct when a swamp worker is enrolled on the target, or when swamp itself is installed there. "ssh" runs the same scripts over an ssh connection, which is what lets one orchestrator drive a host it is not running on.',
  ),
  sshHost: z.string().default("").describe(
    'The ssh destination, required when transport is "ssh". Any alias ssh can resolve: user@host, or a Host entry from your ssh_config. Port and identity belong in ssh_config rather than here — adding `Include ~/.lima/*/ssh.config` there makes a Lima VM reachable as `lima-<name>` with no configuration in this model.',
  ),
  sshConnectTimeoutSeconds: z.number().default(10).describe(
    "How long to wait for the ssh handshake. Bounds connecting only; the wall-clock cost of the work itself is capped by installTimeoutSeconds inside the script.",
  ),
  ref: z.string().describe(
    "Git ref of NousResearch/hermes-agent to install: a tag, a branch, or a full 40-character commit SHA. Required with no default on purpose — tracking `main` is the upstream behaviour this model exists to replace. Prefer a tag or a SHA: a branch resolves to a different commit on every run, so `install` and `verify` can legitimately disagree. Abbreviated SHAs are rejected, because the recorded commit has to compare equal to `git rev-parse HEAD`.",
  ),
  dataDir: z.string().default("~/.hermes").describe(
    "Hermes data directory on the target, passed as --hermes-home. Holds config, skills, sessions, and the .env this model writes. A leading ~ is expanded on the target.",
  ),
  installDir: z.string().default("").describe(
    "Where the code checkout goes, passed as --dir. Empty means the upstream default for a non-root install, which is <dataDir>/hermes-agent.",
  ),
  installSystemPackages: z.boolean().default(true).describe(
    "Allow the installer to apt/dnf/pacman ripgrep and ffmpeg, which needs passwordless sudo. There is no upstream flag to decline, so false is enforced as an assertion instead: preflight fails unless both are already present, which is what makes the installer skip them.",
  ),
  installBrowser: z.boolean().default(true).describe(
    "Install Playwright and Chromium, passed through as --skip-browser when false. This is the heaviest step and most of minDiskGb. Browser tools do not work without it.",
  ),
  installComputerUse: z.boolean().default(true).describe(
    "Install the Computer Use driver, passed through as --skip-computer-use when false.",
  ),
  seedBundledSkills: z.boolean().default(true).describe(
    "Seed the bundled skills. False passes --no-skills, which also writes <dataDir>/.no-bundled-skills so later `hermes update` runs stay bare. That marker is a one-way door: setting this back to true does not remove it.",
  ),
  onExisting: z.enum(["update", "fresh", "fail"]).default("update").describe(
    'What to do when a checkout is already there. Decided here rather than by an interactive prompt that would hang. "fresh" moves the old checkout aside and never touches dataDir, because that is where the irreplaceable state lives.',
  ),
  installGatewayService: z.boolean().default(true).describe(
    "Install and enable the systemd user unit for the messaging gateway.",
  ),
  enableLinger: z.boolean().default(true).describe(
    "Run `loginctl enable-linger` so the gateway user unit starts at boot and survives logout. Needs passwordless sudo. Without it the gateway only runs while a session is open, which upstream mentions in a hint and then leaves to the reader.",
  ),
  env: z.record(z.string(), z.string()).default({}).describe(
    'Environment written to the Hermes .env. Source secrets from a vault, e.g. { ANTHROPIC_API_KEY: \'${{ vault.get("hermes", "anthropic-key") }}\' }. Keep every vault reference static and literal — a dynamically constructed reference forfeits the per-step secret allowlist. The gateway enables a messaging platform when its token is present here, so there is no separate platform list.',
  ),
  minDiskGb: z.number().default(20).describe(
    "Free space preflight requires. Chromium, Node, and a Python toolchain are the bulk of it, so a smaller floor is reasonable with installBrowser false.",
  ),
  installTimeoutSeconds: z.number().default(3600).describe(
    "Wall-clock cap on the installer, enforced by timeout(1) on the target. Nothing else bounds it, and the Chromium and Node steps look identical to a hang while they are working. Note that when this method runs as a dispatched worker step, the transport imposes a shorter ceiling than this field can: a dispatch credential expires after 15 minutes and cannot be renewed, so a longer install completes on the host and then fails to record anything. See swamp-club Lab #1750, and prefer installBrowser false for a dispatched first install.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// --- resources -----------------------------------------------------------

const PreflightSchema = z.object({
  ok: z.boolean(),
  failures: z.array(z.string()),
  os: z.string(),
  arch: z.string(),
  systemd: z.boolean(),
  userBus: z.boolean(),
  linger: z.boolean(),
  passwordlessSudo: z.boolean(),
  diskFreeGb: z.number(),
  egress: z.boolean(),
  existingInstall: z.boolean(),
  tools: z.record(z.string(), z.boolean()),
  resolvedCommit: z.string(),
  transport: z.string(),
  target: z.string(),
  envKeys: z.array(z.string()),
  timestamp: z.string(),
});

/**
 * One row of the install history.
 *
 * This resource has `lifetime: "infinite"` and keeps ten versions, so the
 * datastore is the record of which Hermes has been on this host and when. That
 * is why it carries both what was installed and what it replaced: a series of
 * snapshots tells you the current state, but a series of transitions tells you
 * the upgrade history, and the second is the question people actually ask.
 *
 * `ref` is what was asked for and `commit` is what that resolved to. Keeping
 * both matters because they are different kinds of fact — `v2026.8.18` is a
 * decision someone made and recorded in git, while `e624e9fd…` is the immutable
 * thing that decision meant on the day it ran.
 */
const InstallSchema = z.object({
  ref: z.string(),
  commit: z.string(),
  hermesVersion: z.string(),
  hermesVersionRaw: z.string(),
  previousCommit: z.string(),
  previousVersion: z.string(),
  changed: z.boolean(),
  installPath: z.string(),
  commandPath: z.string(),
  logPath: z.string(),
  timestamp: z.string(),
});

const ConfigureSchema = z.object({
  envPath: z.string(),
  keysWritten: z.array(z.string()),
  timestamp: z.string(),
});

const ServiceSchema = z.object({
  unit: z.string(),
  enabled: z.boolean(),
  active: z.boolean(),
  linger: z.boolean(),
  timestamp: z.string(),
});

const VerifySchema = z.object({
  ok: z.boolean(),
  hermesVersion: z.string(),
  gatewayActive: z.boolean(),
  checks: z.record(z.string(), z.boolean()),
  failures: z.array(z.string()),
  doctorIssues: z.number(),
  timestamp: z.string(),
});

// --- shared script fragments ---------------------------------------------

/**
 * Resolve `ref` to an immutable commit SHA, into `$COMMIT`.
 *
 * The upstream installer's `--commit` rejects anything that is not a 7-40
 * character hex SHA, so a tag has to be peeled before it can be pinned. An
 * annotated tag resolves to a tag object rather than a commit, which is why the
 * `^{}` line is preferred over the bare one — recording the tag object SHA
 * would make `verify`'s comparison against `git rev-parse HEAD` fail forever.
 *
 * Resolving here also means a typo'd ref fails against the remote before
 * anything is installed, which is the point of `preflight`.
 */
export function resolveCommitFragment(ref: string): string {
  return `
REF=${shellEsc(ref)}
if printf '%s' "$REF" | grep -qE '^[0-9a-fA-F]{40}$'; then
  COMMIT="$REF"
else
  LS="$(git ls-remote ${
    shellEsc(REPO_URL)
  } "refs/tags/$REF" "refs/tags/$REF^{}" "refs/heads/$REF" 2>/dev/null || true)"
  COMMIT="$(printf '%s\\n' "$LS" | awk '$2 ~ /\\^\\{\\}$/ { print $1; exit }')"
  if [ -z "$COMMIT" ]; then
    COMMIT="$(printf '%s\\n' "$LS" | awk 'NF == 2 { print $1; exit }')"
  fi
fi
`;
}

/**
 * Locate the `hermes` command, into `$HERMES_BIN`.
 *
 * A non-root install links the command into ~/.local/bin, which a
 * non-login shell — every SSH command and every dispatched worker step — does
 * not necessarily have on PATH. Looking in the two directories the installer
 * actually links into is more reliable than trusting `command -v`, which is
 * kept only as a fallback.
 */
export const HERMES_BIN_FRAGMENT = `
HERMES_BIN=""
for c in "$HOME/.local/bin/hermes" /usr/local/bin/hermes; do
  if [ -x "$c" ]; then HERMES_BIN="$c"; break; fi
done
if [ -z "$HERMES_BIN" ]; then HERMES_BIN="$(command -v hermes 2>/dev/null || true)"; fi
`;

/**
 * Make `systemctl --user` reachable.
 *
 * A user unit is addressed through the caller's own session bus, and a
 * non-login shell arrives with neither XDG_RUNTIME_DIR nor
 * DBUS_SESSION_BUS_ADDRESS set. Without these two, `systemctl --user` fails
 * with "Failed to connect to bus" no matter how healthy the unit is.
 */
export const USER_BUS_FRAGMENT = `
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
`;

// --- helpers -------------------------------------------------------------

/**
 * Turn the configured transport into the one the seam understands.
 *
 * This function is the entire difference between driving the local machine and
 * driving a remote one. Every script body in this model is unchanged across
 * both, which is what the seam was for.
 */
export function transportFor(g: GlobalArgs): Transport {
  if (g.transport !== "ssh") return LOCAL;
  return {
    kind: "ssh",
    host: g.sshHost,
    connectTimeoutSeconds: g.sshConnectTimeoutSeconds,
  };
}

/** Where the code checkout goes, mirroring the upstream non-root default. */
export function resolveInstallDir(g: GlobalArgs): string {
  if (g.installDir) return g.installDir;
  return `${g.dataDir.replace(/\/+$/, "")}/hermes-agent`;
}

/**
 * Pull the version out of what `hermes --version` prints.
 *
 * The command answers "Hermes Agent v0.20.4 (2026.8.18)". Recording that whole
 * sentence would make the install history unqueryable — comparing versions
 * across runs means comparing "0.20.4", not a line of prose.
 */
export function parseHermesVersion(raw: string): string {
  // Only the v-prefixed form counts. Upstream always prints one — the banner is
  // built as `f"Hermes Agent v{__version__} ({__release_date__})"` — and the
  // release date in those parentheses is itself three dot-separated numbers. A
  // looser pattern would happily report the date as the version on any banner
  // where the version was missing, which is precisely the case where being
  // wrong is worst.
  return raw.match(/\bv(\d+\.\d+\.\d+)/)?.[1] ?? "unknown";
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Messaging platforms, keyed by the environment variable that turns each on.
 *
 * The gateway has no list of platforms to enable — it looks for these tokens
 * and starts whatever it finds, which is why this model has no `gatewayPlatforms`
 * field. Each entry names the per-platform allowlist that decides who is allowed
 * to talk to it.
 *
 * Only the platforms with a first-class token variable are listed. Upstream
 * supports twenty-two, but the rest are configured through `config.yaml` rather
 * than a single env var, so a token check would not find them.
 */
const PLATFORM_TOKENS: Array<
  { token: string; allowlists: string[]; label: string }
> = [
  {
    token: "TELEGRAM_BOT_TOKEN",
    allowlists: ["TELEGRAM_ALLOWED_USERS", "TELEGRAM_GROUP_ALLOWED_USERS"],
    label: "Telegram",
  },
  {
    token: "DISCORD_BOT_TOKEN",
    allowlists: ["DISCORD_ALLOWED_USERS"],
    label: "Discord",
  },
  {
    token: "SLACK_BOT_TOKEN",
    allowlists: ["SLACK_ALLOWED_USERS"],
    label: "Slack",
  },
  {
    token: "WHATSAPP_ENABLED",
    allowlists: ["WHATSAPP_ALLOWED_USERS", "WHATSAPP_GROUP_ALLOWED_USERS"],
    label: "WhatsApp",
  },
  {
    token: "EMAIL_ADDRESS",
    allowlists: ["EMAIL_ALLOWED_USERS"],
    label: "Email",
  },
];

/** Allowlists that apply across every platform rather than to one. */
const GATEWAY_WIDE_ALLOWLISTS = ["GATEWAY_ALLOWED_USERS"];

/** Truthy in the sense the gateway means: an explicit opt-in string. */
function isTruthy(value: string | undefined): boolean {
  return ["true", "1", "yes", "on"].includes(
    (value ?? "").trim().toLowerCase(),
  );
}

/**
 * Catch a messaging platform that would start up and then ignore you.
 *
 * A platform token on its own is not enough. The gateway defaults to deny for
 * unknown senders, so a token with no allowlist produces a bot that connects,
 * reports itself healthy, and silently drops every message you send it. There
 * is no error anywhere except one warning line in the gateway's own log at
 * startup:
 *
 *     No env user allowlists configured. Messaging platforms default to
 *     pairing/allowlist policies and will deny unknown senders …
 *
 * That is a miserable thing to debug from the outside — everything looks
 * correct — so it is a preflight failure here rather than a surprise later.
 * `GATEWAY_ALLOW_ALL_USERS=true` is the deliberate opt-out and satisfies the
 * check, because choosing open access explicitly is a decision rather than an
 * oversight.
 */
export function validatePlatformAllowlists(
  env: Record<string, string>,
): string[] {
  if (isTruthy(env.GATEWAY_ALLOW_ALL_USERS)) return [];

  const hasValue = (key: string) => (env[key] ?? "").trim().length > 0;
  const gatewayWide = GATEWAY_WIDE_ALLOWLISTS.some(hasValue);
  if (gatewayWide) return [];

  const problems: string[] = [];
  for (const platform of PLATFORM_TOKENS) {
    // WHATSAPP_ENABLED is a flag rather than a token, so "present" means "on".
    const enabled = platform.token === "WHATSAPP_ENABLED"
      ? isTruthy(env[platform.token])
      : hasValue(platform.token);
    if (!enabled) continue;
    if (platform.allowlists.some(hasValue)) continue;

    problems.push(
      `${platform.label} is configured via ${platform.token}, but none of ${
        platform.allowlists.join(", ")
      } is set. The gateway denies unknown senders by default, so it would start, look healthy, and ignore every message. Set an allowlist, or set GATEWAY_ALLOW_ALL_USERS=true to open it deliberately.`,
    );
  }
  return problems;
}

/**
 * Check every configured value before any of it reaches the host.
 *
 * The key check is the one that earns its keep: `.env` keys become environment
 * variable names, and a name that is not a shell identifier is silently useless
 * rather than loudly wrong.
 *
 * The unresolved-reference check is defence in depth rather than the main
 * guard. Swamp resolves `${{ vault.get(...) }}` before a method runs and fails
 * the run itself when the vault or the key is missing — verified against a
 * missing vault, which never reached this function. What this catches is the
 * residual case where a reference arrives as literal text anyway, because
 * writing `${{ vault.get("hermes", "anthropic-key") }}` into .env as an API key
 * would surface much later as an authentication error from a model provider.
 */
export function validateEnv(env: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key)) {
      problems.push(
        `env key ${JSON.stringify(key)} is not a valid shell identifier.`,
      );
    }
    if (value.includes("${{")) {
      problems.push(
        `env key ${key} still contains an unresolved \${{ … }} reference, so its vault lookup did not resolve.`,
      );
    }
    if (value.includes("\0")) {
      problems.push(`env key ${key} contains a NUL byte.`);
    }
  }
  return problems;
}

/**
 * Render the complete `.env`.
 *
 * Every value is double-quoted and escaped, because python-dotenv reads escape
 * sequences inside double quotes and reads single-quoted values literally —
 * a value containing a quote of the wrong kind would otherwise truncate.
 *
 * This writes the file whole rather than merging into it, which matters more
 * than it looks: `hermes_cli/env_loader.py` clears known keys that are absent
 * from .env, so removing a key from the model definition really does remove it
 * from the running agent. The definition is the whole truth about the
 * environment, which is the property that makes it worth having in git.
 */
export function renderEnvFile(env: Record<string, string>): string {
  const esc = (v: string) =>
    v.replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
  const lines = [
    "# Managed by the @skunk-ape/hermes swamp model.",
    "# Written whole from the model definition on every `configure` run.",
    "# Edits made here are lost on the next run — change the definition.",
    "",
  ];
  for (const key of Object.keys(env).sort()) {
    lines.push(`${key}="${esc(env[key])}"`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Swamp model definition for `@skunk-ape/hermes`.
 *
 * One model instance targets one host. `globalArguments` holds the install
 * decisions — the pinned ref, whether system packages may be installed, what
 * to do with an existing install, and the environment to write — so that the
 * upstream installer's interactive prompts never arise.
 *
 * The methods are meant to be run in order — `preflight`, `install`,
 * `configure`, `service`, `verify` — but each stands alone and re-runs cleanly,
 * so rotating a key is `configure` plus `service` rather than a rebuild.
 */
export const model = {
  type: "@skunk-ape/hermes",
  version: "2026.08.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "preflight": {
      description:
        "What the host looks like, and every reason it is not ready. Changes nothing.",
      schema: PreflightSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    "install": {
      description: "The installed ref, resolved commit, version, and paths.",
      schema: InstallSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "configure": {
      description:
        "Which environment keys were written. Names only — never values.",
      schema: ConfigureSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    "service": {
      description: "Gateway unit state.",
      schema: ServiceSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    "verify": {
      description: "Whether Hermes actually answers, check by check.",
      schema: VerifySchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: {
    preflight: {
      description:
        "Assert the host can take an install: OS and arch, systemd and its user bus, passwordless sudo, free space, egress, and the tools the installer assumes. Resolves the configured ref against the remote and validates every environment value. Changes nothing, so a bad ref or a malformed environment key fails here rather than after Chromium has downloaded.",
      arguments: z.object({}),
      execute: async (_args: unknown, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;
        const installDir = resolveInstallDir(g);

        ctx.logger.info("Probing the target for a Hermes install at {ref}", {
          ref: g.ref,
        });

        // Every probe answers on stdout and exits 0. An exit code here would
        // mean "the probe could not run", not "the answer is no".
        const script = `
DATA_DIR="$(expand_home ${shellEsc(g.dataDir)})"
INSTALL_DIR="$(expand_home ${shellEsc(installDir)})"

echo "OS=$(uname -s)"
echo "ARCH=$(uname -m)"

if command -v systemctl >/dev/null 2>&1; then echo "SYSTEMD=yes"; else echo "SYSTEMD=no"; fi

export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
if systemctl --user show-environment >/dev/null 2>&1; then echo "USERBUS=yes"; else echo "USERBUS=no"; fi

if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" = "yes" ]; then
  echo "LINGER=yes"
else
  echo "LINGER=no"
fi

if sudo -n true >/dev/null 2>&1; then echo "SUDO=yes"; else echo "SUDO=no"; fi

for t in git curl python3 unzip xz rg ffmpeg; do
  if command -v "$t" >/dev/null 2>&1; then echo "TOOL_$t=yes"; else echo "TOOL_$t=no"; fi
done

# Not a command, so it needs its own probe. The Node 26 arm64 build links
# against libatomic.so.1 and the installer does not install it. When it is
# absent, node fails with exit 127 — indistinguishable from "not on PATH"
# unless you know to look, which is why this is checked here by name.
if ldconfig -p 2>/dev/null | grep -q 'libatomic\.so\.1'; then
  echo "LIB_libatomic=yes"
else
  echo "LIB_libatomic=no"
fi

# Measure the nearest existing ancestor: df on a path that does not exist yet
# reports nothing, and a fresh host has neither the data dir nor its parent.
PROBE="$DATA_DIR"
while [ -n "$PROBE" ] && [ ! -d "$PROBE" ]; do PROBE="$(dirname "$PROBE")"; done
KB="$(df -Pk "\${PROBE:-/}" 2>/dev/null | awk 'NR==2 { print $4 }')"
if [ -n "$KB" ]; then echo "DISK_GB=$((KB / 1024 / 1024))"; else echo "DISK_GB=0"; fi

if curl -fsS --max-time 10 -o /dev/null https://github.com 2>/dev/null; then
  echo "EGRESS=yes"
else
  echo "EGRESS=no"
fi

# An install is a checkout, not a data directory. dataDir can exist because
# something wrote a log there and still hold no Hermes.
if [ -d "$INSTALL_DIR/.git" ]; then echo "EXISTING=yes"; else echo "EXISTING=no"; fi

${resolveCommitFragment(g.ref)}
echo "COMMIT=\${COMMIT:-}"
`;

        const { stdout } = await runScript(script, {
          signal: ctx.signal,
          transport: transportFor(g),
        });
        const kv = parseKv(stdout);

        const os = kv.OS ?? "unknown";
        const arch = kv.ARCH ?? "unknown";
        const systemd = kv.SYSTEMD === "yes";
        const userBus = kv.USERBUS === "yes";
        const linger = kv.LINGER === "yes";
        const passwordlessSudo = kv.SUDO === "yes";
        const diskFreeGb = Number(kv.DISK_GB ?? "0");
        const egress = kv.EGRESS === "yes";
        const existingInstall = kv.EXISTING === "yes";
        const resolvedCommit = kv.COMMIT ?? "";
        const tools: Record<string, boolean> = {};
        for (
          const t of ["git", "curl", "python3", "unzip", "xz", "rg", "ffmpeg"]
        ) {
          tools[t] = kv[`TOOL_${t}`] === "yes";
        }
        tools["libatomic.so.1"] = kv.LIB_libatomic === "yes";

        const failures: string[] = [];
        if (os !== "Linux") {
          failures.push(
            `host is ${os}, and this model installs onto Linux. macOS has no systemd, so the gateway has no supported service path.`,
          );
        }
        for (const t of ["git", "curl"]) {
          if (!tools[t]) {
            failures.push(
              `${t} is not on the target, and the installer needs it to fetch anything.`,
            );
          }
        }
        if (!tools["xz"]) {
          failures.push(
            "xz is missing, and the Node tarball the installer downloads is .tar.xz.",
          );
        }
        if (!tools["libatomic.so.1"]) {
          // Learned the hard way: this presents as exit 127 from `node
          // --version`, which reads as a PATH problem and sends you looking in
          // the wrong place entirely.
          failures.push(
            "libatomic.so.1 is missing. The Node build the installer fetches links against it, so node would fail with exit 127 — which looks like a PATH problem, not a missing library. Install libatomic1 (Debian/Ubuntu) or libatomic (Fedora/Arch).",
          );
        }
        if (!tools["unzip"] && g.installBrowser) {
          failures.push(
            "installBrowser is true but unzip is missing, and Playwright extracts its browser archives with it.",
          );
        }
        if (!systemd && g.installGatewayService) {
          failures.push(
            "installGatewayService is true but systemctl is absent, so the gateway unit cannot be installed.",
          );
        }
        // The gateway is a user unit, so it needs a user bus. A missing bus is
        // only a failure when nothing later will create one: enabling lingering
        // starts user@$UID.service, which is exactly what a system service or
        // a dispatched worker step is missing. Failing here regardless would
        // reject every fresh host that `service` would have fixed a step later.
        const lingerWillBeEnabled = g.enableLinger &&
          (passwordlessSudo || linger);
        if (
          systemd && !userBus && g.installGatewayService && !lingerWillBeEnabled
        ) {
          failures.push(
            "installGatewayService is true but `systemctl --user` cannot reach a session bus, and nothing here will create one. The gateway is a user unit, so it needs either enableLinger with passwordless sudo, or lingering enabled out of band.",
          );
        }
        if (!passwordlessSudo && g.installSystemPackages) {
          failures.push(
            "installSystemPackages is true but sudo needs a password. The installer would block on a prompt.",
          );
        }
        if (!passwordlessSudo && g.enableLinger && !linger) {
          failures.push(
            "enableLinger is true but sudo needs a password, and lingering is not already on.",
          );
        }
        if (!g.installSystemPackages) {
          // There is no upstream flag for "do not install packages". The
          // installer decides by `command -v`, so the only honest way to hold
          // it to this choice is to require that it finds nothing to do.
          for (const [tool, pkg] of [["rg", "ripgrep"], ["ffmpeg", "ffmpeg"]]) {
            if (!tools[tool]) {
              failures.push(
                `installSystemPackages is false but ${pkg} is missing. The installer has no flag to decline, and would install it via sudo. Install ${pkg} out of band, or set installSystemPackages true.`,
              );
            }
          }
        }
        if (diskFreeGb < g.minDiskGb) {
          failures.push(
            `${diskFreeGb}GB free, ${g.minDiskGb}GB required. Chromium and the Node and Python toolchains are the bulk of it.`,
          );
        }
        if (!egress) {
          failures.push(
            "no egress to github.com, so the clone and the toolchain downloads would fail.",
          );
        }
        if (!resolvedCommit) {
          failures.push(
            `ref ${
              JSON.stringify(g.ref)
            } does not resolve to a tag, a branch, or a full 40-character commit SHA in ${REPO_URL}.`,
          );
        }
        if (existingInstall && g.onExisting === "fail") {
          failures.push(
            `a checkout already exists at ${installDir} and onExisting is "fail".`,
          );
        }
        if (g.transport === "ssh" && !g.sshHost.trim()) {
          failures.push(
            'transport is "ssh" but sshHost is empty, so there is nothing to connect to.',
          );
        }
        failures.push(...validateEnv(g.env));
        if (g.installGatewayService) {
          failures.push(...validatePlatformAllowlists(g.env));
        }

        const handle = await ctx.writeResource("preflight", "preflight", {
          ok: failures.length === 0,
          failures,
          os,
          arch,
          systemd,
          userBus,
          linger,
          passwordlessSudo,
          diskFreeGb,
          egress,
          existingInstall,
          tools,
          resolvedCommit,
          transport: g.transport,
          target: g.transport === "ssh" ? g.sshHost : "local",
          envKeys: Object.keys(g.env).sort(),
          timestamp: new Date().toISOString(),
        });

        if (failures.length > 0) {
          throw new Error(
            `preflight failed with ${failures.length} problem(s):\n- ${
              failures.join("\n- ")
            }`,
          );
        }

        ctx.logger.info(
          "Target is ready: {os}/{arch}, {disk}GB free, ref resolves to {commit}",
          { os, arch, disk: diskFreeGb, commit: resolvedCommit.slice(0, 12) },
        );
        return { dataHandles: [handle] };
      },
    },

    install: {
      description:
        "Resolve the configured ref to a commit, fetch the upstream installer at that same commit, and run it fully non-interactively under a wall-clock cap. Idempotent: a second run against an unchanged ref is an update that lands on the same commit.",
      arguments: z.object({}),
      execute: async (_args: unknown, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;
        const installDir = resolveInstallDir(g);

        // What is on the host now, so this run can record the transition rather
        // than just the destination. Absent on a first install, which is the
        // only time both previous fields are empty.
        const prior = await ctx.readResource("install") as
          | { commit?: string; hermesVersion?: string }
          | null;

        const flags = [
          // Never run the wizard, and never let a prompt decide anything. Both
          // are needed: --skip-setup silences the wizard, --non-interactive
          // makes every remaining prompt_yes_no take its default instead of
          // reading /dev/tty, which is reachable often enough to matter.
          "--skip-setup",
          "--non-interactive",
          // The declaration is authoritative. Without --force-commit the
          // installer silently ignores a pin that would move an existing
          // checkout backwards, which would make a rollback quietly do nothing.
          "--force-commit",
        ];
        if (!g.installBrowser) flags.push("--skip-browser");
        if (!g.installComputerUse) flags.push("--skip-computer-use");
        if (!g.seedBundledSkills) flags.push("--no-skills");

        ctx.logger.info(
          "Installing Hermes at {ref} into {dir}, capped at {cap}s",
          { ref: g.ref, dir: installDir, cap: g.installTimeoutSeconds },
        );

        const script = `
DATA_DIR="$(expand_home ${shellEsc(g.dataDir)})"
INSTALL_DIR="$(expand_home ${shellEsc(installDir)})"

${resolveCommitFragment(g.ref)}
if [ -z "\${COMMIT:-}" ]; then
  echo "could not resolve ref '$REF' to a tag, branch, or full 40-character commit SHA in ${REPO_URL}" >&2
  exit 1
fi
echo "COMMIT=$COMMIT"

if [ -d "$INSTALL_DIR/.git" ]; then
  case ${shellEsc(g.onExisting)} in
    fail)
      echo "a checkout already exists at $INSTALL_DIR and onExisting is 'fail'" >&2
      exit 1
      ;;
    fresh)
      # Only the code is replaced. dataDir holds the learned skills, the
      # sessions, and the memory, and none of that is reconstructible.
      MOVED="$INSTALL_DIR.replaced-$(date -u +%Y%m%d-%H%M%S)"
      echo "moving the existing checkout to $MOVED" >&2
      mv "$INSTALL_DIR" "$MOVED"
      echo "MOVED=$MOVED"
      ;;
  esac
fi

INSTALLER="$(mktemp "\${TMPDIR:-/tmp}/hermes-install.XXXXXX")"
trap 'rm -f "$INSTALLER"' EXIT
curl -fsSL --max-time 120 -o "$INSTALLER" ${
          shellEsc(RAW_BASE)
        }/"$COMMIT"/scripts/install.sh

# The transcript goes to a log file on the target rather than to this script's
# stderr, and is tailed back afterwards. That is deliberate: the installer's
# Playwright step leaves orphaned processes behind, and an orphan that inherited
# this script's stderr keeps the pipe open long after the install is done. Let
# the orphans hold a log file instead of the pipe the orchestrator is reading.
#
# </dev/null matters for the same family of reason: this script arrived on
# bash's own stdin, so an installer that read stdin would eat the rest of it.
LOG="$DATA_DIR/install-$(date -u +%Y%m%d-%H%M%S).log"
mkdir -p "$DATA_DIR"
echo "installer transcript: $LOG" >&2
set +e
timeout ${Math.floor(g.installTimeoutSeconds)} bash "$INSTALLER" ${
          flags.join(" ")
        } \\
  --branch main \\
  --commit "$COMMIT" \\
  --hermes-home "$DATA_DIR" \\
  --dir "$INSTALL_DIR" </dev/null >"$LOG" 2>&1
RC=$?
set -e
tail -n 40 "$LOG" >&2 || true
echo "LOG=$LOG"

if [ "$RC" -eq 124 ]; then
  echo "the installer exceeded its ${
          Math.floor(g.installTimeoutSeconds)
        }s cap and was killed" >&2
  exit 124
fi
if [ "$RC" -ne 0 ]; then
  echo "the installer exited $RC" >&2
  exit "$RC"
fi

${HERMES_BIN_FRAGMENT}
if [ -z "$HERMES_BIN" ]; then
  echo "the installer exited 0 but left no hermes command in ~/.local/bin or /usr/local/bin" >&2
  exit 1
fi
echo "HERMES_BIN=$HERMES_BIN"
echo "VERSION=$("$HERMES_BIN" --version 2>/dev/null | head -1 || echo unknown)"
echo "HEAD=$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "INSTALL_DIR=$INSTALL_DIR"
`;

        const { stdout, stderr } = await runScript(script, {
          signal: ctx.signal,
          transport: transportFor(g),
        });
        const kv = parseKv(stdout);

        const commit = kv.COMMIT ?? "";
        const head = kv.HEAD ?? "";
        if (head && commit && head !== commit) {
          // Worth failing on rather than recording quietly. It means the
          // checkout is not at the ref that was asked for, so every later
          // method would be configuring code nobody chose.
          throw new Error(
            `the installer left ${installDir} at ${head}, not the requested ${commit}. The install is not at the pinned ref.`,
          );
        }

        const tail = stripAnsi(stderr).trimEnd().split("\n").slice(-5).join(
          "\n",
        );
        ctx.logger.info("Installer finished. Last lines:\n{tail}", { tail });

        // `hermes --version` prints "Hermes Agent v0.20.4 (2026.8.18)". Keep the
        // whole line, but also pull the version out on its own so the history is
        // queryable — `data.latest(…).attributes.hermesVersion` should give you
        // something you can compare, not a sentence you have to parse.
        const versionRaw = kv.VERSION ?? "unknown";
        const hermesVersion = parseHermesVersion(versionRaw);

        const previousCommit = prior?.commit ?? "";
        const previousVersion = prior?.hermesVersion ?? "";
        const changed = previousCommit !== commit;

        if (previousCommit && changed) {
          ctx.logger.info(
            "Hermes moved {from} → {to} ({fromCommit} → {toCommit})",
            {
              from: previousVersion || "unknown",
              to: hermesVersion,
              fromCommit: previousCommit.slice(0, 12),
              toCommit: commit.slice(0, 12),
            },
          );
        }

        const handle = await ctx.writeResource("install", "install", {
          ref: g.ref,
          commit,
          hermesVersion,
          hermesVersionRaw: versionRaw,
          previousCommit,
          previousVersion,
          changed,
          installPath: kv.INSTALL_DIR ?? installDir,
          commandPath: kv.HERMES_BIN ?? "",
          logPath: kv.LOG ?? "",
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    configure: {
      description:
        "Render the Hermes .env from the configured environment. Written whole, at mode 0600, through a base64 payload inside a stdin-fed script, so no secret reaches argv or local disk. Removing a key from the definition removes it from the running agent.",
      arguments: z.object({}),
      execute: async (_args: unknown, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;

        // Also checked here, not only in preflight: rotating a token through
        // `configure` alone is the common path, and adding a platform that way
        // must not skip the allowlist check just because it bypassed preflight.
        const problems = [
          ...validateEnv(g.env),
          ...(g.installGatewayService ? validatePlatformAllowlists(g.env) : []),
        ];
        if (problems.length > 0) {
          throw new Error(
            `configure refused ${problems.length} environment problem(s):\n- ${
              problems.join("\n- ")
            }`,
          );
        }

        const keysWritten = Object.keys(g.env).sort();
        ctx.logger.info("Writing {count} environment key(s) to the .env", {
          count: keysWritten.length,
        });

        const script = `
DATA_DIR="$(expand_home ${shellEsc(g.dataDir)})"
ENV_PATH="$DATA_DIR/.env"
${writeFileScript('"$ENV_PATH"', renderEnvFile(g.env), "0600")}
echo "ENV_PATH=$ENV_PATH"
echo "MODE=$(stat -c '%a' "$ENV_PATH" 2>/dev/null || echo unknown)"
`;

        const { stdout } = await runScript(script, {
          signal: ctx.signal,
          transport: transportFor(g),
        });
        const kv = parseKv(stdout);

        if (kv.MODE !== "600") {
          throw new Error(
            `the .env was written but its mode is ${
              kv.MODE ?? "unreadable"
            }, not 600. It holds API keys on a host running an autonomous agent.`,
          );
        }

        const handle = await ctx.writeResource("configure", "configure", {
          envPath: kv.ENV_PATH ?? "",
          keysWritten,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    service: {
      description:
        "Install, enable, and start the systemd user unit for the messaging gateway, and turn on lingering so it survives logout and comes back at boot. Restarts rather than starts, so it is also how a re-run of configure takes effect.",
      arguments: z.object({}),
      execute: async (_args: unknown, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;

        if (!g.installGatewayService) {
          throw new Error(
            "installGatewayService is false, so this model does not manage the gateway unit. Set it true, or start the gateway yourself with `hermes gateway`.",
          );
        }

        ctx.logger.info("Installing and starting the {unit} user unit", {
          unit: GATEWAY_UNIT,
        });

        const script = `
DATA_DIR="$(expand_home ${shellEsc(g.dataDir)})"
${USER_BUS_FRAGMENT}
export HERMES_HOME="$DATA_DIR"
${HERMES_BIN_FRAGMENT}
if [ -z "$HERMES_BIN" ]; then
  echo "no hermes command found — run the install method first" >&2
  exit 1
fi

if [ ! -f "$DATA_DIR/.env" ]; then
  echo "no .env at $DATA_DIR/.env — run the configure method first, or the gateway starts with no credentials" >&2
  exit 1
fi

${
          g.enableLinger
            ? `
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != "yes" ]; then
  sudo -n loginctl enable-linger "$(id -un)" >&2
fi
`
            : ""
        }
echo "LINGER=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)"

# Enabling lingering starts user@$UID.service, and that takes a moment. Without
# this wait the very next \`systemctl --user\` can lose the race and fail with
# "Failed to connect to bus" on exactly the host where everything is correct.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if systemctl --user show-environment >/dev/null 2>&1; then break; fi
  sleep 2
done
if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "no systemd user bus at $DBUS_SESSION_BUS_ADDRESS after waiting 20s." >&2
  echo "The gateway is a user unit, so it cannot be managed without one. Enable lingering for $(id -un), or open a login session." >&2
  exit 1
fi

# Upstream writes the unit, reloads, and enables. Reusing it means this model
# does not carry a second copy of the unit file to drift out of date.
"$HERMES_BIN" gateway install >&2
systemctl --user daemon-reload
systemctl --user enable ${GATEWAY_UNIT} >&2
systemctl --user restart ${GATEWAY_UNIT} >&2

# Type=simple reports "active" the moment it forks, so a unit that dies on a
# missing key would still look healthy for a second or two.
sleep 3
echo "ENABLED=$(systemctl --user is-enabled ${GATEWAY_UNIT} 2>/dev/null || echo unknown)"
echo "ACTIVE=$(systemctl --user is-active ${GATEWAY_UNIT} 2>/dev/null || echo unknown)"
`;

        const { stdout } = await runScript(script, {
          signal: ctx.signal,
          transport: transportFor(g),
        });
        const kv = parseKv(stdout);

        const enabled = kv.ENABLED === "enabled";
        const active = kv.ACTIVE === "active";
        const linger = kv.LINGER === "yes";

        const handle = await ctx.writeResource("service", "service", {
          unit: GATEWAY_UNIT,
          enabled,
          active,
          linger,
          timestamp: new Date().toISOString(),
        });

        if (!active) {
          // Reporting "installed" for a unit that is failing would be the
          // exact "the installer exited 0" claim this model exists to avoid.
          const { stdout: logs } = await runProbe(
            `${USER_BUS_FRAGMENT}
journalctl --user -u ${GATEWAY_UNIT} -n 20 --no-pager 2>&1 || true`,
            { signal: ctx.signal, transport: transportFor(g) },
          );
          throw new Error(
            `${GATEWAY_UNIT} is ${
              kv.ACTIVE ?? "unknown"
            }, not active. Last log lines:\n${stripAnsi(logs).trimEnd()}`,
          );
        }

        ctx.logger.info("{unit} is enabled and active, linger {linger}", {
          unit: GATEWAY_UNIT,
          linger: linger ? "on" : "off",
        });
        return { dataHandles: [handle] };
      },
    },

    verify: {
      description:
        "Confirm Hermes actually answers: the command runs, the checkout sits at the pinned commit, the .env is present and private, and the gateway unit is enabled and active. `hermes doctor` is recorded for diagnosis but never trusted as the verdict, because it exits 0 whatever it finds.",
      arguments: z.object({}),
      execute: async (_args: unknown, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;
        const installDir = resolveInstallDir(g);

        const script = `
DATA_DIR="$(expand_home ${shellEsc(g.dataDir)})"
INSTALL_DIR="$(expand_home ${shellEsc(installDir)})"
${USER_BUS_FRAGMENT}
export HERMES_HOME="$DATA_DIR"
${HERMES_BIN_FRAGMENT}
echo "HERMES_BIN=$HERMES_BIN"

if [ -n "$HERMES_BIN" ]; then
  echo "VERSION=$("$HERMES_BIN" --version 2>/dev/null | head -1 || echo unknown)"
else
  echo "VERSION=unknown"
fi

echo "HEAD=$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ -f "$DATA_DIR/.env" ]; then
  echo "ENV=yes"
  echo "ENV_MODE=$(stat -c '%a' "$DATA_DIR/.env" 2>/dev/null || echo unknown)"
else
  echo "ENV=no"
  echo "ENV_MODE=none"
fi

echo "ENABLED=$(systemctl --user is-enabled ${GATEWAY_UNIT} 2>/dev/null || echo unknown)"
echo "ACTIVE=$(systemctl --user is-active ${GATEWAY_UNIT} 2>/dev/null || echo unknown)"

${resolveCommitFragment(g.ref)}
echo "COMMIT=\${COMMIT:-unknown}"

# doctor exits 0 whether it found nothing or found twenty things, so the count
# comes from its own summary line rather than from $?. No ANSI stripping is
# needed: doctor colours the line as a whole, so "Found 3 issue" survives
# contiguously between the escape sequences. It also makes network calls, hence
# the cap.
if [ -n "$HERMES_BIN" ]; then
  DOCTOR="$(timeout 180 "$HERMES_BIN" doctor 2>&1 </dev/null || true)"
  echo "DOCTOR_RAN=yes"
  echo "DOCTOR_ISSUES=$(printf '%s\\n' "$DOCTOR" | sed -n 's/.*[Ff]ound \\([0-9][0-9]*\\) issue.*/\\1/p' | head -1)"
else
  echo "DOCTOR_RAN=no"
fi
`;

        const { stdout } = await runProbe(script, {
          signal: ctx.signal,
          transport: transportFor(g),
        });
        const kv = parseKv(stdout);

        const hermesVersion = parseHermesVersion(kv.VERSION ?? "unknown");
        const head = kv.HEAD ?? "unknown";
        const commit = kv.COMMIT ?? "unknown";
        const gatewayActive = kv.ACTIVE === "active";

        const checks: Record<string, boolean> = {
          commandPresent: Boolean(kv.HERMES_BIN),
          versionAnswers: hermesVersion !== "unknown" && hermesVersion !== "",
          atPinnedCommit: head !== "unknown" && head === commit,
          envPresent: kv.ENV === "yes",
          envPrivate: kv.ENV_MODE === "600",
        };
        if (g.installGatewayService) {
          checks.gatewayEnabled = kv.ENABLED === "enabled";
          checks.gatewayActive = gatewayActive;
        }

        const explain: Record<string, string> = {
          commandPresent:
            "no hermes command in ~/.local/bin or /usr/local/bin, so nothing was installed where the installer links it.",
          versionAnswers:
            "the hermes command exists but `hermes --version` did not answer, so the install is present and broken.",
          atPinnedCommit:
            `the checkout is at ${head}, and ref ${g.ref} resolves to ${commit}.`,
          envPresent:
            "no .env in the data directory, so the agent has no credentials. Run configure.",
          envPrivate:
            `the .env is mode ${kv.ENV_MODE}, not 600, so its API keys are readable by other users on the host.`,
          gatewayEnabled:
            `the ${GATEWAY_UNIT} unit is ${kv.ENABLED}, so it will not come back after a reboot.`,
          gatewayActive:
            `the ${GATEWAY_UNIT} unit is ${kv.ACTIVE}, not active.`,
        };

        const failures = Object.entries(checks)
          .filter(([, passed]) => !passed)
          .map(([name]) => explain[name] ?? `${name} failed.`);

        const doctorIssues = Number(kv.DOCTOR_ISSUES ?? "0") || 0;
        if (doctorIssues > 0) {
          ctx.logger.info(
            "`hermes doctor` reports {count} issue(s). Recorded, not fatal — run it on the host to read them.",
            { count: doctorIssues },
          );
        }

        const handle = await ctx.writeResource("verify", "verify", {
          ok: failures.length === 0,
          hermesVersion,
          gatewayActive,
          checks,
          failures,
          doctorIssues,
          timestamp: new Date().toISOString(),
        });

        if (failures.length > 0) {
          throw new Error(
            `verify failed ${failures.length} check(s):\n- ${
              failures.join("\n- ")
            }`,
          );
        }

        ctx.logger.info("Hermes answers: {version}, pinned at {commit}", {
          version: hermesVersion,
          commit: commit.slice(0, 12),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
