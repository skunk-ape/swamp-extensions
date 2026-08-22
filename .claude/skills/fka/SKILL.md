---
name: fka
description: >
  Wrap a command-line tool in tier-named wrappers so an agent can run its safe
  commands without a permission prompt, using the @skunk-ape/fka model and
  the fka workflow. Analyses a CLI's commands, sorts them into read-safe,
  read-private, modify, and escape, and generates wrappers, a settings snippet,
  and a skill snippet. Use when asked to wrap a CLI, reduce permission prompts
  for a tool, work out which commands of a tool are safe to run unattended, or
  regenerate wrappers after a tool upgrade. Triggers on
  "fka", "wrap a CLI", "wrap gh", "safe-", "tier the commands",
  "too many permission prompts", "let the agent run <tool> without asking",
  "which commands of <tool> are safe", "regenerate the wrappers".
  Also use to interpret a wrapper refusal.
---

# fka — formerly known as

Take a CLI the agent already has, work out which of its commands are safe to run
unattended, and generate a wrapper that enforces the answer.

`gh` becomes `safe-gh`, `private-gh`, and `write-gh`. The tier moves out of the
argument list and into the command name, so one short permission rule covers a
whole tier — and the wrapper re-parses every argument, so the rule is true.

**You never install what this produces.** The last step is handing a person the
permission snippet and asking them to merge it. Do not edit `settings.json`
yourself, and do not use the `update-config` skill to do it for you.

## When a wrapper refuses

A refusal exits 126 and names the token at fault. It means the argument is
outside that tier, not that the command failed. There are two honest responses:

- Run the same command on the next tier up. Those prompt, which is the point.
- Tell the user the tier table looks wrong, and offer to re-run the workflow.

Never route around a refusal by calling the tool directly, by its absolute path,
or through another program that runs it. If you find yourself reaching for one
of those, the answer is a prompt, not a workaround.

## Running the pipeline

The workflow chains four methods around one human gate. Run it whole.

```
swamp workflow run @skunk-ape/fka --input cli=gh
```

Scope a large tool to the subtrees you actually use. `aws` has thousands of
operations and nobody reviews that; `aws s3` and `aws ec2` is a review a person
finishes.

```
swamp workflow run @skunk-ape/fka --input cli=aws --input include='["s3","ec2"]'
```

The run suspends at `review`. That is not a failure — it is the gate.

### What each stage does

| Stage      | Kind          | What it decides                                  |
| ---------- | ------------- | ------------------------------------------------ |
| `discover` | deterministic | What the commands and options are actually called |
| `classify` | model session | A proposed tier for each, plus an option allowlist |
| `review`   | a person      | The tiers that will be enforced                   |
| `generate` | deterministic | The wrappers, the settings snippet, the skill snippet |
| `verify`   | deterministic | That each wrapper permits its tier and nothing above |

## Driving the human gate

This is the part where you are useful, so do it properly.

### Step 1 — Read the proposal, then say something about it

```
swamp data get fka-<cli> proposal-<cli> --json | jq -r '.content |
  "\(.counts["read-safe"]) read-safe, \(.counts["read-private"]) read-private, \(.counts.modify) modify, \(.counts.escape) escape
\(.nextAction)"'
```

Then read the review file itself and **summarise the read-safe block for the
user in your own words**. Not the whole table — the read-safe list is the only
tier that runs with nobody watching, and it is the only one worth a person's
attention. Every other tier still stops at a prompt, so a mistake there costs a
keystroke.

Call out anything in `read-safe` that reads like it could:

- print a token, a private URL, or a customer name
- reach the network at an address the caller chooses
- cost money per invocation
- take a free positional argument (check `positionals: any`)

```
swamp data get fka-<cli> proposal-<cli> --json | jq -r '.content.rejected[], .content.notes[]'
```

`rejected` is what the classifier proposed that the crawl never saw — it was
discarded, and a long list is a reason to distrust the rest. `notes` is what it
skipped; anything skipped is refused by every wrapper.

### Step 2 — Offer the edits, let the person make the call

Suggest specific moves ("`gh api` is read-safe here and it will issue any HTTP
verb — that belongs in escape"). Edit the review file when asked. Deleting a
line is always the safe edit: anything absent is refused.

### Step 3 — Approve and finish

```
swamp workflow approve @skunk-ape/fka review
swamp workflow resume @skunk-ape/fka
```

## Handing over the result

`generate` writes a settings snippet and never installs it. Show the user the
snippet and ask them to merge it into `.claude/settings.json`:

```
swamp data get fka-<cli> generated-<cli> --json | jq -r '.content.settingsSnippet'
```

Say plainly what it does: `safe-<cli>` runs without asking, the other wrappers
prompt, and the bare tool is denied so you reach for the wrappers instead. Say
plainly what it does not do: the deny rule is a prefix match on the command
line, so an absolute path is not covered. It steers, it does not sandbox.

Then offer the skill snippet for the project that will use the wrappers, and
tell them the wrappers need to be on `PATH`:

```
swamp data get fka-<cli> generated-<cli> --json | jq -r '.content.skillSnippet'
swamp data get fka-<cli> generated-<cli> --json | jq -r '.content.binDir'
```

## After a tool upgrade

New subcommands are absent from the table, so every wrapper refuses them. That
is the intended failure, and `verify` reports the version drift that explains
it:

```
swamp model method run fka-<cli> verify --input cli=<cli>
swamp data get fka-<cli> verification-<cli> --json | jq -r '.content |
  "drifted=\(.drifted) \(.versionAtGenerate) -> \(.versionNow)"'
```

Re-run the whole workflow to pick the new commands up. The review gate runs
again, which is correct — new commands have never been reviewed.

## Configuration worth knowing

Set these in the model definition's `globalArguments`.

| Argument       | Default          | Why you would change it                        |
| -------------- | ---------------- | ----------------------------------------------- |
| `docsMode`     | `none`           | `web` lets the classifier read the tool's docs, which help text often does not cover. It also puts a network-capable session in front of pages you do not control. |
| `emit`         | three tiers      | Add `escape` only if you want a wrapper for the dangerous commands. |
| `maxDepth`     | `3`              | Deeper command trees. |
| `maxCommands`  | `400`            | Raise for a big tool, or scope with `include` instead. |
| `envScrub`     | eight variables  | Extra variables every wrapper deletes before exec. |

## What this cannot do

It controls the argument vector and nothing else. An allowlisted `git log` still
reads `~/.gitconfig`, and a `[diff] external =` hook there still runs. If the
threat model includes someone who can already write the user's dotfiles, say so
rather than implying this covers it.

It also does not make the classifier trustworthy. It makes its mistakes cheap:
they surface as a refused command or an edit at the review gate.
