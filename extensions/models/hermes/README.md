# @skunk-ape/hermes

Install and configure the [Hermes agent](https://hermes-agent.org/) on a Linux
host, from a declaration rather than an interactive wizard.

**Status: working, with one known limitation.** All five methods are implemented
against the upstream installer's real flags and paths, and the whole sequence
has been verified end to end against a Lima VM — installed, configured, gateway
running, verified, in 10m29s. See "Known limitations" below for the two things
that will bite you. [`DESIGN.md`](./DESIGN.md) is the design record, and it is
the thing worth reading first.

## Why this exists

Upstream ships one command:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

It is interactive, and it tracks `main`. It prompts about system packages and
PATH edits, asks what to do with an existing install, then runs a setup wizard
for API keys.

Wrapping that command in a model would add nothing. The value here is the
inversion: **every choice the wizard asks for at runtime becomes a field decided
once, in version control, before anything touches the host.** A declarative
install is reviewable, re-runnable, and diffable. An interactive one is none of
those.

## Use

```bash
swamp extension pull @skunk-ape/hermes
swamp model create @skunk-ape/hermes hermes
swamp model edit hermes
```

Configure it, sourcing every secret from a vault:

```yaml
globalArguments:
  ref: v2026.8.18           # required, with no default — tracking main is the
                            # upstream behaviour this model replaces
  dataDir: ~/.hermes
  installSystemPackages: true
  installBrowser: true      # Playwright and Chromium; most of minDiskGb
  onExisting: update
  installGatewayService: true
  enableLinger: true
  env:
    ANTHROPIC_API_KEY: '${{ vault.get("hermes", "anthropic-key") }}'
    TELEGRAM_BOT_TOKEN: '${{ vault.get("hermes", "telegram-token") }}'
```

There is no list of messaging platforms to enable, because upstream has no such
switch: the gateway turns a platform on when it finds that platform's token in
the environment. Putting a token in `env` is how you enable it.

Then run the methods in order:

```bash
swamp model @skunk-ape/hermes method run preflight hermes
swamp model @skunk-ape/hermes method run install   hermes
swamp model @skunk-ape/hermes method run configure hermes
swamp model @skunk-ape/hermes method run service   hermes
swamp model @skunk-ape/hermes method run verify    hermes
```

Each one stands alone and re-runs cleanly, so rotating a key is `configure` plus
`service` rather than a rebuild. `preflight` writes what it found and fails with
every reason the host is not ready rather than the first one, and it resolves
`ref` against the remote, so a typo fails before anything is downloaded. A
vault reference that names a missing vault or key fails earlier still — swamp
resolves those before the method runs at all.

> Keep every vault reference static and literal. A dynamically constructed
> reference forfeits the per-step secret allowlist that swamp applies to
> dispatched methods. See `DESIGN.md`.

### Two fields that do not mean what they look like

- **`installSystemPackages: false` is an assertion, not a switch.** The upstream
  installer has no flag to decline ripgrep and ffmpeg; it decides by `command
  -v` and installs them through sudo when they are missing. The only honest way
  to hold it to this choice is to require that it finds nothing to do, so
  `preflight` fails unless both are already present.
- **`ref` should be a tag or a commit, not a branch.** A branch resolves to a
  different commit on each run, which is the upstream behaviour this model
  exists to replace, and it makes `install` and `verify` disagree legitimately.

## Known limitations

**Playwright hangs in `--with-deps`, so budget ten wasted minutes or turn it
off.** Chromium downloads fine on arm64 under Lima `vz`, then the dependency
step hangs until upstream's own 600-second cap kills it — every run. Upstream
treats that step as non-fatal, so the install still succeeds; browser tools are
what you lose. Ten of the seventeen minutes go to a step that never completes.
`installBrowser: false` skips it.

**A dispatched install must finish inside fifteen minutes.** When these methods
run as placed workflow steps on a worker, swamp's dispatch credential expires
after fifteen minutes and cannot be renewed, so a longer install completes on
the host and then fails to record anything — the side effects happen and nothing
persists. A full install with the browser step is close enough to that ceiling
to be unreliable. Use `installBrowser: false`, or run the methods locally on the
target instead of dispatching them. Filed upstream as
[swamp-club Lab #1750](https://swamp-club.com/lab/1750); `installTimeoutSeconds`
cannot help, because the ceiling is in the transport rather than in the script.

## Running it on a worker

[`workflow-hermes-install.yaml`](../../../workflows/workflow-hermes-install.yaml)
drives the five methods in order as placed steps. It sets `affinity: true`,
which is load-bearing rather than an optimisation: install, configure, service,
and verify all address one host's filesystem and one host's systemd, so a run
that spread them over two workers would report success for a machine that was
never assembled.

## Target

The target is any Linux host, and this model does not create it. Provisioning
has its own lifecycle, so it is deliberately out of scope.

[`lima-hermes.yaml`](./lima-hermes.yaml) is a ready template for the intended
first target — a Lima VM on macOS:

```bash
swamp worker token create hermes --duration 720h

limactl start --name hermes ./lima-hermes.yaml \
  --param orchestrator=ws://192.168.5.2:9099 \
  --param workerToken=<name>.<secret> \
  --param workerLabels=role=hermes
limactl autostart hermes
```

The template pins `mounts: []` rather than inheriting a base that mounts the
host home directory, and grants passwordless sudo inside the VM. Those two go
together: an agent that writes its own skills will need to install things
nobody anticipated, and the VM boundary is what makes granting that reasonable.
An autonomous agent with shell access and your home directory mounted is not
isolated.

The honest limitation is that a laptop VM suspends on sleep, so scheduled
skills do not fire overnight. That is the argument for moving the same install
to a always-on host later, which the target contract makes cheap.

## License

Apache 2.0. See [LICENSE](./LICENSE).
