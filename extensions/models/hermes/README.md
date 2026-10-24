# @skunk-ape/hermes

Run [Hermes](https://github.com/NousResearch/hermes-agent) agents on macOS or
Linux, each one confined to its own directory by a [nono](https://nono.sh)
sandbox.

One bot is one declaration. The model type renders its sandbox profile,
environment library, entrypoints and service definitions from that declaration,
builds the workdir it runs in, loads it into the host's service manager, and
reports on what the sandbox actually enforces.

## Two platforms, one declaration

Nothing in a declaration names a platform, because none of it is a per-platform
decision. What differs is underneath:

|                     | macOS                                           | Linux                                          |
| ------------------- | ----------------------------------------------- | ---------------------------------------------- |
| Services            | launchd user agents in `~/Library/LaunchAgents` | systemd user units in `~/.config/systemd/user` |
| Confinement         | Seatbelt                                        | Landlock                                       |
| Established sockets | `lsof`                                          | `ss`, falling back to `lsof`                   |

Both unit files are rendered for every bot on **both** platforms, and both are
committed. Rendering only the host's would make `render --input check=true` —
the drift detector — report the other platform's file as drift on every run, on
both machines.

Two things on Linux will produce a deployment that reports perfect health and
enforces less than it claims, so `install` refuses on either unless you pass
`ignorePreflight=true`:

- **Kernel below 6.7.** nono's filesystem confinement is Landlock, from 5.13,
  but its TCP filtering needs Landlock ABI v4, which shipped in 6.7. Below that
  `open_port` and `allow_domain` are both inert — the same failure as running
  `nono wrap` instead of `nono run`, by a different road.
- **Lingering not enabled.** Without `loginctl enable-linger <user>` the user
  manager and every bot in it stop when you log out, and nothing says so.

## Quick start

```bash
swamp model create @skunk-ape/hermes/bot mybot
swamp model method run mybot scaffold --input slug=mybot

$EDITOR models/@skunk-ape/hermes/bot/mybot.yaml   # egress is left empty on purpose

swamp model method run mybot render               # write the runtime
swamp model method run mybot provision            # build the workdir
swamp vault put mybot-secrets anthropic-key        # prompts for the value
swamp vault put mybot-secrets telegram-bot-token   # prompts for the value
swamp model method run mybot verify               # prove the boundary
swamp model method run mybot install              # load it into launchd/systemd
```

## The declaration

```yaml
globalArguments:
  slug: mybot
  displayName: "My Bot"
  summary: "My Bot: allowlisted egress, one extra directory."
  vault: mybot-secrets

  telegram:
    allowedUsers: ["000000000"] # numeric Telegram user ids
    homeChannel: "000000000" # where cron results and notices land
    homeChannelName: "Owner DM"

  sandbox:
    # Domains this bot may reach. ["*"] is unrestricted.
    egress: ["api.anthropic.com", "api.telegram.org"]
    # Absolute paths granted in addition to the workdir.
    filesystemAllow: ["/Users/example/notes"]
    # Loopback ports it may connect to. Enforced for connect, not just bind.
    openPorts: []

  # Host-side MCP servers to wait for at startup. Each port must also appear in
  # sandbox.openPorts.
  mcps: []

  entrypoints: [gateway] # add `chat` for a terminal session
  runtime:
    provider: anthropic
    model: anthropic/claude-opus-5
```

`render` turns that into `profiles/<slug>.nono.json`, `bin/lib-<slug>-env.sh`,
`bin/run-<slug>.sh`, `launchd/sh.<slug>.gateway.plist`,
`systemd/sh.<slug>.gateway.service` and, with the `chat` entrypoint,
`bin/<slug>-chat.sh`. The files are written to the repository and committed;
nothing is rendered at boot.

## Methods

| Method      | What it does                                                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scaffold`  | Write a starter declaration for a new bot, with every field present and commented.                                                                                                             |
| `render`    | Write the sandbox profile, environment library, entrypoints and both platforms' service definitions.                                                                                           |
| `provision` | Build the workdir: directory tree, Hermes checkout, an interpreter and venv inside the workdir, the `funes` binary and its index hook, a starter `config.yaml` and `SOUL.md`.                  |
| `verify`    | Probe the sandbox from inside and report what it enforces.                                                                                                                                     |
| `install`   | Substitute the unit placeholders into this platform's unit directory and load every service the bot owns, MCPs before gateway. Refuses first if the host cannot enforce the declared boundary. |
| `uninstall` | Unload the services and remove their unit files. The workdir is left alone.                                                                                                                    |
| `status`    | Supervisor state and pid per service, whether each MCP port answers, and whether the gateway holds a live session to it.                                                                       |
| `restart`   | Bounce the MCPs, wait for their ports, bounce the gateway, confirm the sessions came back.                                                                                                     |
| `snapshot`  | Archive what another machine cannot rebuild, and nothing it can.                                                                                                                               |
| `restore`   | Put a snapshot back, rewriting the old machine's absolute paths.                                                                                                                               |

`render` and `provision` both take `--input check=true`, which reports what
would change and writes nothing. For `render` that is a drift check on the
generated files; for `provision` it is a completeness check on the workdir.

## The sandbox

Three fields describe the boundary, and each one widens it:

- **`egress`** — the domains the bot can reach. `["*"]` is unrestricted; a named
  list is enforced by the sandbox, and anything else is refused.
- **`filesystemAllow`** — paths readable and writable in addition to the
  workdir. Everything else on the host is denied, including the repository the
  vault lives in.
- **`openPorts`** — loopback ports the bot may connect to. A bot declaring `[]`
  cannot reach a local service, including another bot's MCP servers.

Declared MCPs are **reached, never spawned**: nono's confinement is inherited by
child processes, so a gateway-spawned server would run inside the sandbox and
lose both its credentials and its network. Each one is a long-lived HTTP server
on loopback, started outside the sandbox by its own launchd job. Their launchers
and plists are hand-written and not generated by this type; `install` expects to
find `launchd/sh.<slug>.<mcp>.plist` for each.

The schema refuses an MCP whose port `openPorts` does not include (the gateway
would start with no tools), a `chat` entrypoint with no `chat` block, and a
relative path in `filesystemAllow` (nono resolves it against nothing).

## Verification

`verify` builds its probe from the declaration, runs it inside the sandbox, and
reports one of four outcomes per check:

| Outcome   | Meaning                                        |
| --------- | ---------------------------------------------- |
| `PASS`    | The claim held.                                |
| `FAIL`    | The claim did not hold.                        |
| `VACUOUS` | The probe could not prove anything either way. |
| `GAP`     | The claim did not hold, and is known not to.   |

`VACUOUS` is never treated as a pass. A denial check against a path that does
not exist, or a loopback check with nothing listening on the far end, proves
nothing — so `verify` resolves path existence on the host and binds a real
listener before probing. Pass `foreignPorts` to name loopback services that
belong to something else; ports the bot declares are skipped.

## Provisioning

`provision` owns the inside of the workdir and nothing outside it. Host
packaging — nono, swamp, uv, node, python3 — is out of scope and must already be
present.

It is idempotent: every step skips what it finds, and re-running reports
`complete` when there was nothing to do. It never overwrites a file it did not
create, so `config.yaml` (which Hermes writes at runtime) and `SOUL.md` (which
you write) survive.

`--input seedHfFrom=<slug>` copies the embedding cache from another bot's
workdir instead of downloading it, which is the only route available to a bot
whose `egress` is a named allowlist.

## Fleet reporting

`status`, `render` and `verify` each write a data resource. The workflow-scoped
`@skunk-ape/hermes/fleet` report reads them and renders one table across every
bot in the run: what is running, what was proven, whether the generated files
still match the declaration, and a **Boundaries** table comparing egress,
filesystem grants, loopback ports and MCP counts side by side. Checks that
reported `VACUOUS` are listed separately, so "0 fail" is never read as "all
verified".

## Secrets

Each bot names one vault. The entrypoint resolves secrets at startup with
`swamp vault read-secret` and holds them in process memory; nothing is written
to disk, and the sandbox denies the bot access to the repository the vault lives
in. `secretKeys` names which keys to read, and defaults to `anthropic-key` and
`telegram-bot-token`.

## Moving a bot to another machine

A workdir is several gigabytes and almost none of it should travel. The
interpreter, the venv, the staged `funes` binary and the caches are all
architecture-specific — on another machine they are the wrong object format, and
the failure arrives late and looks unrelated — and all of them are what
`provision` exists to rebuild. `snapshot` carries the roughly thirty megabytes
that are irreplaceable: `state.db`, the Funes memory, cron, skills, `SOUL.md`
and the `config.yaml` the agent has been editing since it was provisioned.

```bash
# on the old machine, with the gateway stopped
swamp model method run mybot snapshot

# on the new one, after render + provision
swamp model method run mybot restore \
  --input archive=/path/to/mybot-....tar.gz \
  --input fromHome=/Users/you
```

`fromHome` is the part that matters. `config.yaml` names the funes MCP command
and the `post_llm_call` hook by absolute path, so a snapshot restored verbatim
onto a machine with a different home gives you a gateway that starts, connects,
answers, reports healthy — and has no memory tool, because the MCP it was told
to spawn is a path that does not exist. There is no port to probe and no session
to count, so nothing else notices. `restore` rewrites those paths, and reports
every mention of the old host it could not fix.

Anything a bot grew outside the standard tree has to be declared, or it will not
travel and nothing will say so:

```yaml
state:
  extraPaths: [knowledge, creative]
```

## Prerequisites

- swamp initialized in the repository (`swamp repo init`)
- nono on PATH (https://nono.sh)
- `uv`, `git` and `python3` on PATH, for `provision` and `verify`
- a vault holding the bot's credentials
- on Linux: kernel 6.7+, `loginctl enable-linger <user>`, and `iproute2`

## License

MIT. See `LICENSE`.
