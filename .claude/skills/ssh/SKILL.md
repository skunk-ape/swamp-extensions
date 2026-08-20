---
name: ssh
description: Run remote commands, upload files, and wait for SSH reachability with the @keeb/ssh extension. Use when wiring SSH operations into swamp workflows or models — exec shell commands on a remote host, scp a file with `upload`, or block until a host's SSH is reachable with `waitForConnection`. Triggers on "ssh exec", "scp upload", "wait for ssh", "remote command over ssh", "@keeb/ssh", "ssh/host model", or when composing workflows with proxmox/docker/alpine/tailscale/nginx/prometheus/grafana/minecraft/terraria extensions that depend on this one.
---

# @keeb/ssh

General-purpose SSH operations for swamp. Foundational model used by many other
`@keeb/*` extensions (proxmox, docker, alpine, tailscale, nginx, prometheus,
grafana, minecraft, terraria).

## Model: `@keeb/ssh/host`

Single model. All methods share the same connection arguments via
`globalArguments`.

### Global arguments

| Field          | Type   | Default  | Notes                                                                   |
| -------------- | ------ | -------- | ----------------------------------------------------------------------- |
| `host`         | string | required | Hostname or IP                                                          |
| `user`         | string | `root`   | SSH user to log in                                                      |
| `via`          | enum   | `key`    | Transport: `key` \| `tailscale` \| `bastion` \| `proxy-command`         |
| `bastion`      | string | —        | `user@jump-host` — required when `via: bastion`                         |
| `proxyCommand` | string | —        | Command string for `-o ProxyCommand=…` — required when `via: proxy-command` |

Default (`via: key`) authentication relies on the local SSH agent / key files.
The model invokes the system `ssh` and `scp` binaries with
`StrictHostKeyChecking=no` and `UserKnownHostsFile=/dev/null`, so host keys are
not verified — fine for ephemeral infra, not for anything where MITM matters.

#### Transports

- **`key`** — plain `ssh`/`scp`, ambient agent + `~/.ssh` keys. Current/default behavior.
- **`tailscale`** — `tailscale ssh user@host`. Tailnet identity replaces static keys; strict-host-key flags are dropped (Tailscale handles peer auth). Requires `tailscaled` running on the machine executing the model. Upload streams the file via `tailscale ssh "cat > dest"` — fine for configs, not optimized for huge binaries.
- **`bastion`** — adds `-J user@bastion` to ssh and scp. Single hop only; chain multiple with comma-separated `-J` if you need it (pass the whole list in `bastion`).
- **`proxy-command`** — adds `-o ProxyCommand=<string>`. Use for AWS SSM Session Manager, GCP IAP, Cloudflare tunnels, etc. `%h` and `%p` are expanded by ssh.

### Methods

#### `exec`

Run a shell command on the remote host. Throws on non-zero exit.

| Argument  | Type   | Default | Notes                |
| --------- | ------ | ------- | -------------------- |
| `command` | string | —       | Command to execute   |
| `timeout` | number | `60`    | Seconds (advisory\*) |

\*The current implementation does not actually enforce `timeout` on the `ssh`
process itself; the `ConnectTimeout=10` flag only bounds the initial connection.
Long-running commands will still hang the run. Wrap risky commands in a remote
`timeout(1)` if you need a hard cap.

Result resource fields: `stdout`, `stderr`, `exitCode`, `command`, `host`,
`logs`, `timestamp`.

#### `upload`

Copy a local file to the remote host. Internally shells out to `scp` (the method
description says "rsync" — that's stale; it's plain scp).

| Argument | Type   | Notes                 |
| -------- | ------ | --------------------- |
| `source` | string | Local path            |
| `dest`   | string | Remote path on `host` |

Result fields: `source`, `dest`, `host`, `success`, `logs`, `timestamp`.

#### `waitForConnection`

Polls SSH every 3s until `echo ready` succeeds or `timeout` elapses. Throws if
the host never becomes reachable.

| Argument  | Type   | Default | Notes      |
| --------- | ------ | ------- | ---------- |
| `timeout` | number | `60`    | In seconds |

Result fields: `connected: true`, `host`, `logs`, `timestamp`.

## Resource

One resource type: `result` — `lifetime: infinite`, `garbageCollection: 10`
(retains the last 10 versions). All three methods write a single `result`
handle.

## Workflow patterns

### Provision then exec

```yaml
jobs:
  bootstrap:
    steps:
      - id: wait
        model: "@keeb/ssh/host"
        method: waitForConnection
        globalArguments:
          host: "${{ inputs.host }}"
          user: root
        arguments:
          timeout: 300

      - id: install
        model: "@keeb/ssh/host"
        method: exec
        needs: [wait]
        globalArguments:
          host: "${{ inputs.host }}"
          user: root
        arguments:
          command: "apk add --no-cache curl"
```

### Upload then run

```yaml
- id: push-script
  model: "@keeb/ssh/host"
  method: upload
  globalArguments: { host: "${{ inputs.host }}", user: root }
  arguments:
    source: ./scripts/setup.sh
    dest: /tmp/setup.sh

- id: run-script
  model: "@keeb/ssh/host"
  method: exec
  needs: [push-script]
  globalArguments: { host: "${{ inputs.host }}", user: root }
  arguments:
    command: "sh /tmp/setup.sh"
```

### Reading prior results with CEL

`exec` writes `stdout`, `stderr`, `exitCode`. Reference downstream with CEL:

```yaml
- id: parse
  model: "@user/some/parser"
  arguments:
    raw: "${{ steps.install.result.stdout }}"
```

## Transport examples

### Through a jump host

```yaml
- model: "@keeb/ssh/host"
  method: exec
  globalArguments:
    host: "10.0.5.7"
    user: "root"
    via: bastion
    bastion: "ops@jump.example.com"
  arguments:
    command: "uptime"
```

### Over Tailscale

```yaml
- model: "@keeb/ssh/host"
  method: exec
  globalArguments:
    host: "node-01"          # tailnet name or IP
    user: "root"
    via: tailscale
  arguments:
    command: "uname -a"
```

### AWS SSM Session Manager

```yaml
- model: "@keeb/ssh/host"
  method: exec
  globalArguments:
    host: "i-0123456789abcdef0"
    user: "ec2-user"
    via: proxy-command
    proxyCommand: "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p"
  arguments:
    command: "id"
```

## Gotchas

- **Host key checking is disabled** for `via: key`, `bastion`, and
  `proxy-command`. Do not use against hosts where strict identity matters.
  Tailscale relies on its own peer auth instead.
- **No password auth.** Only key-based SSH (whatever the local agent / `~/.ssh`
  provides) works for non-tailscale transports. There is no
  `password`/`privateKey` argument.
- **`tailscale` upload streams via cat**, not scp — no resume, no progress, and
  it overwrites without warning. Switch to a different transport for big files.
- **`bastion`/`proxy-command` require their companion field.** Setting
  `via: bastion` without `bastion`, or `via: proxy-command` without
  `proxyCommand`, raises before the connection attempt.
- **`exec` throws on non-zero exit.** If you need to inspect a failing command's
  output, capture it remotely (`cmd; echo $?`) or wrap in `|| true`.
- **`upload` is scp, not rsync.** No partial transfers, no delta sync, no
  recursive flag is set — single files only by default.
- **`timeout` on `exec` is not enforced** by the implementation. Add remote-side
  guards for long commands.
- **No vault integration.** Credentials are not pulled from a swamp vault; the
  model relies on ambient SSH agent state. If you need per-host keys, configure
  them in `~/.ssh/config` outside swamp.
- **`user` default is `root`.** Override explicitly when targeting cloud images
  that ship with `ec2-user`, `ubuntu`, `admin`, etc.
