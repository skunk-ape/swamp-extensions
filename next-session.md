# fka pre-publish — session hand-off (2026-08-25)

Goal: local-test the `@skunk-ape/fka` extension by wrapping real CLIs with it,
fixing what the testing finds, before publishing.

## Where the work lives

- Repo: `/Users/seth/src/swamp-extensions`; all fixes are on branch
  `fix/fka-pre-publish` in worktree `.claude/worktrees/fix-fka-pre-publish`
  (enter via `EnterWorktree` with that path — it branches from local main, which
  has the fka commits; origin/main does not).
- `main` is 13 commits ahead of origin. **Push is deliberately deferred — Seth decides.**
- Tests: `<deno> test -A extensions/models/fka/` — 220/220 green. Deno binary:
  `/nix/store/2mdy7lx8f6kc2s0xmjsjpp2gjyiyys37-deno-2.9.2/bin/deno` (not on PATH).

## Commits on the branch (all tested)

1. `5cb9c5b` discover/classify fixes:
   - wrapped help descriptions are continuation prose, not phantom commands
     (was inventing `doctor issues.` etc. from cliff-style wrapped help);
   - new `listCommand` globalArg + workflow input — an argv enumerating the tool's
     full command list (`help -a` for git; root `--help` lists only 25 of ~200);
   - classifier model inherits the caller's Claude Code default (empty `model`
     omits `--model`); the `claude-opus-5` pin is gone; `askArgv` extracted/tested;
   - docs updated (README/DESIGN/SKILL).
2. `4b61ad4` wrapper scrubs `LD_*`/`DYLD_*` unconditionally before exec — fixes a
   real crash (Deno refuses scoped `--allow-run` spawns inheriting linker vars).
3. `a0da31a` same strip at the other spawn sites via `_lib/env.ts`
   (`stripLinkerEnv`/`withoutLinkerEnv`): the discover crawl and `spawnAsk`.
   `verify`'s spawnCheck needs nothing (FKA_CHECK mode never spawns the tool).

## Wrap-run state (workflow `@skunk-ape/fka`, run from the worktree)

- **git — SUSPENDED at review.** Full-surface table (~200 cmds). Re-apply gate
  edits before approve: (1) status options `--porcelain/--no-porcelain`,
  `-u/--untracked-files/--no-untracked-files`, `--ignored/--no-ignored` at
  arity 0; (2) add wrapper `git-routine` (segment `write`,
  `admits: {maxTier: modify, paths: [[add],[branch]]}`); (3) strip from
  `branch`'s table: `-d --delete --no-delete -D`, `-m -M --move --no-move`,
  `-f --force --no-force`, `-C`, `-u --set-upstream-to`.
- **gh — SUSPENDED at review.** No pre-planned edits; review the proposal fresh.
- **swamp — FAILED at classify**: one batch exceeded the 300s ask wall
  (`wallTimeoutMs` default). Run id `5b9b38ca-7ae7-4d7f-861f-ffd7143b3977`.
  Resume: `swamp workflow resume @skunk-ape/fka --run <id> --from classify`,
  or first wire `wallTimeoutMs`/`batchSize` (existing globalArgs) as workflow
  inputs and re-run. Gate edit to re-apply afterwards: wrapper `swamp-push-dry`
  (segment `write`, `admits: {maxTier: modify, paths: [[extension,push]]}`,
  `append: [--dry-run]`) — Seth runs `extension push --dry-run` constantly.
- **deno — FAILED instantly**: workflow bug — `modelName: fka-${{ inputs.cli }}`
  with a path cli (`/Users/seth/.swamp/deno/deno`) fails definition-name
  validation ('/' rejected). Fix the workflow for path clis (basename/name
  input), then re-run. Target binary: `~/.swamp/deno/deno` (2.8.3, swamp-bundled).

## Facts worth knowing

- swamp rebuilds `.swamp/bundles/<hash>/fka/fka.js` from source automatically —
  never delete it. `model type describe` may show a stale version string even
  when the bundle is fresh (cosmetic quirk; grep the bundle to verify content).
- Per-option tiers are enforced by `toPolicy`: `--server/--token/--ca-cert` on
  read-safe swamp commands are escape-tier → unreachable from unattended aliases.
- Old dev-run artifacts sit in `~/.config/fka/git/` (backup: `review.yaml.prev-run`);
  the suspended git run's `generate` replaces the wrappers there.
- `fka-git` usage skill installed at `~/.claude/skills/fka-git/SKILL.md`.

## Pending for Seth

1. Merge global settings `~/.claude/settings.json`: allow `Bash(fka-help:*)`,
   `Bash(fka-safe:*)`, `Bash(fka-write-git-routine:*)` (add
   `Bash(fka-write-swamp-push-dry:*)` once swamp wraps); ask `Bash(fka-write:*)`
   and `Bash(fka-private:*)`. Snippets land at `~/.config/fka/<cli>/settings.snippet.json`.
2. Remove the broad `"Bash"` allow from this repo's `.claude/settings.local.json`.
3. Push main / merge this branch, then publish the extension.

## Findings list (pre-publish)

1. ~~Wrapped-help phantom commands~~ — fixed (`5cb9c5b`).
2. ~~Thin git surface~~ — `listCommand` fixed enumeration; thin option lists
   stay (man pages are refused by design) — documented in DESIGN.md.
3. ~~Hardcoded opus~~ — fixed (`5cb9c5b`).
4. `modelName` breaks for path clis — open (deno run failure above).
5. Optional: expose `wallTimeoutMs`/`batchSize` as workflow inputs.

Queue log (for reference):
`/private/tmp/claude-501/-Users-seth-src-swamp-extensions/6e6f9378-c772-472e-b8f0-81d4db9205ed/tasks/bjzuuy7li.output`
