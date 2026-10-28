# swamp-extensions

Swamp extensions published under `@skunk-ape`, kept in one repository. The
layout is meant to be copied: one directory per extension, and one swamp
repository around them to develop and test against.

## Extensions

| Extension | What it does |
| --- | --- |
| [`@skunk-ape/coros`](extensions/coros/) | COROS sleep, recovery, training data and workouts as swamp data, from the official MCP server and the Training Hub API. |
| [`@skunk-ape/hermes`](extensions/hermes/) | Run Hermes agents on macOS or Linux, each confined to its own directory by a nono sandbox. |
| [`@skunk-ape/restic-backup`](extensions/restic-backup/) | Nightly restic backups of a whole machine, with live SQLite databases copied consistently, on a repository several machines can share. |
| [`@skunk-ape/rocky-road`](extensions/rocky-road/) | Chunked implementation for `@swamp/software-factory`: a factory definition, a board report, and the skill that drives it. |
| [`@skunk-ape/stef`](extensions/stef/) | Simple Technical English Flavored: a deterministic prose linter, a mechanical fixer, and a bounded LLM rewrite loop. |
| [`@skunk-ape/swamp-lab`](extensions/swamp-lab/) | A daily digest of Swamp Club's public Lab: what shipped, what was opened, and what lands near your own work. |
| [`@skunk-ape/web-brief`](extensions/web-brief/) | Web access for an autonomous agent without a browser: fetch, sanitize, and reduce pages to a structured brief. |

## Layout

```
swamp-extensions/
├── extensions/              everything that gets published
│   ├── stef/
│   │   ├── manifest.yaml    paths: base: manifest
│   │   ├── stef.ts          export const behavior
│   │   ├── stef_test.ts
│   │   ├── _lib/
│   │   ├── README.md
│   │   ├── LICENSE
│   │   └── quality.yaml     accepted quality warnings, if any
│   └── …
├── .claude/skills/          skills an extension ships
├── models/                  behavior instances used for local testing
├── vaults/                  vault configuration
├── grants/                  authorization policy for swamp serve
└── .swamp.yaml              modelsDir: "extensions"
```

Each extension is one directory directly under `extensions/`, whatever it
contains. A behavior, a report and a skill can ship together, and swamp finds
each one by what the file exports, not by the directory it is in.

Two settings make this work:

- **`modelsDir: "extensions"`** in `.swamp.yaml`. By default swamp loads local
  extensions from `extensions/models/`. Pointing it at `extensions/` loads
  every extension in this repository, so the behaviors and reports you are
  editing are the ones `swamp behavior run` executes.
- **`paths: base: manifest`** in every manifest. Entries such as `behaviors:`,
  `reports:` and `additionalFiles:` resolve from the manifest's own directory,
  so a manifest names `stef.ts`, not a path from the repository root.

Skills are the one thing that lives outside the extension directory. Swamp
installs a skill to `.claude/skills/<name>/` at the repository root, so a
manifest names the skill and swamp resolves it from there.

## Add an extension

Create a directory under `extensions/` with a manifest beside the code. Do not
add a manifest at the repository root.

```yaml
manifestVersion: 1
name: "@skunk-ape/my-extension"
version: 2026.10.28.1
license: MIT
description: One clear sentence about what this extension does.
repository: "https://github.com/skunk-ape/swamp-extensions"

paths:
  base: manifest

behaviors:
  - my_extension.ts
additionalFiles:
  - LICENSE
  - README.md
```

Write the behavior with `export const behavior` and pin every `npm:` and `jsr:`
import to an exact version. `npm:zod@4` is the exception: swamp supplies zod
at runtime, so it stays as written.

## Work on one extension

Every command takes the path to that extension's manifest:

```bash
swamp extension fmt     extensions/stef/manifest.yaml
swamp extension quality extensions/stef/manifest.yaml
swamp extension push    extensions/stef/manifest.yaml --dry-run
```

Tests run under the deno that swamp vendors, so no separate deno install is
needed:

```bash
~/.swamp/deno/deno test --allow-all extensions/stef/
```

### Review reports

`swamp extension push` looks for an adversarial review report bound to the
extension's content hash. The default location is under the system temp
directory, which does not survive, so each extension keeps its reports in
`.reviews/swamp-extension-review/` and a push finds them with:

```bash
SWAMP_EXTENSION_REVIEW_DIR=$PWD/extensions/stef/.reviews \
  swamp extension push extensions/stef/manifest.yaml --dry-run
```

The hash changes on any change to the extension, including moving its
directory. A report whose hash matches no current source is a review of an
older version, kept as the record of what was reviewed when.

## Shared state

- `models/` holds behavior instances, both of these extensions and of pulled
  ones. They exist to exercise the extensions locally.
- `grants/` is authorization policy for `swamp serve`. Read the caveat at the
  top of `grants/sandbox.yaml` before you grant a behavior: `run` on a behavior
  is `run` on all of its methods. A behavior that reaches outward, meaning
  anything that posts, ships or deploys, stays out of the sandbox grants and
  runs from the host.
- `vaults/` holds vault configuration. Secrets stay in `.swamp/`, which is not
  committed.

## License

MIT. See `LICENSE`.
