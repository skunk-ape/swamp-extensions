# swamp-extensions

Swamp extensions published under `@skunk-ape`.

## Extensions

| Extension | Path | What it does |
| --- | --- | --- |
| `@skunk-ape/stef` | `extensions/stef/` | Simple Technical English Flavored — a deterministic prose linter, a mechanical fixer, and a bounded LLM rewrite loop. |
| `@skunk-ape/rocky-road` | `extensions/rocky-road/` | Chunked implementation for `@swamp/software-factory` — a factory definition, a board report, and the skill that drives it. |
| `@skunk-ape/hermes` | `extensions/hermes/` | Install and configure the Hermes agent on a host reached over SSH. In design. See `DESIGN.md`. |

## Layout

Each extension is self-contained. The manifest sits beside the code it names,
and it sets `paths: base: manifest`, so typed entries and `additionalFiles`
both resolve from the manifest directory rather than from the repository root.
Add a new extension as a new directory. Do not add a manifest at the root.

Skills are the exception to that rule. Swamp installs a skill to
`.claude/skills/<name>/` at the repository root, so a manifest names the skill
and swamp resolves it from there.

Some state is shared across every extension in this repository:

- `.swamp.yaml` — the repository identity, written by `swamp repo init`.
- `grants/` — authorization policy. Read the caveat at the top of
  `grants/sandbox.yaml` before you add a model. A model that reaches outward,
  meaning anything that posts, ships, or deploys, stays out of the sandbox
  grants and runs from the host.
- `vaults/` — vault configuration.
- `models/` — model instances, both local and pulled.

## Work on one extension

Every command takes the path to that extension's manifest:

```bash
swamp extension fmt     extensions/stef/manifest.yaml
swamp extension quality extensions/stef/manifest.yaml
swamp extension push    extensions/stef/manifest.yaml
```

Tests run under the deno that swamp vendors, so no separate deno install is
needed:

```bash
~/.swamp/deno/deno test --allow-all extensions/stef/
```

## License

Apache 2.0. See `LICENSE`.
