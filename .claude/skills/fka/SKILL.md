---
name: fka
description: >
  Wrap a command-line tool in tier-named aliases so an agent can run its safe
  commands without a permission prompt, using the @skunk-ape/fka model and its
  workflow. Aliases are named fka-safe-gh, fka-help-gh and so on, so one
  permission rule per segment covers every tool you ever wrap. Analyses a CLI's commands, sorts them into read-safe,
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

`gh` becomes `fka-safe-gh`, `fka-write-gh`, and whatever else the plan for gh
called for. The name carries what a permission rule needs to know, and the
wrapper re-parses every argument, so the rule is true.

**You never install what this produces.** The last step is handing a person the
permission snippet and asking them to merge it. Do not edit `settings.json`
yourself, and do not use the `update-config` skill to do it for you.

## Help always works

```bash
fka-help-gh pr close           # prints, even though nothing else will close a PR
fka-help-gh pr close --json    # refused: this alias pins --help and takes nothing else
```

The help alias reaches every command, because reading what one does is not doing
it. Ask here rather than escalating a segment to find out what a command takes.

## When a wrapper refuses

A refusal exits 126 and names the token at fault. It means the argument is
outside that alias, not that the command failed. There are two honest responses:

- Run the same command on a wider alias. Those prompt, which is the point.
- Tell the user the table looks wrong, and offer to re-run the workflow.

Never route around a refusal by calling the tool directly, by its absolute path,
or through another program that runs it. If you find yourself reaching for one
of those, the answer is a prompt, not a workaround.

## Running the pipeline

The workflow chains `tally`, `discover`, `classify`, `generate`, and `verify`
around one human gate. Run it whole.

```
swamp workflow run @skunk-ape/fka --input cli=gh
```

Scope a large tool to the subtrees you actually use. `aws` has thousands of
operations and nobody reviews that; `aws s3` and `aws ec2` is a review a person
finishes.

```
swamp workflow run @skunk-ape/fka --input cli=aws --input include='["s3","ec2"]'
```

A root help sometimes names only the common commands — `git --help` lists 25 of
~200. Point discover at the tool's own full listing when it has one.

```
swamp workflow run @skunk-ape/fka --input cli=git --input listCommand='help -a'
```

The run suspends at `review`. That is not a failure — it is the gate.

### What each stage does

| Stage      | Kind          | What it decides                                       |
| ---------- | ------------- | ----------------------------------------------------- |
| `tally`    | deterministic | Which commands are worth analysing at all             |
| `discover` | deterministic | What those commands and options are actually called   |
| `classify` | model session | A proposed tier for each, plus an option allowlist    |
| `review`   | a person      | The tiers that will be enforced                       |
| `generate` | deterministic | The wrappers, the settings snippet, the skill snippet |
| `verify`   | deterministic | That each wrapper permits its tier and nothing above  |

`score` is a separate, deterministic method — false refusals and leakage,
measured against real use — but it is **not** a step in the workflow above.
Run it yourself once a tool has been through `generate`:

```bash
swamp model method run @skunk-ape/fka score --model fka-<cli> --input cli=<cli>
```

## Driving the human gate

This is the part where you are useful, so do it properly.

### Step 1 — Read the proposal, then say something about it

```
swamp data get fka-<cli> proposal-<cli> --json | jq -r '.content |
  "\(.counts["read-safe"]) read-safe, \(.counts["read-private"]) read-private, \(.counts.modify) modify, \(.counts.escape) escape
\(.nextAction)"'
```

Then read the review file itself and **summarise the read-safe block for the
user in your own words**. Not the whole table — the read-safe list is the tier
that runs with nobody watching. Every other tier still stops at a prompt, so a
mistake there costs a keystroke.

**Then summarise the `wrappers` block too.** It is a handful of lines and it is
not a tier. `prepend` and `append` pin tokens into every call an alias makes, so
a pinned option is permitted at every command that alias admits — a tier says
what a command may do, a pin says what every command gets. Pins are checked
against the crawl and against the alias's own ceiling, so an invented or
over-tier pin is rejected before it renders; what remains is judgement about
whether pinning that option was wanted at all. Name every `prepend` and `append`
you find, and say what each one does to the argument vector.

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

Two approvals, and they are not the same one. The workflow step releases the
run; `approved: true` in the review file releases `generate`, which refuses to
render while it is false. Set the flag first, or the run resumes and then fails.

Setting it is the person's call, not yours. Ask for it rather than editing it in
on their behalf — the flag means a human read the table, and it is worth
nothing if you are the one who set it.

```
swamp workflow approve @skunk-ape/fka review
swamp workflow resume @skunk-ape/fka
```

If `generate` fails saying the file is not approved, the flag was not set. If it
fails listing entries the crawl never saw, an edit named something the tool does
not have — it re-checks the edited table, so fix those lines and resume.

## Handing over the result

`generate` writes a settings snippet and never installs it. Show the user the
snippet and ask them to merge it into `.claude/settings.json`:

```
swamp data get fka-<cli> generated-<cli> --json | jq -r '.content.settingsSnippet'
```

Say plainly what it does. Rules are keyed on the segment, not the tool, so this
is a one-time paste: `fka-help-*` and `fka-safe-*` run without asking, the rest
prompt, and wrapping another CLI later needs no new rule.

Say plainly what that costs, because it is the sharp edge. Once those rules
exist, a later run on a different tool makes that tool's safe commands runnable
unattended with no further approval. The review gate is the only thing in
between. Offer `Bash(fka-help:*)` alone as a first step for anyone who wants to
go slowly — the agent reads documentation and runs nothing.

Then offer the skill snippet for the project that will use the wrappers. Check
whether `binDir` is on `PATH` and say so if it is not — it is one directory
shared by every tool, so this comes up on the first run and never again:

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

| Argument      | Default         | Why you would change it                                                                                                                                            |
| ------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docsMode`    | `none`          | `web` lets the classifier read the tool's docs, which help text often does not cover. It also puts a network-capable session in front of pages you do not control. |
| `prefix`      | `fka`           | The first word of every alias. Change it only on a name collision.                                                                                                 |
| `maxDepth`    | `3`             | Deeper command trees.                                                                                                                                              |
| `maxCommands` | `400`           | Raise for a big tool, or scope with `include` instead.                                                                                                             |
| `envScrub`    | eight variables | Extra variables every wrapper deletes before exec.                                                                                                                 |
| `model`       | inherit         | The classifier's spawned `claude -p` sessions. Empty inherits the caller's Claude Code default; set it to pin one — this is a cost decision, so name it out loud. |
| `listCommand` | none            | Enumerates the tool's full command list when the root help names only the common ones — `--input listCommand='help -a'` for git.                                  |

## What this cannot do

It controls the argument vector and nothing else. An allowlisted `git log` still
reads `~/.gitconfig`, and a `[diff] external =` hook there still runs. If the
threat model includes someone who can already write the user's dotfiles, say so
rather than implying this covers it.

It also does not make the classifier trustworthy. It makes its mistakes cheap:
they surface as a refused command or an edit at the review gate.
