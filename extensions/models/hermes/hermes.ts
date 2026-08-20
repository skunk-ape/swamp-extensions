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
 */
import { z } from "npm:zod@4";
import { parseKv, runScript, shellEsc } from "./_lib/exec.ts";

// Swamp wires args and context at runtime; the model loader does not expose
// types for them.
// deno-lint-ignore no-explicit-any
type Ctx = any;

// --- configuration -------------------------------------------------------

const GlobalArgsSchema = z.object({
  ref: z.string().describe(
    "Git ref of NousResearch/hermes-agent to install. Required with no default on purpose — tracking `main` is the upstream behaviour this model exists to replace.",
  ),
  dataDir: z.string().default("~/.hermes").describe(
    "Hermes data directory on the target. Holds config, skills, sessions, and the .env this model writes.",
  ),
  installSystemPackages: z.boolean().default(true).describe(
    "Install ripgrep and ffmpeg. Needs passwordless sudo. Skipping degrades some skills.",
  ),
  onExisting: z.enum(["update", "fresh", "fail"]).default("update").describe(
    "What to do when Hermes is already installed. Decided here rather than by an interactive prompt that would hang.",
  ),
  installGatewayService: z.boolean().default(true).describe(
    "Install and enable the systemd unit for the messaging gateway.",
  ),
  gatewayPlatforms: z.array(z.string()).default([]).describe(
    "Messaging platforms the gateway should enable, e.g. telegram, discord.",
  ),
  env: z.record(z.string(), z.string()).default({}).describe(
    'Environment written to the Hermes .env. Source secrets from a vault, e.g. { ANTHROPIC_API_KEY: \'${{ vault.get("hermes", "anthropic-key") }}\' }. Keep every vault reference static and literal — a dynamically constructed reference forfeits the per-step secret allowlist.',
  ),
  minDiskGb: z.number().default(20).describe(
    "Free space preflight requires. Chromium, Node, and a Python toolchain are the bulk of it.",
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
  passwordlessSudo: z.boolean(),
  diskFreeGb: z.number(),
  egress: z.boolean(),
  existingInstall: z.boolean(),
  timestamp: z.string(),
});

const InstallSchema = z.object({
  ref: z.string(),
  hermesVersion: z.string(),
  installPath: z.string(),
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
  timestamp: z.string(),
});

const VerifySchema = z.object({
  ok: z.boolean(),
  hermesVersion: z.string(),
  gatewayActive: z.boolean(),
  checks: z.record(z.string(), z.boolean()),
  timestamp: z.string(),
});

const notImplemented = (method: string): never => {
  throw new Error(
    `${method} is not implemented yet — see DESIGN.md. preflight is the only method built so far.`,
  );
};

/**
 * Swamp model definition for `@skunk-ape/hermes`.
 *
 * One model instance targets one host. `globalArguments` holds the install
 * decisions — the pinned ref, whether system packages may be installed, what
 * to do with an existing install, and the environment to write — so that the
 * upstream installer's interactive prompts never arise.
 */
export const model = {
  type: "@skunk-ape/hermes",
  version: "2026.08.19.1",
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
      description: "The installed ref, resolved version, and path.",
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
        "Assert the host can take an install: OS and arch, systemd, passwordless sudo, free space, and egress. Validates config and changes nothing, so a mistyped vault reference fails here rather than after Chromium has downloaded.",
      arguments: z.object({}),
      execute: async (_args: unknown, ctx: Ctx) => {
        const g = ctx.globalArgs as GlobalArgs;

        // Every probe answers on stdout and exits 0. An exit code here would
        // mean "the probe could not run", not "the answer is no".
        const script = `
OS="$(uname -s)"
ARCH="$(uname -m)"
echo "OS=$OS"
echo "ARCH=$ARCH"

if command -v systemctl >/dev/null 2>&1; then echo "SYSTEMD=yes"; else echo "SYSTEMD=no"; fi

if sudo -n true >/dev/null 2>&1; then echo "SUDO=yes"; else echo "SUDO=no"; fi

DATA_DIR=${shellEsc(g.dataDir)}
CHECK_DIR="$(eval echo "$DATA_DIR")"
PARENT="$(dirname "$CHECK_DIR")"
KB="$(df -Pk "$PARENT" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "$KB" ]; then echo "DISK_GB=$((KB / 1024 / 1024))"; else echo "DISK_GB=0"; fi

if curl -fsS --max-time 10 -o /dev/null https://github.com 2>/dev/null; then
  echo "EGRESS=yes"
else
  echo "EGRESS=no"
fi

if [ -d "$CHECK_DIR" ]; then echo "EXISTING=yes"; else echo "EXISTING=no"; fi
`;

        const { stdout } = await runScript(script);
        const kv = parseKv(stdout);

        const os = kv.OS ?? "unknown";
        const arch = kv.ARCH ?? "unknown";
        const systemd = kv.SYSTEMD === "yes";
        const passwordlessSudo = kv.SUDO === "yes";
        const diskFreeGb = Number(kv.DISK_GB ?? "0");
        const egress = kv.EGRESS === "yes";
        const existingInstall = kv.EXISTING === "yes";

        const failures: string[] = [];
        if (os !== "Linux") {
          failures.push(
            `host is ${os}, and this model installs onto Linux. macOS has no systemd, so the gateway has no supported service path.`,
          );
        }
        if (!systemd && g.installGatewayService) {
          failures.push(
            "installGatewayService is true but systemctl is absent, so the gateway unit cannot be installed.",
          );
        }
        if (!passwordlessSudo && g.installSystemPackages) {
          failures.push(
            "installSystemPackages is true but sudo needs a password. The installer would block on a prompt.",
          );
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
        if (existingInstall && g.onExisting === "fail") {
          failures.push(
            `Hermes is already installed at ${g.dataDir} and onExisting is "fail".`,
          );
        }

        const handle = await ctx.writeResource("preflight", "preflight", {
          ok: failures.length === 0,
          failures,
          os,
          arch,
          systemd,
          passwordlessSudo,
          diskFreeGb,
          egress,
          existingInstall,
          timestamp: new Date().toISOString(),
        });

        if (failures.length > 0) {
          throw new Error(
            `preflight failed with ${failures.length} problem(s):\n- ${
              failures.join("\n- ")
            }`,
          );
        }

        return { dataHandles: [handle] };
      },
    },

    install: {
      description:
        "Clone at the pinned ref and run the upstream installer fully non-interactively. Idempotent.",
      arguments: z.object({}),
      execute: (_args: unknown, _ctx: Ctx) => notImplemented("install"),
    },

    configure: {
      description:
        "Render the Hermes .env from configured environment values. Written 0600 through a base64 payload in a stdin-fed script, so no secret reaches argv or local disk.",
      arguments: z.object({}),
      execute: (_args: unknown, _ctx: Ctx) => notImplemented("configure"),
    },

    service: {
      description:
        "Install and enable the systemd unit for the messaging gateway.",
      arguments: z.object({}),
      execute: (_args: unknown, _ctx: Ctx) => notImplemented("service"),
    },

    verify: {
      description:
        "Confirm Hermes actually answers, rather than that the installer exited 0.",
      arguments: z.object({}),
      execute: (_args: unknown, _ctx: Ctx) => notImplemented("verify"),
    },
  },
};
