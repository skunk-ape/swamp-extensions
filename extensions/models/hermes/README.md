# @skunk-ape/hermes

Install and configure the [Hermes agent](https://hermes-agent.org/) on a Linux
host, from a declaration rather than an interactive wizard.

**Status: in development.** `preflight` works. `install`, `configure`,
`service`, and `verify` are declared and stubbed. [`DESIGN.md`](./DESIGN.md) is
the design record, and it is the thing worth reading first.

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
  ref: v0.4.2               # required, with no default — tracking main is the
                            # upstream behaviour this model replaces
  dataDir: ~/.hermes
  installSystemPackages: true
  onExisting: update
  installGatewayService: true
  gatewayPlatforms: [telegram]
  env:
    ANTHROPIC_API_KEY: '${{ vault.get("hermes", "anthropic-key") }}'
```

Then check the host before changing it:

```bash
swamp model method run hermes preflight --json
```

`preflight` writes what it found and fails with every reason the host is not
ready, rather than the first one.

> Keep every vault reference static and literal. A dynamically constructed
> reference forfeits the per-step secret allowlist that swamp applies to
> dispatched methods. See `DESIGN.md`.

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
