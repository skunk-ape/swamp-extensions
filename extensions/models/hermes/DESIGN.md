# @skunk-ape/hermes — design

Status: design. No code yet.

Install and configure the [Hermes agent](https://hermes-agent.org/) on a Linux
host reached over SSH. Hermes is an autonomous agent from Nous Research that
runs on a host you own, keeps memory across sessions, and writes its own skills
as it works.

## The problem with the upstream install

Upstream ships one command:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

That script is interactive. It prompts about system packages, about PATH edits,
and about what to do with an existing install, and then it runs a setup wizard
that asks for API keys. It also tracks `main` rather than a pinned ref.

Wrapping that command in a model adds nothing. The value of this extension is
the inversion: **every choice the wizard asks for at runtime becomes a field in
the model definition, decided once, in version control, before anything touches
the host.** A declarative install is reviewable, re-runnable, and diffable. An
interactive one is none of those.

## Scope

In scope: get a host from unconfigured to a running Hermes.

Out of scope, deliberately:

- **Making the host exist.** Provisioning is a separate concern with a separate
  lifecycle. See "Target" below.
- **Day-two configuration.** `@mgreten/hermes-env` and `@mgreten/hermes-config`
  already cover env-var and model-config management on a running install. See
  "Overlap" below.

## Target

**The contract is an SSH destination.** The extension does not create the
machine, and it holds no opinion about where the machine came from. This keeps
one install path across every host type:

| Host | How it becomes an SSH destination |
| --- | --- |
| Lima VM on macOS | `limactl` writes `~/.lima/<name>/ssh.config`; the destination is `lima-<name>` |
| VMware, UTM, libvirt | Ordinary SSH |
| EC2 or any cloud instance | Ordinary SSH |
| The local machine | `ssh localhost`, with no special-case code path |

This decoupling is an established pattern in the ecosystem, not an invention
here. `@evrardjp/libvirt-vm-pool` reconciles a VM pool and "publishes per-VM
connection facts for downstream SSH/config models." This is the downstream
model in that arrangement.

### The intended first target is a Lima VM

Lima is a lightweight Linux VM on macOS. It suits Hermes better than a direct
macOS install for four reasons:

1. **systemd exists.** The gateway service is the documented upstream path
   rather than a launchd port written and maintained here.
2. **Blast radius is contained.** The installer wants sudo for ripgrep, ffmpeg,
   and build tools, edits shell rc files, and pulls Node and Chromium. All of
   that lands inside the VM.
3. **Uninstall is real.** `limactl delete` is a rollback that a direct macOS
   install cannot offer. Nobody can un-edit a `.zshrc` with confidence.
4. **The template is a reviewable artifact.** VM shape as declarative YAML beats
   a pile of shell.

Two Lima settings are load-bearing and must be set deliberately:

- **`mounts: []`.** The Lima 2.x default template mounts nothing, but several
  stock templates mount `~`. An autonomous agent with shell access and the
  user's home directory mounted is not isolated. Pin an explicit template so an
  upstream default change cannot widen this.
- **`limactl autostart`** registers a LaunchAgent, which covers "runs whenever
  the Mac is running."

The honest limitation: a laptop VM suspends on sleep. Scheduled skills do not
fire overnight and inbound messages wait for the lid to open. Hermes is sold as
an always-on assistant, and a laptop is an intermittent host. This is the real
argument for moving to EC2 later, and the state design below is what makes that
move cheap.

## Passwordless sudo, and why the VM boundary is what permits it

There are two grants, not one:

- **Install-time sudo**, for system packages. Narrow and one-shot.
- **Runtime sudo.** An agent that writes its own skills to solve problems it has
  not seen will want to install things nobody anticipated. Withholding this
  makes the agent worse at its purpose.

Runtime sudo is the real ask, and **the VM is what makes it grantable**. On a
Mac it is a bad trade. Inside a disposable VM with no host mounts, root is
bounded by the VM and the answer becomes easy.

The boundary is therefore load-bearing security rather than convenience. Two
things follow. The VM must not hold credentials to anything beyond what Hermes
needs, because an SSH key or a cloud credential inside it is the escape path,
not the sudo. And network egress from the VM is the remaining exposure, so it
gets decided rather than defaulted.

## State: what is preserved and what is disposable

Hermes keeps `~/.hermes` on the target: config, `.env`, skills, sessions, logs.
The product's whole claim is that this compounds over time, so any target that
throws it away defeats the point.

An agent with root that mutates its own machine for months produces a VM whose
drifted state is not reconstructible. So the model is not "back up the machine."
It is:

| Class | Examples | Handling |
| --- | --- | --- |
| Regenerable | `.env`, API keys | Rebuilt from swamp vault. **Never backed up.** |
| Irreplaceable | learned skills, memory, sessions | Backed up. The only thing that must survive. |
| Disposable | OS packages, drift, logs | Rebuilt by `install`. |

Backing up `~/.hermes` wholesale would walk the secrets straight back across the
isolation boundary. Splitting it makes restore mean "fresh host, plus vault,
plus preserved state" — which is the same operation as migrating to EC2. Getting
this split right now is what keeps a later move from being a rewrite.

## Reuse

Per repository rule 1, search before building. Rule 10 is sharper:
`command/shell` is for ad-hoc one-off commands and never for wrapping a CLI or
building an integration. So this extension does **not** author an SSH transport.

- **`@keeb/ssh` — evaluated, and it cannot carry this design.** See "Transport"
  below. Pulled anyway, because its skill is good documentation and other
  `@keeb/*` extensions build on it.
- **`@magistr/observability-agent` — the structural precedent, and the transport
  pattern to copy.** It installs and configures a host-native agent on a remote
  Debian host over SSH, with `install`, `configure`, `status`, and `inventory`.
  It arrived at nearly this method split independently. Notably it does **not**
  use `@keeb/ssh` either. It spawns `ssh` itself.
- **`@whitemars/colima`** manages a Colima VM on macOS through the local CLI.
  Colima is Lima-based, so it is the closest prior art for the provisioning half
  that this extension omits. No general-purpose Lima extension exists yet. That
  is an available gap if the provisioning half is ever wanted.

### Overlap with the existing Hermes extensions

Three Hermes extensions are already published, and all three assume Hermes is
**already installed**:

| Extension | What it covers |
| --- | --- |
| `@mgreten/hermes-env` | `setEnv`, `removeEnv`, `listKeys`, `restartGateway`, `rotateSwampKey`, over SSH or in-container |
| `@mgreten/hermes-config` | Main model, auxiliary task overrides, gateway restart |
| `@webframp/hermes-kanban-orchestrator` | Kanban tasks through the `hermes` CLI |

Nobody has published the install. **That is the actual gap, and it narrows this
extension usefully:** `preflight`, `install`, and `service` are unserved, while
day-two config is largely covered.

Note that `@mgreten/hermes-env` recreates a container, so it assumes a
containerized Hermes rather than systemd on a VM. The overlap is partial.

**Open decision.** Keep `configure` in scope for first-boot `.env` seeding,
since the gateway cannot start without it, and defer ongoing env mutation to
`@mgreten/hermes-env` if its container assumption can be relaxed. Confirm by
reading its source before writing a `configure` method.

## Transport

### Where the model runs

Driving the host over SSH is not the only option. Swamp could instead run on the
VM, and the install could be a local run. Three shapes:

| | Control plane | Execution | SSH transport needed |
| --- | --- | --- | --- |
| **A. Remote-drive** | Mac | Remote, over SSH | Yes |
| **B. Swamp on the VM** | The VM itself | Local | No |
| **C. Worker enrollment** | Mac | Local on the VM | No |

**B is genuinely tempting.** Every sharp edge in the next section disappears:
port, identity, stdin, `BatchMode`, host keys, the unenforced timeout, shell
quoting. Local execution gives true exit codes and streaming output. The
bootstrap is not even circular, because Lima `provision:` scripts can install
swamp on first boot, declared in the template this extension already ships.

**B is rejected as the default, because it moves a credential to the wrong side
of the boundary.** The rule above says the VM must not hold credentials for
anything beyond what Hermes needs, since a key inside it is the escape path
rather than the sudo. A full swamp install puts the swamp-club auth token on the
VM, and that token can publish to the registry under `@skunk-ape`. The chain is
short: agent, then root, then token, then publish.

In fairness to B, `.env` holds Hermes's own API keys on the VM either way. The
marginal exposure is other vault entries plus registry auth.

If B is ever wanted for a personal box, the mitigation is specific. Install
swamp on the VM but never run `swamp auth` there, and give it a vault holding
only Hermes's keys. That makes B's blast radius roughly equal to A's.

**The decision is to not decide yet.** Put a seam in: one function, roughly
`runScript(script) → stdout`, in the `bash -s` plus `parseKv` shape described
below. SSH is one implementation. Local is about twenty lines. The install
scripts, the idempotency guards, and the `KEY=value` parsing are identical
across all three shapes, so the architecture can change without touching the
install.

**Build on A first.** It works today and depends on nothing experimental. See
open question 7 for C, which is the better destination if it checks out.

### Why not `@keeb/ssh` for the SSH implementation

Repository rule 1 says search before building, so `@keeb/ssh` was pulled and
read. **It cannot carry this design.** The gaps are in the transport primitives
rather than in a missing method, and `sshExec` builds its argv inline, so
`export const extension` cannot reach them. Read from
`.swamp/pulled-extensions/@keeb/ssh/models/lib/ssh.ts`:

| Gap | Consequence here |
| --- | --- |
| No `port`. Target is `user@host` with no `-p`. | Cannot reach a Lima VM, which listens on `127.0.0.1:<random high port>`. |
| No identity file and no `-F` config file. | Lima's key is `~/.lima/_config/user`, not a default key name. |
| `exec` passes the command in argv, with no stdin. | A secret cannot be written safely. `upload` is no escape, because it needs a local file, which puts the secret on local disk. |
| `StrictHostKeyChecking=no` and `UserKnownHostsFile=/dev/null`, both hardcoded. | No host key verification at all, ever, and not configurable. Tolerable for a loopback VM. Not tolerable for EC2. |
| `timeout` is accepted but never enforced. Its own skill documents this. | The Hermes install pulls Node 26, Chromium, and Python. A hang has no cap. |
| `exec` throws on any non-zero exit. `sshExecRaw` exists but is not exposed. | Every probe must be written to always exit 0 and put its answer on stdout. |

**Decision: author a minimal `_lib/ssh.ts` modeled on
`@magistr/observability-agent`.** Its helper solves each of the above:

- **`bash -s` with the script fed over stdin.** The script never appears in
  argv, which is what makes secret handling safe.
- **`BatchMode=yes`.** Any prompt fails immediately instead of hanging. This is
  the direct answer to the interactive-installer risk, and it is stronger than
  passing `--skip-setup` and hoping.
- **`StrictHostKeyChecking=accept-new`.** Trust on first use, so later
  connections are actually verified. Not a blanket bypass.
- **`-p` for port.**
- **A `writeRemoteFile` helper** that base64-encodes content and emits
  `echo '<b64>' | base64 -d > path` inside the stdin-fed script. The secret
  touches neither argv nor local disk. This is how `.env` gets written.
- **A `parseKv` helper.** Remote scripts emit `KEY=value` on stdout and the
  model parses that into typed resources, which is how a shell-driven install
  still produces structured data.

Its `install` is also the idempotency model to copy: `set -euo pipefail`,
`DEBIAN_FRONTEND=noninteractive`, and a `command -v` guard around the expensive
step.

The better long-term move is to contribute port, identity, stdin, and host-key
options upstream to `@keeb/ssh`, which would let this extension drop its own
helper. Worth opening as an issue against `keeb/swamp-ssh` either way.

### Reaching a Lima VM needs no code

Lima writes `~/.lima/<name>/ssh.config`. Adding `Include ~/.lima/*/ssh.config`
to `~/.ssh/config` makes `lima-<name>` a resolvable destination, and `ssh` then
supplies the port and the identity itself. Any ssh-based transport reaches the
VM with `host: lima-hermes` and no Lima-specific code. Document this as the
setup step rather than shelling out to `limactl`.

## Methods

Every method reaches the host through the one `runScript` seam, so every host
type and every transport shape looks identical to the install logic.

| Method | What it does |
| --- | --- |
| `preflight` | Assert OS and arch, systemd present, passwordless sudo, disk space, network egress. Validate the whole config, including every vault reference. Change nothing. |
| `install` | Clone at a pinned ref and run the installer fully non-interactively. Idempotent. |
| `configure` | Render `~/.hermes/.env` from vault. Mode 0600, written over stdin. |
| `service` | Install and enable the systemd unit for the gateway. |
| `verify` | Confirm Hermes actually answers. Not "the installer exited 0." |

### Rules the method split has to honor

- **Validate before touching the host.** A mistyped vault reference must fail in
  `preflight`, not after Chromium has downloaded. This is cheap to build and it
  is most of the felt quality difference.
- **Never assume a TTY, and fail rather than hang.** The upstream prompts block
  on a non-TTY SSH pipe. `BatchMode=yes` turns a block into an immediate error,
  which is the safety net. Drive with `--skip-setup` and answer the package
  prompt explicitly so the net is never needed. Detect an existing install
  first and choose update or fresh deliberately, so a re-run is idempotent by
  design rather than by luck.
- **Cap every long step remotely.** `ssh` enforces no wall-clock limit, and the
  Chromium and Node steps are slow enough to look identical to a hang. Wrap
  them in a remote `timeout(1)` so a stall fails on a schedule.
- **Keep install-time and runtime config separate.** Which packages and which
  ref are one-time and shape the box. Which API key and which gateway platforms
  change often. If `configure` runs without a reinstall, rotating a key takes
  seconds instead of a rebuild. Collapsing the two is what would make this
  annoying by month two.
- **Never put a secret in a command argument, or on local disk.** Remote process
  arguments and shell history are both readable, and a local temp file defeats
  the point of holding the secret in a vault. Base64 the content into a script
  fed over stdin, per `writeRemoteFile` above.
- **Stay out of `grants/sandbox.yaml`.** This model reaches outward, and the
  caveat in that file says outward-facing models run from the host.

## Open questions

1. **Playwright and Chromium on arm64 Linux under Lima `vz`.** The installer
   pulls them unconditionally and it is the heaviest step. Verify rather than
   assume.
2. **QR pairing for WhatsApp and Signal on a headless host.** Pairing is
   normally an ASCII QR in the terminal, which SSH carries, but confirm it.
3. **Egress policy for the VM.** Hermes needs outbound to model APIs and to
   messaging platforms. Decide what else, if anything.
4. **Gateway inbound.** Most messaging platforms are outbound-only. Anything
   webhook-based needs a Lima `portForwards` entry.
5. **`@mgreten/hermes-env` reuse**, per the open decision above.
6. **Resource floor.** Chromium, Python, and Node in one VM. The Lima default is
   4 CPU and 4 GiB. Confirm that is enough.
7. **Shape C, worker enrollment — the open experiment.** This is the better
   destination if it checks out, because it deletes the SSH transport while
   keeping the control plane off the VM.

   `swamp worker connect` takes an enrollment token shaped `<name>.<secret>`,
   dials an orchestrator, and receives bundles. The repo and the definitions
   stay on the Mac and the work runs locally on the VM.

   **The decisive unknown is where vault resolution happens.** If the
   orchestrator resolves vault references and the worker never holds the vault,
   C is strictly better than A and B together. If the worker resolves them, C
   collapses into B and inherits B's credential problem.

   The probe is `swamp worker verify`, which exercises enrollment, scheduling,
   capability RPC, and data plane connectivity. Run it against a throwaway
   instance with a vault-referencing method and observe which side reads the
   vault. Do not infer this from documentation.

   Caveat: `swamp worker daemon` is marked EXPERIMENTAL. C is an elegant answer
   on a surface that still moves, which is the reason to build A first rather
   than wait for this.

## Rejected

- **Swamp installed on the VM as the default architecture**, shape B above. It
  is rejected for its credential posture rather than its ergonomics, which are
  better than A's. The `runScript` seam keeps it reachable.
- **Direct macOS install.** No systemd, no clean uninstall, and it mutates the
  machine the user cares about. Reachable anyway through `ssh localhost` if it
  is ever wanted, at no extra cost.
- **Provisioning inside this extension.** EC2 support would be mostly AMI, VPC,
  security group, key pair, teardown, and cost. The Hermes install is a small
  fraction of that work, and it is the fraction this extension is about.
- **A container image.** Viable, and `@mgreten/hermes-env` implies somebody runs
  Hermes this way. It was not chosen because the persistent-state story needs
  volumes to be designed up front, and because a VM makes the runtime sudo
  question easy.
