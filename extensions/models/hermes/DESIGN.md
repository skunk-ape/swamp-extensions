# @skunk-ape/hermes — design

Status: all five methods implemented; `preflight` verified end to end, the
install path not yet run against a Linux host. The transport seam is currently
the local implementation that shape C calls for. See "What the upstream source
changed" at the end, which is the part of this record written after the code.

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
access to `.swamp/secrets/local_encryption/stef-secrets/.key`. A workflow step
placed on that worker by label ran `@skunk-ape/stef.lint` over text sourced from
a vault reference, and succeeded:

```
Dispatch 322be8f0: @skunk-ape/stef.lint (probe-c-vault › lint-the-secret) succeeded in 501ms
```

`swamp worker verify` also passed against the same worker, covering enrollment,
scheduling, capability RPC, and the data plane.

**So C keeps the vault, the repository, and the swamp-club auth token off the
VM, while running the work locally on it.** That is the goal shape. Four
findings qualify it, and all four are design constraints rather than blockers:

- **The orchestrator ships its entire process environment with every dispatch.**
  It overlays the worker's environment, minus a fixed denylist that protects
  the worker's own `HOME`, `PATH`, `SHELL`, `TMPDIR`, `XDG_*`, `DENO_*`, and
  `SWAMP_*`. The design record names this as the deliberate injection path for
  ambient credentials, and records per-label environment scoping as unbuilt.
  **Consequence: whatever shell runs `swamp serve` becomes ambient credentials
  inside the agent's VM.** Run the orchestrator from a deliberately minimal
  environment, never from an interactive shell holding `AWS_*`, `GITHUB_TOKEN`,
  or similar. This is the earlier escape-path concern arriving through a
  different door.
- **The per-step secret allowlist has a bypass.** `resolveSecret` enforces an
  allowlist built from the vault references in the dispatched step's arguments,
  but `capability_service.ts` returns early when
  `allowedSecrets.hasDynamicRefs` is true. A dynamically constructed vault
  reference therefore forfeits the allowlist for that dispatch. **Keep every
  vault reference in this model static and literal.**
- **`putSecret` has no allowlist at all**, only the infrastructure-key denylist.
  A dispatched method can overwrite any non-infrastructure secret. Worth knowing
  before granting anything write access.
- **No vault read audit entry appeared** for the probe. `swamp vault
  audit-trail` reported none afterwards. Expected, most likely, because
  expression-based resolution happens orchestrator-side and never becomes a
  `resolveSecret` capability call, which is what the trail appears to record.
  Do not rely on the audit trail to see secrets consumed by dispatched steps
  without confirming what it covers.

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

- **Validate before touching the host.** A mistyped ref or a malformed
  environment key must fail in `preflight`, not after Chromium has downloaded.
  This is cheap to build and it is most of the felt quality difference. Note
  that swamp gets there first for the specific case this rule was written
  about: a vault reference naming a missing vault or key fails the run before
  the method executes at all, which was verified rather than assumed.
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

1. **Playwright and Chromium on arm64 Linux under Lima `vz`.** Partly answered:
   the installer does *not* pull them unconditionally — `--skip-browser` exists
   and is now the `installBrowser` field. Whether they work on arm64 still needs
   a real run.
2. **QR pairing for WhatsApp and Signal on a headless host.** Pairing is
   normally an ASCII QR in the terminal, which SSH carries, but confirm it.
   Note that the installer's own pairing prompt is skipped under
   `--non-interactive`, and it says so, so pairing is a deliberate later step
   rather than something this model can drive.
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

The model reuses `hermes gateway install` rather than writing its own unit
file. Carrying a second copy of a unit that upstream also generates is a
guaranteed future drift for no gain.

### The installer is better than its reputation, in specific ways

The design above describes an installer that "prompts about system packages,
about PATH edits, and about what to do with an existing install". The prompts
are real, but there is more machinery to drive them than assumed:

| Assumed | Actually |
| --- | --- |
| Only `--skip-setup` to work with | `--non-interactive` also exists, and makes every remaining `prompt_yes_no` take its default instead of reading `/dev/tty` |
| Tracks `main` | `--commit <sha>` pins the checkout, and `--force-commit` makes the pin authoritative even when it moves an install backwards |
| Chromium is unconditional | `--skip-browser` and `--skip-computer-use` exist |
| Bundled skills are unconditional | `--no-skills` exists, and is a one-way door: it writes `<dataDir>/.no-bundled-skills`, which later runs honour |

Two of these matter beyond convenience. `--non-interactive` is a stronger
guarantee than `BatchMode=yes`, because it removes the prompt rather than
turning a hang into an error — the design above treats `BatchMode` as the
safety net, and it still is, but the net is now much less likely to be needed.
And `--force-commit` is load-bearing: without it, the installer *silently
ignores* a pin that would move an existing checkout backwards, so a rollback
would appear to succeed and change nothing.

### `--commit` takes a SHA, so a tag has to be peeled

`--commit` rejects anything that is not 7-40 hex characters, so the model
resolves `ref` with `git ls-remote` first. An annotated tag resolves to a *tag
object*, not a commit, and `v2026.8.18` is annotated. Recording the tag object
SHA would make `verify`'s comparison against `git rev-parse HEAD` fail forever,
so the peeled `refs/tags/<ref>^{}` line is preferred over the bare one.

Resolving up front has a second benefit the design above asks for by name: a
typo'd ref now fails in `preflight`, against the remote, before anything is
downloaded.

### The installer itself is now pinned, not just the code

The design objects to `curl … | bash` for tracking `main`, and then proposes
pinning the *repository* ref. That pins the smaller half. The script that does
the installing is still whatever was published a moment ago.

So `install` resolves the commit first and then fetches
`raw.githubusercontent.com/NousResearch/hermes-agent/<sha>/scripts/install.sh`
— a URL whose path *is* the git commit, and therefore an immutable object. The
installer and the code it installs are the same reviewed revision.
`scripts/install.sh` sources nothing, so one file is the whole installer.

### Two configured fields could not mean what they said

- **`gatewayPlatforms` was a fiction, and is removed.** There is no
  platform list anywhere upstream. `gateway/config.py` enables a platform when
  it finds that platform's token in the environment. A field that silently did
  nothing is worse than no field, so putting a token in `env` is now the whole
  mechanism.
- **`installSystemPackages: false` became an assertion.** There is no flag to
  decline. The installer decides by `command -v` and installs ripgrep and
  ffmpeg through sudo when they are missing. The only honest enforcement is to
  require that it finds nothing to do, so `preflight` fails unless both are
  already present. The alternative — accepting the field and letting sudo run
  anyway — would be a lie in a security-relevant direction.

### `.env` is authoritative, which is better than expected

`hermes_cli/env_loader.py` loads `<dataDir>/.env` with `override=True` and then
calls `_clear_known_keys_missing_from_dotenv`, which removes known Hermes keys
that the file does not mention. So writing the file whole — rather than merging
into it — means removing a key from the model definition really does remove it
from the running agent. That is the property that makes a declarative
environment worth having, and it happens to be what upstream already does.

Values are double-quoted and escaped for `\\`, `"`, `\n`, and `\r`, which is
the subset python-dotenv unescapes inside double quotes. A single quote needs
no escaping there, which the tests are careful to distinguish from bash's
`$'...'`.

### `hermes doctor` cannot be the verdict

`cmd_doctor` calls `run_doctor(args)` and does not exit on its result, so
`hermes doctor` exits 0 whether it found nothing or twenty things. Using it as
the pass/fail signal would be precisely the "the installer exited 0" claim this
model exists to avoid. `verify` therefore makes its own checks — the command
answers, the checkout is at the pinned commit, `.env` exists at mode 0600, the
unit is enabled and active — and records doctor's issue count, scraped from its
summary line, as diagnosis rather than judgement.
