# @skunk-ape/hermes — design

Status: all five methods implemented and verified end to end against a Lima VM
on 2026-08-20, driven as placed steps on an enrolled worker. Both transports are
implemented: local (shape C) and ssh. The sections after "What the upstream
source changed" were written after the code and record where this document was
wrong.

Install and configure the [Hermes agent](https://hermes-agent.org/) on a Linux
host. Hermes is an autonomous agent from Nous Research that runs on a host you
own, keeps memory across sessions, and writes its own skills as it works.

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

> **Superseded.** This section originally opened "the contract is an SSH
> destination", which described shape A. The Transport section below settled on
> shape C instead, and the implementation followed it — but this section was not
> updated, so the document promised SSH for months while the code ran locally.
> Corrected here rather than deleted, because a design record that quietly edits
> away its wrong turns is less useful than one that shows them.

**The contract is a host this model can execute on.** The extension does not
create the machine and holds no opinion about where it came from, but it does
require the ability to run a shell there — and it does not open that connection
itself unless told to. Three ways to satisfy that:

| `transport`                                             | How the target is reached                                                                                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `local`, with a **swamp worker enrolled on the target** | The methods are dispatched to the worker and run locally on it. `lima-hermes.yaml` enrols one on first boot.                              |
| `local`, with **swamp installed on the target**         | Run the methods there directly. Simplest for a machine you already sit on, and the shape the "Rejected" section calls shape B.            |
| `ssh`, with **`sshHost`**                               | The same scripts run over an ssh connection. Added 2026-08-21 — see "The SSH transport, and what reading a neighbour changed" at the end. |

`local` is the default, and it is the one that surprises people: run a method
with no worker and no placement and it installs Hermes onto whatever machine the
method ran on. `preflight` catches the obvious case, since macOS fails its OS
check, but a Linux orchestrator would install onto itself without complaint.

The decoupling from provisioning is an established pattern in the ecosystem, not
an invention here. `@evrardjp/libvirt-vm-pool` reconciles a VM pool and
"publishes per-VM connection facts for downstream SSH/config models." This is
the downstream model in that arrangement, and with the ssh transport in place
those facts are now directly consumable.

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

| Class         | Examples                         | Intended handling                                             |
| ------------- | -------------------------------- | ------------------------------------------------------------- |
| Regenerable   | `.env`, API keys                 | Rebuilt from swamp vault by `configure`. **Never backed up.** |
| Irreplaceable | learned skills, memory, sessions | Should be backed up. The only thing that must survive.        |
| Disposable    | OS packages, drift, logs         | Rebuilt by `install`.                                         |

Backing up `~/.hermes` wholesale would walk the secrets straight back across the
isolation boundary. Splitting it makes restore mean "fresh host, plus vault,
plus preserved state" — which is the same operation as migrating to EC2. Getting
this split right now is what keeps a later move from being a rewrite.

> **Not implemented.** The middle row describes intent, not behaviour: there is
> no `backup` or `restore` method, and nothing in this extension preserves the
> irreplaceable column. `configure` covers the regenerable row and `install`
> covers the disposable one, so two thirds of the table is real and the third is
> a plan.
>
> This is the largest functional gap in the extension, and an uncomfortable one
> to leave open, because compounding state is the entire product claim. Anyone
> relying on this today should treat the target as disposable and take their own
> copy of the data directory — minus `.env`, which is regenerable and must not
> cross the boundary.

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

Re-surveyed 2026-08-21; an earlier pass of this document said three, and the
count has since grown to seven. **All seven assume Hermes is already
installed**, and they fall into two distinct layers:

**Manage an existing install**

| Extension                | Methods                                                               | Downloads |
| ------------------------ | --------------------------------------------------------------------- | --------- |
| `@mgreten/hermes-env`    | `listKeys`, `setEnv`, `removeEnv`, `rotateSwampKey`, `restartGateway` | 11        |
| `@mgreten/hermes-config` | `getConfig`, `setMainModel`, `setAuxiliaryModels`, `restartGateway`   | 12        |

**Use the running agent**

| Extension                              | Methods                                           | Downloads |
| -------------------------------------- | ------------------------------------------------- | --------- |
| `@webframp/hermes-journal-writer`      | `write_daily_entry`                               | 30        |
| `@mgreten/hermes-review-kit`           | `collect`, plus workflows and reports             | 14        |
| `@mgreten/cron-builder`                | `build`, `validate` — cron specs, touches no host | 9         |
| `@webframp/hermes-kanban-orchestrator` | `new_task`, `list_recent`                         | 8         |
| `@mgreten/hermes-interest-signals`     | `aggregate`                                       | 1         |

**Nobody has published the install, and the re-survey strengthens rather than
weakens that claim** — the ecosystem has doubled and still nothing occupies the
bottom layer. The shape is a dependency graph missing its root: install, then
configure, then use, with seven extensions crowded into the top two tiers.

The overlap with this model is therefore narrow and worth stating precisely.
`preflight`, `install`, and `verify` are unserved entirely. `configure` overlaps
`@mgreten/hermes-env`, and `service` overlaps the `restartGateway` that _both_
`hermes-env` and `hermes-config` implement — three implementations of "restart
the gateway" now exist, which is a small duplication signal the ecosystem might
eventually want to collapse.

Note that `@mgreten/hermes-env` recreates a container, so it assumes a
containerized Hermes rather than systemd on a VM. The overlap is partial.

~~**Open decision.** Keep `configure` in scope for first-boot `.env` seeding…~~
**Settled.** `configure` stays, and the overlap turned out to be smaller than
feared for two independent reasons. `hermes-env` targets a Docker deployment —
`rotateSwampKey` does a full container recreation — while this model targets
systemd on a VM, so the two do not operate on the same kind of host. And
`env_loader.py` clears known keys absent from `.env`, which means whole-file
writes are the semantically correct operation and incremental `setEnv` mutation
is the thing at odds with upstream, not the other way round.

`hermes-env` is also the one prior extension that claims an **SSH** transport,
which is exactly what this model lacks. Worth reading before writing one — it
may already solve the port, identity, and stdin problems that ruled out
`@keeb/ssh` below, or it may confirm that analysis.

## Transport

### Where the model runs

Driving the host over SSH is not the only option. Swamp could instead run on the
VM, and the install could be a local run. Three shapes:

|                          | Control plane | Execution        | SSH transport needed |
| ------------------------ | ------------- | ---------------- | -------------------- |
| **A. Remote-drive**      | Mac           | Remote, over SSH | Yes                  |
| **B. Swamp on the VM**   | The VM itself | Local            | No                   |
| **C. Worker enrollment** | Mac           | Local on the VM  | No                   |

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

**Build on A first**, because it depends on nothing experimental. **Move to C**,
which was the open question and is now settled.

### Shape C is viable — tested 2026-08-19

The question was where vault resolution happens. If the worker resolves vault
references itself, C collapses into B and inherits B's credential problem.

It does not. Swamp's own design record for remote execution
(`design/remote-execution.md` in the swamp source, via `swamp source fetch`)
states it directly:

> A worker holds no credentials, no repository, no datastore config, and no
> pre-installed extensions, and can touch nothing it was not handed.

Every side-effecting capability, including secret resolution, is proxied back to
the orchestrator. Two paths exist, and neither puts the vault on the worker:

1. A `${{ vault.get(...) }}` reference in a step's inputs is resolved
   orchestrator-side, and only that value ships with the dispatch.
2. A runtime `vaultService.get()` from inside model code is an RPC home,
   authorized per dispatch.

**Confirmed by running it, not only by reading it.** A worker was enrolled with
an isolated `HOME`, a working directory outside the repository, and therefore no
access to `.swamp/secrets/local_encryption/<vault>/.key`. A workflow step placed
on that worker by label ran `@skunk-ape/stef.lint` over text sourced from a
vault reference, and succeeded:

```
Dispatch 322be8f0: @skunk-ape/stef.lint (probe-c-vault › lint-the-secret) succeeded in 501ms
```

`swamp worker verify` also passed against the same worker, covering enrollment,
scheduling, capability RPC, and the data plane.

**So C keeps the vault, the repository, and the swamp-club auth token off the
VM, while running the work locally on it.** That is the goal shape. Four
findings qualify it, and all four are design constraints rather than blockers:

- **The orchestrator ships its entire process environment with every dispatch.**
  It overlays the worker's environment, minus a fixed denylist that protects the
  worker's own `HOME`, `PATH`, `SHELL`, `TMPDIR`, `XDG_*`, `DENO_*`, and
  `SWAMP_*`. The design record names this as the deliberate injection path for
  ambient credentials, and records per-label environment scoping as unbuilt.
  **Consequence: whatever shell runs `swamp serve` becomes ambient credentials
  inside the agent's VM.** Run the orchestrator from a deliberately minimal
  environment, never from an interactive shell holding `AWS_*`, `GITHUB_TOKEN`,
  or similar. This is the earlier escape-path concern arriving through a
  different door.
- **The per-step secret allowlist has a bypass.** `resolveSecret` enforces an
  allowlist built from the vault references in the dispatched step's arguments,
  but `capability_service.ts` returns early when `allowedSecrets.hasDynamicRefs`
  is true. A dynamically constructed vault reference therefore forfeits the
  allowlist for that dispatch. **Keep every vault reference in this model static
  and literal.**
- **`putSecret` has no allowlist at all**, only the infrastructure-key denylist.
  A dispatched method can overwrite any non-infrastructure secret. Worth knowing
  before granting anything write access.
- **No vault read audit entry appeared** for the probe.
  `swamp vault
  audit-trail` reported none afterwards. Expected, most likely,
  because expression-based resolution happens orchestrator-side and never
  becomes a `resolveSecret` capability call, which is what the trail appears to
  record. Do not rely on the audit trail to see secrets consumed by dispatched
  steps without confirming what it covers.

Infrastructure keys are denied to dispatched methods outright, `server-token-*`
and `worker-token-*` among them, so the specific chain that ruled out shape B —
agent, root, registry token, publish — is closed under C.

Remaining caveat: `swamp worker daemon` is marked EXPERIMENTAL, which is why A
is still the first build target rather than skipping straight to C.

### Why not `@keeb/ssh` for the SSH implementation

Repository rule 1 says search before building, so `@keeb/ssh` was pulled and
read. **It cannot carry this design.** The gaps are in the transport primitives
rather than in a missing method, and `sshExec` builds its argv inline, so
`export const extension` cannot reach them. Read from
`.swamp/pulled-extensions/@keeb/ssh/models/lib/ssh.ts`:

| Gap                                                                            | Consequence here                                                                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| No `port`. Target is `user@host` with no `-p`.                                 | Cannot reach a Lima VM, which listens on `127.0.0.1:<random high port>`.                                                      |
| No identity file and no `-F` config file.                                      | Lima's key is `~/.lima/_config/user`, not a default key name.                                                                 |
| `exec` passes the command in argv, with no stdin.                              | A secret cannot be written safely. `upload` is no escape, because it needs a local file, which puts the secret on local disk. |
| `StrictHostKeyChecking=no` and `UserKnownHostsFile=/dev/null`, both hardcoded. | No host key verification at all, ever, and not configurable. Tolerable for a loopback VM. Not tolerable for EC2.              |
| `timeout` is accepted but never enforced. Its own skill documents this.        | The Hermes install pulls Node 26, Chromium, and Python. A hang has no cap.                                                    |
| `exec` throws on any non-zero exit. `sshExecRaw` exists but is not exposed.    | Every probe must be written to always exit 0 and put its answer on stdout.                                                    |

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

| Method      | What it does                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight` | Assert OS and arch, systemd present, passwordless sudo, disk space, network egress. Validate the whole config, including every vault reference. Change nothing. |
| `install`   | Clone at a pinned ref and run the installer fully non-interactively. Idempotent.                                                                                |
| `configure` | Render `~/.hermes/.env` from vault. Mode 0600, written over stdin.                                                                                              |
| `service`   | Install and enable the systemd unit for the gateway.                                                                                                            |
| `verify`    | Confirm Hermes actually answers. Not "the installer exited 0."                                                                                                  |

### Rules the method split has to honor

- **Validate before touching the host.** A mistyped ref or a malformed
  environment key must fail in `preflight`, not after Chromium has downloaded.
  This is cheap to build and it is most of the felt quality difference. Note
  that swamp gets there first for the specific case this rule was written about:
  a vault reference naming a missing vault or key fails the run before the
  method executes at all, which was verified rather than assumed.
- **Never assume a TTY, and fail rather than hang.** The upstream prompts block
  on a non-TTY SSH pipe. `BatchMode=yes` turns a block into an immediate error,
  which is the safety net. Drive with `--skip-setup` and answer the package
  prompt explicitly so the net is never needed. Detect an existing install first
  and choose update or fresh deliberately, so a re-run is idempotent by design
  rather than by luck.
- **Cap every long step remotely.** `ssh` enforces no wall-clock limit, and the
  Chromium and Node steps are slow enough to look identical to a hang. Wrap them
  in a remote `timeout(1)` so a stall fails on a schedule.
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

1. **Playwright and Chromium on arm64 Linux under Lima `vz`.** Partly answered:
   the installer does _not_ pull them unconditionally — `--skip-browser` exists
   and is now the `installBrowser` field. Whether they work on arm64 still needs
   a real run.
2. **QR pairing for WhatsApp and Signal on a headless host.** Pairing is
   normally an ASCII QR in the terminal, which SSH carries, but confirm it. Note
   that the installer's own pairing prompt is skipped under `--non-interactive`,
   and it says so, so pairing is a deliberate later step rather than something
   this model can drive.
3. **Egress policy for the VM.** Hermes needs outbound to model APIs and to
   messaging platforms. Decide what else, if anything.
4. **Gateway inbound.** Most messaging platforms are outbound-only. Anything
   webhook-based needs a Lima `portForwards` entry.
5. **`@mgreten/hermes-env` reuse**, per the open decision above. Now partly
   answered from the other side: `hermes_cli/env_loader.py` clears known keys
   that are absent from `.env`, so `configure` writing the file whole is what
   makes the definition authoritative. Any day-two tool that merges into `.env`
   instead is fighting that, and would be undone by the next `configure`.
6. **Resource floor.** Chromium, Python, and Node in one VM. The template asks
   for 4 CPU and 8 GiB. Confirm that is enough.
7. ~~Shape C, worker enrollment.~~ **Settled on 2026-08-19. C is viable.** See
   "Shape C is viable" below.
8. **Does the installer's `maybe_start_gateway` fight `service`?** It runs even
   under `--skip-setup`, and starts the gateway whenever it finds a messaging
   token in `.env`. On a first install there is no `.env` yet, so it does
   nothing. On a re-run after `configure`, `install` will install and start the
   gateway as a side effect. `service` is idempotent and authoritative, so this
   is believed harmless — but it means `install` is not purely an install, and
   that should be confirmed rather than assumed.

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

## What the upstream source changed

Everything above this section was written before the code. This section was
written after reading `scripts/install.sh` (3541 lines),
`scripts/hermes-gateway`, and `hermes_cli/env_loader.py` at tag `v2026.8.18`,
and it records where the design above was wrong. It is kept rather than folded
in, because the corrections are more useful than a document that looks like it
was right the first time.

### The gateway is a user unit, not a system unit

This is the correction with the widest blast radius. `scripts/hermes-gateway`
writes `~/.config/systemd/user/hermes-gateway.service` with
`WantedBy=default.target` and drives it with `systemctl --user`. The design
above says "install and enable the systemd unit" throughout, and that phrasing
hides three real requirements:

- **A user bus must exist.** `systemctl --user` talks to the caller's own
  session bus. A non-login shell — every SSH command, and every dispatched
  worker step — arrives with neither `XDG_RUNTIME_DIR` nor
  `DBUS_SESSION_BUS_ADDRESS` set, and fails with "Failed to connect to bus"
  however healthy the unit is. `service` sets both explicitly.
- **Lingering must be on**, or the unit does not start at boot and does not
  survive logout. Upstream prints `sudo loginctl enable-linger $USER` as a hint
  at the end of `install_systemd` and then leaves it to the reader. That is
  exactly the kind of runtime decision this model exists to make once, so it is
  the `enableLinger` field, and `lima-hermes.yaml` now enables it at provision
  time so the VM comes up ready.
- **`preflight` cannot simply require a bus.** On a fresh host there is no user
  bus precisely because lingering has not been enabled yet, and enabling it is
  what creates one. Failing on a missing bus would reject every host that
  `service` would have fixed one step later, so the check only fires when
  nothing later will create one.

The model reuses `hermes gateway install` rather than writing its own unit file.
Carrying a second copy of a unit that upstream also generates is a guaranteed
future drift for no gain.

### The installer is better than its reputation, in specific ways

The design above describes an installer that "prompts about system packages,
about PATH edits, and about what to do with an existing install". The prompts
are real, but there is more machinery to drive them than assumed:

| Assumed                          | Actually                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Only `--skip-setup` to work with | `--non-interactive` also exists, and makes every remaining `prompt_yes_no` take its default instead of reading `/dev/tty`    |
| Tracks `main`                    | `--commit <sha>` pins the checkout, and `--force-commit` makes the pin authoritative even when it moves an install backwards |
| Chromium is unconditional        | `--skip-browser` and `--skip-computer-use` exist                                                                             |
| Bundled skills are unconditional | `--no-skills` exists, and is a one-way door: it writes `<dataDir>/.no-bundled-skills`, which later runs honour               |

Two of these matter beyond convenience. `--non-interactive` is a stronger
guarantee than `BatchMode=yes`, because it removes the prompt rather than
turning a hang into an error — the design above treats `BatchMode` as the safety
net, and it still is, but the net is now much less likely to be needed. And
`--force-commit` is load-bearing: without it, the installer _silently ignores_ a
pin that would move an existing checkout backwards, so a rollback would appear
to succeed and change nothing.

### `--commit` takes a SHA, so a tag has to be peeled

`--commit` rejects anything that is not 7-40 hex characters, so the model
resolves `ref` with `git ls-remote` first. An annotated tag resolves to a _tag
object_, not a commit, and `v2026.8.18` is annotated. Recording the tag object
SHA would make `verify`'s comparison against `git rev-parse HEAD` fail forever,
so the peeled `refs/tags/<ref>^{}` line is preferred over the bare one.

Resolving up front has a second benefit the design above asks for by name: a
typo'd ref now fails in `preflight`, against the remote, before anything is
downloaded.

### The installer itself is now pinned, not just the code

The design objects to `curl … | bash` for tracking `main`, and then proposes
pinning the _repository_ ref. That pins the smaller half. The script that does
the installing is still whatever was published a moment ago.

So `install` resolves the commit first and then fetches
`raw.githubusercontent.com/NousResearch/hermes-agent/<sha>/scripts/install.sh` —
a URL whose path _is_ the git commit, and therefore an immutable object. The
installer and the code it installs are the same reviewed revision.
`scripts/install.sh` sources nothing, so one file is the whole installer.

### Two configured fields could not mean what they said

- **`gatewayPlatforms` was a fiction, and is removed.** There is no platform
  list anywhere upstream. `gateway/config.py` enables a platform when it finds
  that platform's token in the environment. A field that silently did nothing is
  worse than no field, so putting a token in `env` is now the whole mechanism.
- **`installSystemPackages: false` became an assertion.** There is no flag to
  decline. The installer decides by `command -v` and installs ripgrep and ffmpeg
  through sudo when they are missing. The only honest enforcement is to require
  that it finds nothing to do, so `preflight` fails unless both are already
  present. The alternative — accepting the field and letting sudo run anyway —
  would be a lie in a security-relevant direction.

### `.env` is authoritative, which is better than expected

`hermes_cli/env_loader.py` loads `<dataDir>/.env` with `override=True` and then
calls `_clear_known_keys_missing_from_dotenv`, which removes known Hermes keys
that the file does not mention. So writing the file whole — rather than merging
into it — means removing a key from the model definition really does remove it
from the running agent. That is the property that makes a declarative
environment worth having, and it happens to be what upstream already does.

Values are double-quoted and escaped for `\\`, `"`, `\n`, and `\r`, which is the
subset python-dotenv unescapes inside double quotes. A single quote needs no
escaping there, which the tests are careful to distinguish from bash's `$'...'`.

### `hermes doctor` cannot be the verdict

`cmd_doctor` calls `run_doctor(args)` and does not exit on its result, so
`hermes doctor` exits 0 whether it found nothing or twenty things. Using it as
the pass/fail signal would be precisely the "the installer exited 0" claim this
model exists to avoid. `verify` therefore makes its own checks — the command
answers, the checkout is at the pinned commit, `.env` exists at mode 0600, the
unit is enabled and active — and records doctor's issue count, scraped from its
summary line, as diagnosis rather than judgement.

## What the first real run changed

Written after running the whole thing against a Lima VM on 2026-08-20, with a
worker enrolled by `lima-hermes.yaml` and the five methods driven as placed
steps of the `hermes-install` workflow. Two bugs, one of them mine and one of
them a hard constraint on shape C. Both were invisible to the unit tests and to
every amount of reading, which is the argument for having done this.

### The install worked; the bookkeeping did not

Worth saying first, because it frames both bugs. On the host afterwards:

```
Hermes Agent v0.20.4 (2026.8.18)
Install directory: /home/agent/.hermes/hermes-agent
e624e9fde561e1add9388384012b295fde669ade
```

That commit is exactly the peeled `refs/tags/v2026.8.18^{}`, so the
annotated-tag peeling written from reading `install.sh` is right in practice.
Chromium downloaded and extracted on arm64 under `vz`, which is most of open
question 1. `preflight` passed on Linux. The vault-sourced `.env` value resolved
on the orchestrator and arrived at a worker that holds no vault, which is the
shape C claim, now observed rather than argued.

### A timeout does not bound wall-clock time if you read to EOF

`runScriptRaw` used `proc.output()`, which waits for end-of-file on the output
pipes rather than for the process to exit. Those are the same event until a
grandchild outlives its parent.

Upstream wraps its Playwright step in `timeout 600`. `timeout` signals only the
child it spawned, so when it fired, the Chromium downloader two levels below
survived and inherited the pipe. The installer exited successfully at 10:30. The
method sat blocked until 10:43, holding a pipe open for a process with nothing
left to say. The evidence was unambiguous once looked at:

```
/proc/34401/fd/1 -> pipe:[39812]
/proc/34401/fd/2 -> pipe:[39812]
    PID    PPID STAT     ELAPSED CMD
  27248       1 Sl         22:58 node .../playwright install --with-deps chromium
```

`PPID 1` — reparented, so its parent was long gone. Killing those two processes
released the run instantly.

This is worth stating as a rule, because the design record above got it wrong in
a way that reads as right: **"cap every long step remotely" does not cap
anything if the caller waits for pipe EOF.** The cap bounds the command; it does
not bound the descendants the command leaves behind, and it is the descendants
that hold the pipe.

Fixed twice over, deliberately:

- **At the seam.** `runScriptRaw` now waits for the process to _exit_, drains
  the pipes for a two-second grace, then cancels the readers. A stray orphan
  costs two seconds instead of the rest of the run. This is the general fix, and
  it covers scripts nobody has written yet.
- **At the call.** `install` sends the installer's transcript to a log file on
  the target and tails it back, so orphans inherit a log file rather than the
  pipe the orchestrator is reading. The log path is recorded in the resource,
  which also makes a failed install diagnosable after the fact.

### Dispatch credentials expire at fifteen minutes and never refresh

The thirteen minutes of dead time pushed the step to 25m19s, and the resource
write then failed:

```
Data plane POST /data/resource failed (401): {"error":"Missing or invalid session credential"}
```

Not a flake. From swamp's own source, `src/domain/remote/session_credential.ts`:

```ts
export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
```

and `refresh()`, whose doc comment says "Does not affect dispatch credentials",
returns `null` whenever the record carries a `dispatchId`. There is no
`swamp serve` flag that changes it.

**So a dispatched method that runs longer than fifteen minutes cannot record
what it did.** The work lands on the host and swamp records the step as failed,
which is the worst available shape for a failure: the side effects happened and
nothing persisted. It also does not re-dispatch, because a step that failed at
its write is treated as having written.

This is a real constraint on shape C rather than a detail, and it deserves to be
weighed against shape B honestly. B has no dispatch credential to expire, so it
has no ceiling. The credential posture is still the reason to prefer C — but the
comparison is now "C costs you a fifteen-minute ceiling", not "C is strictly
better ergonomics-wise once the worker exists".

Filed upstream as swamp-club Lab #1750, with the suggestion that the
orchestrator renew a credential while its dispatch is still open: it already
tracks that, and the credential dies with the dispatch either way.

**Consequence for this extension.** A full install with Chromium is close enough
to fifteen minutes that it cannot be relied on to fit. Until #1750 moves, the
honest guidance is to run a browser-bearing first install with
`installBrowser: false` and add the browser afterwards, or to drive the install
locally on the target rather than as a dispatched step. `installTimeoutSeconds`
defaulting to 3600 is now actively misleading — it promises an hour that the
transport will not honour, and that is called out at the field.

### Install history, not install snapshots

Prompted by review while the run was in flight. The `install` resource already
persisted with `lifetime: "infinite"` and ten versions retained, so the
datastore was already the record of what had been installed. What it recorded
was a series of destinations, though, and the question people ask is about
transitions. It now reads the prior resource first and records `previousCommit`,
`previousVersion`, and `changed` alongside the new state.

`hermesVersion` is also now the parsed `0.20.4` rather than the whole banner,
with the raw line kept beside it, so the history is comparable in a CEL
expression instead of needing parsing at the point of use. The parser requires
the `v` prefix: upstream prints `Hermes Agent v0.20.4 (2026.8.18)`, the release
date in those parentheses is itself three dot-separated numbers, and a looser
pattern reports the date as the version precisely when the version is missing.

### An operational note that cost twenty-eight minutes

`swamp serve` bundles an extension once and keeps serving that bundle. Editing
`hermes.ts` under a running orchestrator changes nothing about what the worker
executes, and the second run reproduced the first run's failure exactly —
identical symptom, identical duration, entirely stale code. The tell was that
the log file the fix introduces never appeared on the target.

Restart the orchestrator after editing an extension, and bump the model type
version so the bundle cache cannot serve the old one. Cheap to say afterwards;
expensive to notice while a twenty-five minute install is the unit of feedback.

### The run that passed

With both fixes in and the orchestrator restarted on a fresh bundle:

```
preflight  done in 1.9s     Linux/aarch64, 49GB free, ref resolves to e624e9fde561
install    done in 10m17s
configure  done in 498ms    2 environment key(s)
service    done in 5.5s     hermes-gateway is enabled and active, linger on
verify     done in 3.8s     Hermes answers: 0.20.4, pinned at e624e9fde561
Completed  workflow hermes-install succeeded in 10m29s
```

The install number is the one that matters, and it is the seam fix measured
rather than asserted. Playwright hung after its download again — the log's mtime
stopped at 16:42:30 and did not move — and upstream's `timeout 600` fired at
about 16:52:20. The method completed at 16:52:33, thirteen seconds later, with
six Playwright processes still alive on the host. Before the fix the same
situation cost thirteen minutes.

`verify` checked the host rather than trusting the installer, and every check
passed: command present, version answers, checkout at the pinned commit, `.env`
present and mode 600, unit enabled, unit active. Confirmed independently over
`limactl shell` afterwards, because a model reporting that its own work
succeeded is not evidence.

The vault claim was also checked rather than assumed. The SHA-256 of the value
in the target's `.env` matches the SHA-256 of the vault secret, while the
worker's `~/.swamp` contains only `bin`, `bundles`, and a `machine-id` — no
vault, no repository, no auth token. Orchestrator-side resolution is now
observed end to end.

**Playwright is still the open problem.** It downloads Chromium fine on arm64
under `vz` — that half of open question 1 is answered — and then hangs in
`--with-deps`, every time, until upstream's own cap kills it. The install
succeeds anyway because upstream treats that step as non-fatal, so browser tools
are the casualty rather than the install. Ten of the seventeen minutes are spent
waiting for a step that never succeeds, which is also what puts a
browser-bearing install uncomfortably near the fifteen-minute dispatch ceiling.
`installBrowser:
false` avoids both, and on current evidence is the better
default for a dispatched install.

**A note on `doctorIssues`.** `verify` recorded 2; running `hermes doctor` by
hand a few minutes later reported 4, the extra two being npm audit findings that
had not been computed yet. There is only one "Found N issue(s)" line in the
output, so this is not a parsing error — the number genuinely moves in the
minutes after an install. It is recorded as diagnosis, never as the verdict, and
that is the right weight to give it.

## The Playwright failure is not the distro

Recorded after the 24.04 rebuild, because it corrects a confident prediction
made one section above and acted on.

The theory was: Ubuntu 26.04 is newer than any Playwright build, so pinning the
Lima base image to 24.04 — which Playwright supports natively — would make
browser tools work. The pin was made, the VM rebuilt, and the install run again.

**The pin did not fix it.** No `#35166` line and no
`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE` appeared in the log, which confirms 24.04 is
natively recognised and the override path never triggered. Playwright failed
anyway, in the same place and for the same duration.

What it actually is, established by installing one small component in isolation:

```
$ playwright install ffmpeg      # 1.6 MiB
… 100% of 1.6 MiB
rc=124                           # killed by a 120s timeout
$ ls ~/.cache/ms-playwright/
__dirlock  ffmpeg-1011           # the component IS installed
```

**Playwright downloads and installs a component correctly, and then never
exits.** The work succeeds; the process does not terminate. It is killed by
whatever timeout wraps it, and it leaves `__dirlock` — its cache directory lock
— behind.

That stale lock is what makes the second symptom, and it is why this looked like
a download problem for so long. Every later `playwright install` blocks on the
lock immediately, producing no output at all, and times out. So the first run
looks like "the download hung" and every run after looks identical while never
reaching the network.

Both symptoms are one bug, and neither is about Ubuntu:

| Observed                           | Actual                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| "Hangs during `--with-deps`"       | Hangs _after_ a successful component install, in any mode                       |
| "Re-downloads Chromium every run"  | The completion marker is never written, because the process never exits cleanly |
| "Fixed by a newer/older distro"    | Identical on 26.04 and 24.04                                                    |
| "Second run hangs on the download" | Second run never downloads; it blocks on the stale `__dirlock`                  |

The install completes regardless, because upstream treats the browser step as
non-fatal. The cost is about ten minutes per install buying a component set that
is never finished — Chromium arrives, `chromium_headless_shell` and `ffmpeg` do
not, so browser tools do not work.

**Consequence: `installBrowser: false` is the right default here**, and the ops
repo sets it. It removes ten minutes from every install, removes the largest
single reason a dispatched install approaches the fifteen-minute credential
ceiling, and loses only a capability that was not working anyway.

A manual recipe does exist for anyone who wants the browser: remove
`~/.cache/ms-playwright/__dirlock`, run `playwright install chromium` under a
timeout, kill it when it stalls after the download, remove the lock again, and
repeat until all three components are present. That is not something to automate
blindly, and it is not something this model should pretend to do.

### On the distro question more generally

Neither failure this project hit was really Ubuntu's fault. 26.04 was too new
for Playwright's build matrix; 24.04's minimal cloud image omitted `libatomic1`
and `unzip`. Both are the same class — **prebuilt glibc binaries meeting a
minimal base image** — because the installer compiles nothing. It fetches a
prebuilt Node, a uv-managed Python, and Playwright's Chromium.

That argues for a boring, widely-targeted glibc distro rather than a different
one:

- **Arch** is supported by the installer (`pacman -S --noconfirm`), but rolling,
  so it sits permanently where 26.04 sat — always ahead of Playwright's builds.
  Its `--with-deps` support is also absent, since that path is apt-only, and
  `playwright_host_unrecognized` only handles ubuntu and debian, so it would not
  even get the override retry.
- **NixOS** is the worst fit for this installer and the best fit for a different
  approach. It will not run unpatched prebuilt dynamic binaries, so Node, uv's
  Python, and Chromium would each need patchelf or nix-ld. Upstream ships
  `flake.nix` and `services.hermes-agent.enable`, which is a genuinely better
  path _if_ NixOS is the target — and it would make this extension redundant
  there, because that module already is the declaration this extension exists to
  produce. Tellingly, upstream's own NixOS module offers `container.enable`,
  documented as "OCI container mode (**Ubuntu base**, full self-modification
  support)": even the Nix path reaches for Ubuntu once the agent needs to modify
  itself, which is the entire premise here.
- **Debian 12/13** is the one real alternative — apt-based, conservative, and in
  Playwright's build matrix. Roughly equivalent to 24.04.

The durable fix was never the distro. It was declaring the dependencies, which
the template now installs and `preflight` now enforces by name — including
`libatomic.so.1`, which is not a command and therefore needs its own probe.

## The SSH transport, and what reading a neighbour changed

Added 2026-08-21, after pulling `@mgreten/hermes-env` — the one published Hermes
extension that already had SSH — and reading its implementation. Two things came
out of that, one of which corrects this document.

### The gap list against `@keeb/ssh` was partly wrong

The Transport section above disqualifies `@keeb/ssh` on six counts, and the
first two — "no port" and "no identity file" — do not hold up. `hermes-env` does
not implement them either. It passes its host string to `ssh` verbatim and
stops.

That is the correct design, and this document already knew it in a different
section: "Reaching a Lima VM needs no code", via `Include ~/.lima/*/ssh.config`.
`ssh` reads `ssh_config`. Port, identity, jump hosts, ciphers, and user all live
there, maintained by people who have thought about it much harder than this
model will. Re-implementing `-p` and `-i` would shadow that with a worse and
much smaller copy. So the same fact was written up as a blocking gap in one
place and as an elegant non-problem in another.

What genuinely disqualifies `@keeb/ssh` is narrower and worse than the list
suggested: it hardcodes `StrictHostKeyChecking=no` **and**
`UserKnownHostsFile=/dev/null`. That does not merely skip verification, it
_overrides_ whatever the user configured, for every connection, with no way to
turn it back on. For a model that installs software with sudo on a remote host,
silently disabling host-key verification is the one thing that must not happen.
`hermes-env` avoids it by not setting it — safer through doing less.

### What the transport therefore sets

Two options, and no more:

- `BatchMode=yes` — a prompt fails immediately instead of hanging against a pipe
  nobody is watching. The safety net behind the installer's `--non-interactive`.
- `ConnectTimeout` — an unreachable host fails on a schedule.

Everything else is inherited. The tests assert on the _absence_ of
`StrictHostKeyChecking`, `UserKnownHostsFile`, `-p`, `-i` and `-F`, because
those absences are decisions rather than omissions and a future edit should have
to argue with a failing test before adding them.

### The seam paid for itself

The whole change to reach remote hosts was:

```ts
const { bin, args } = buildCommand(opts.transport ?? LOCAL);
const proc = new Deno.Command(bin, { args, … })
```

plus a function turning two global arguments into a `Transport`. Every script
body — the probes, the installer drive, the base64 `.env` write, the systemd
user-unit handling, `expand_home`, `parseKv` — is unchanged, because all of them
were already shell fed over stdin and none of them named a host. That is exactly
the property the seam was introduced for, and it is the first time it has been
tested by an actual architecture change rather than asserted.

Notably this model's shape is _stronger_ than the neighbour it learned from.
`hermes-env` puts its command in argv (`ssh host "sudo tee … && chmod …"`) and
pipes only the payload over stdin, so the command line is visible in `ps` on
both machines. Feeding the entire script to `bash -s` over stdin keeps
everything out of argv, which is why `ssh … bash -s` was the right target shape
and not a translation of what the neighbour does.

### Also borrowed: atomic writes

`hermes-env` writes `.env` to a temp file and renames it over the destination.
This model truncated in place, which leaves a window where a reader sees an
empty or partial file — and the window is not theoretical, because `service`
restarts the gateway immediately after `configure` writes, and the gateway reads
that file at startup. `writeFileScript` now creates a sibling temp at the target
mode, fills it, and `mv -f`s it into place, so a reader sees the old file or the
new one and never a half-written one.
