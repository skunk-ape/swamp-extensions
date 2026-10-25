# @skunk-ape/restic-backup

Encrypted, deduplicated backups of one machine with
[restic](https://restic.net/), driven from swamp, on a repository several
machines may share.

## Methods

| Method      | What it does                                                                            |
| ----------- | --------------------------------------------------------------------------------------- |
| `init`      | Create the repository (idempotent); for an S3 bucket, apply the lifecycle policy        |
| `backup`    | Stage databases and captures, back up `paths`, tag with `machineTag`; `dryRun` previews |
| `snapshots` | List snapshots, optionally by `host` and `tag`                                          |
| `check`     | Verify integrity, optionally reading all or a subset of pack data                       |
| `ls`        | List a snapshot's files, up to `limit`                                                  |
| `restore`   | Restore a snapshot, or `include`d paths, into `target`                                  |
| `forget`    | Retention for this machine only (host **and** tag); `prune` and `dryRun` opt-in         |
| `rekey`     | Change the repository password                                                          |

Results land as data: `status` (last backup summary, last check) and
`snapshots`.

```bash
swamp model method run my-backup backup --input dryRun=true
swamp data query 'modelName == "my-backup" && name == "status"' --select 'attributes.lastBackup' --json
```

## Configuration

```yaml
globalArguments:
  repository: s3:s3.us-east-2.amazonaws.com/my-bucket # or bucket: my-bucket
  awsAccessKeyId: ${{ vault.get(backups, AWS_ACCESS_KEY_ID) }}
  awsSecretAccessKey: ${{ vault.get(backups, AWS_SECRET_ACCESS_KEY) }}
  resticPassword: ${{ vault.get(backups, RESTIC_PASSWORD) }}
  machineTag: laptop
  paths: [~/src, ~/.config, ~/.ssh]
  excludes: [node_modules, .venv, "*.tmp"]
  sqlite:
    - ~/.local/share/*/*.db
    - ~/src/*/.swamp/data/*.db
  captures:
    - { name: pacman-explicit, command: [pacman, -Qqe] }
  keepDaily: 7
  keepWeekly: 4
  keepMonthly: 12
```

`excludeCaches` (on by default) skips any directory holding a `CACHEDIR.TAG`.

## Live SQLite databases

Every file matching a `sqlite` glob that starts with the SQLite header is copied
with `sqlite3 .backup` into `<stagingDir>/sqlite/<original path>` and backed up
from there. The original and its `-wal`, `-shm` and `-journal` are excluded. The
staging directory is emptied before each backup and removed after; it is never
cleared unless it carries the marker file this behavior writes, so pointing
`stagingDir` at an existing directory fails safely.

Globs are expanded one segment at a time: `*` reads only the directories it
must, while `**` walks the whole subtree, so prefer `*` on large trees.

To restore a database, restore its staged copy and move it to the original path
while nothing has the database open:

```bash
swamp model method run my-backup restore \
  --input target=/tmp/r --input 'include=["/home/me/.local/state/restic-backup/laptop/sqlite/home/me/app/state.db"]'
mv /tmp/r/home/me/.local/state/restic-backup/laptop/sqlite/home/me/app/state.db ~/app/state.db
```

## Captures

Each capture's stdout is saved as `<stagingDir>/captures/<name>.txt`. A capture
that fails is recorded in the backup summary and does not stop the backup.

## Shared repositories

`backup` tags every snapshot with `machineTag`. `forget` requires a host and a
tag, passes `--host` and `--tag` together with `--group-by host,paths`, and
first lists what that selector matches, aborting if it includes a snapshot of
another host or without the tag. An instance with no `machineTag` and no `paths`
is therefore a safe read-only handle on another machine's snapshots.

Pruning repacks pack files repository-wide; on data already in Glacier IR that
costs retrieval and re-upload, so it is opt-in.

## Upgrading from 2026.09.08.1

- `status` and `snapshots` data are now named `status` and `snapshots` (both
  were `current`, so reading one could return the other).
- `bucket` and the AWS keys are optional; set `repository` for non-S3 backends.
- An empty `paths` makes `backup` refuse rather than fall back to defaults.
- Exit code 3 (some files unreadable) is recorded as an incomplete snapshot, not
  thrown.
