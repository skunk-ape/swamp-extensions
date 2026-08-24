# @skunk-ape/fka

Formerly known as. Wrap a CLI in the permission tier it deserves.

Take a command-line tool your agent already has. Find out which of its commands
are safe to run without a person watching. Then generate a wrapper that enforces
the answer.

After a run there is no `gh` for the agent to call. There is `fka-safe-gh`,
`fka-write-gh`, and whatever else the plan for gh called for. A permission rule
can match a command name cheaply and exactly. A name is the only part of a shell
command that it can match at all.

## The problem

Claude Code grants Bash permission by prefix match. For a tool with a real
command tree, both available answers are bad:

```jsonc
"allow": ["Bash(gh:*)"]                                    // includes gh repo delete
"allow": ["Bash(gh pr list:*)", "Bash(gh pr view:*)", …]   // never ends, goes stale
```

The first is too wide to be safe. The second is safe but unusable, and it is
still only a prefix match. **A prefix rule cannot see options, and options are
where the danger is.** `gh api` sounds read-only and will send any HTTP verb you
ask for. `sort` writes files with `-o`. `git log` runs a program of your choice
through `--ext-diff`.

So a generated wrapper is not a namespace. It is a parser. It reads the whole
argument vector again and refuses anything the table does not name. The
namespace makes the permission rule short. The parser makes it true.

## The four tiers

| Tier           | What it means                                                   | Rule            |
| -------------- | --------------------------------------------------------------- | --------------- |
| `read-safe`    | Changes nothing, shows nothing confidential.                    | `allow`         |
| `read-private` | Changes nothing, but reads secrets, private source, or billing. | `ask`           |
| `modify`       | Changes state: local files, remote resources, money.            | `ask`           |
| `escape`       | Gives away arbitrary code execution.                            | `ask` or `deny` |

Options get their own tier, apart from their command. This is what lets
`git log` stay in `read-safe` while `git log --ext-diff` does not. Without it,
one dangerous option in forty pushes the whole command out of the safe wrapper.

`read-safe` is the only tier that runs unattended. That one fact drives the rest
of the design.

## Aliases, not just tiers

The move is to lift a fact out of the argument vector and into a command name. A
permission rule matches a name cheaply and exactly, and it cannot see arguments
at all. Tiers are one use of it. Pinning a subcommand is another. Pinning
`--help` is a third.

An alias is named `fka-<segment>-<tool>`, and the segment comes from a closed
set: `help`, `safe`, `private`, `write`, `escape`. Which aliases a tool gets is
judgement about that tool, proposed by the classifier and settled by whoever
edits the review file.

```yaml
wrappers:
  - segment: help
    name: git
    append: ["--help"] # the alias adds it, not the caller
    accepts: path-only # a command path and nothing else
  - segment: safe
    name: git
    admits: { maxTier: read-safe }
```

### Four rules, forever

The prefix is shared across every tool, so permission rules key on the segment
rather than the tool:

```jsonc
"allow": ["Bash(fka-help:*)", "Bash(fka-safe:*)"]
"ask":   ["Bash(fka-private:*)", "Bash(fka-write:*)"]
```

Wrap another CLI tomorrow and that file does not change. The corollary is the
sharp edge, and it is deliberate: once those rules exist, a new run makes a new
tool's safe commands runnable unattended. The review gate is what stands in
between.

`Bash(fka-help:*)` on its own is the narrowest useful grant. The agent reads any
command's documentation and runs none of them. It is a reasonable place to
start.

### Help pins the flag

```bash
fka-help-git commit           # runs: git commit --help
fka-help-git commit -m pwned  # refused: this alias carries no -m
```

The alias builds the vector, so no token the caller writes decides whether help
happens. That is a stronger guarantee than allowing the flag and checking for
it. It also means help reaches every command, including ones no other alias will
run, because reading what `git commit` does is not committing.

## The stages

```
discover ──► classify ──► [a person edits review.yaml] ──► generate ──► verify
```

**`discover`** reads `<cli> --help` again and again and records the command
tree. It is deterministic. It runs the tool only with its help flag, and through
argv and not a shell. A depth cap, a command cap, and a timeout for each call
bound the crawl. It also records the arity of each option. If an arity is wrong,
it is the field most likely to cause a bypass. An option whose arity the help
text does not state is left out of the table.

**`classify`** asks a language model for a tier for each command, an option
allowlist, and a list of environment variables to delete. Two things keep this
honest. Its output is checked against the crawl, so it can move a command to
another tier but cannot invent one. And its output is a proposal that grants
nothing.

**The person** reads `review.yaml` and edits it. Two blocks want real attention.
Read `read-safe` with care: every other tier still stops at a prompt, so a
mistake there costs one keystroke, while a mistake in `read-safe` runs with
nobody watching. Then read `wrappers`, which is short and is not a tier —
`prepend` and `append` pin tokens into every call an alias makes, so a pinned
option is permitted at every command that alias admits. Deleting a line is
always the safe edit, because anything absent is refused.

Then set `approved: true` at the top of the file. `classify` always writes it
false and cannot write anything else, so that one line is what separates a
model's suggestion from a person's decision.

**`generate`** refuses to render anything while `approved` is false. It also
re-checks the edited table against what `discover` saw, because the file it
reads is never the file that was checked — a human edit sits in between, and an
edit can name a command the tool no longer has just as a model session can.
Then it writes the wrappers, the permission snippet, and the skill snippet. One
method writes all three, because they are three views of one fact. Three
methods let them drift.

Two details about how it writes them. Each wrapper goes to a neighbouring temp
file and is renamed into place, so a wrapper invoked during a regeneration sees
the old policy or the new one, never a half-written script. And an alias you
delete from the review file is deleted from `bin/` — a wrapper left behind goes
on enforcing the policy it was rendered with, and the rule granting its segment
still matches its name. Removal is by exact ownership: the segment must be one
of the known set, the tool name must match yours rather than merely start with
it (`fka-safe-ghi` is not `gh`), and the file must carry the generator's marker,
so nothing you wrote yourself is ever deleted. Whatever went is recorded in the
`generated` resource.

**`verify`** proves that each wrapper permits its own tier and refuses
everything above it — and that it parses arguments the way the table says,
which is a separate question. The matrix covers `--`, attached values, short
clusters, positionals where the table permits none, an option-shaped value, and
a pattern-constrained option exercised with a value that cannot match it. Those
are the shapes where a parser can be wrong while every command still lands in
the right tier. Every wrapper honours `FKA_CHECK=1`: read the arguments, print
the verdict, stop. It never runs the wrapped tool, which is the only reason the
check is safe to run at all.

## Use it

Once, before the first run:

```bash
export PATH="$HOME/.config/fka/bin:$PATH"   # or $XDG_CONFIG_HOME/fka/bin
```

That is the whole setup, and it is the last time PATH comes up. Every wrapper
for every tool you ever wrap is written to that one directory, which is the same
bargain the permission rules make: one line now, nothing to add later.

```bash
swamp workflow run @skunk-ape/fka --input cli=gh
```

The run stops at the `review` step. That is the gate, not a failure. Edit the
review file, then:

```bash
swamp workflow approve @skunk-ape/fka review
swamp workflow resume @skunk-ape/fka
```

Scope a large tool to the part you use. Nobody reviews every operation in `aws`,
but `aws s3` and `aws ec2` is a review a person finishes:

```bash
swamp workflow run @skunk-ape/fka --input cli=aws --input include='["s3","ec2"]'
```

Then read the permission snippet and merge it into `.claude/settings.json`
yourself:

```bash
swamp data get fka-gh generated-gh --json | jq -r '.content.settingsSnippet'
```

## Where it lives

```
~/.config/fka/
  bin/            every wrapper for every tool — the one directory on PATH
    fka-help-gh  fka-safe-gh  fka-write-gh  fka-safe-git …
  gh/
    review.yaml   the judgement: what you approved for gh
    surface.json  what the crawl read out of gh --help
  git/
    review.yaml
    surface.json
```

Your home directory, not the repository you happened to be standing in. A
wrapper is invoked by bare name, so it lives in the machine's namespace: two
projects wrapping `gh` would each render an executable called `fka-safe-gh`, and
only one of them can be on PATH. The judgement is about a binary installed on
this machine, and `git log` is read-safe in every repository you own.

The split between `bin/` and `<cli>/` is worth knowing if you sync dotfiles.
`review.yaml` is the part worth keeping — it is what a person decided, and it
moves between machines. `bin/` is not: each wrapper embeds the absolute path of
the tool and of the Deno that runs it. Sync the review files, run `generate` on
the new machine, and you have your policy without carrying one machine's paths
onto another.

Set `workRoot` to put the workspaces somewhere else. A relative value is
resolved against the repository root, which is there for anyone who wants a
project-local workspace — but the alias names stay global either way, so it does
not give two projects two different policies for one tool.

## The tested parser is the parser that ships

Each wrapper is TypeScript on Deno, not shell, so the argument parser can have
unit tests. It is the security boundary, and an untested parser behind an
`allow` rule is worse than no rule.

A tested module and a separate shipped copy is the usual way a tested boundary
ships broken. So `_lib/validate.ts` has no imports, and `generate` pastes its
text into each wrapper without change. The code that runs on your machine is the
module the test suite exercises. Only the table differs.

## Why the segment comes before the tool

`gh-safe` reads better, and it does not work. Permission rules match by string
prefix, so `Bash(gh:*)` matches every command line that starts with `gh`, and
that includes `gh-safe pr list`. A rule on the raw tool cancels the rule for its
own safe wrapper.

Putting the segment first fixes that and buys something better. The only rules
that can reach each other by prefix are rules inside one segment: `fka-safe-gh`
can only ever be a prefix of another `fka-safe-*` alias. If the one match nobody
controls goes wrong, it reaches something already judged safe.

No rule denies the raw tool. Denying it is harsher than the default without
being safer: an unlisted command already prompts, so you keep the option of
approving one, and an absolute path never matched the bare name anyway.

## What this does not do

### It does not sandbox

A wrapper controls the argument vector and nothing else. An allowed `git log`
still reads `~/.gitconfig`, and a `[diff] external` hook there still runs. The
wrapper deletes the environment variables that supply that kind of hook, but it
cannot edit a config file without breaking the tool. If your threat model
includes someone who can already write your dotfiles, this is not the layer that
helps.

### It does not install what it writes

The permission snippet goes to a person, who merges it. The thing that proposes
a policy must not be able to put that policy into force.

### It does not make the classifier trustworthy

It makes the classifier's mistakes cheap. They show up as a refused command or
an edit at the review gate, not as an unattended `gh repo delete`.

### It does not help against a hostile CLI

`discover` runs the binary to read its help. If you do not trust a tool enough
to run `--help` on it, the problem is upstream of this model.

## Configuration

Set these in the model definition's `globalArguments`.

| Argument           | Default         | What it changes                                                                                                                                                                                                             |
| ------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workRoot`         | `~/.config/fka` | Where the workspaces and the shared `bin/` live. Honours `XDG_CONFIG_HOME`. An absolute path is used as given; a relative one is resolved against the repository root.                                                      |
| `docsMode`         | `none`          | `web` lets the classifier read the tool's docs. Help text often does not say whether an operation is billable or reaches a private resource. The cost is a session with network access that reads pages you do not control. |
| `model`            | `""` (inherit)  | Model the classifier's spawned `claude -p` sessions run on. Empty inherits the caller's Claude Code default — the child receives the caller's environment and saved model, and no `--model` flag is passed. Set it to pin one, e.g. `claude-sonnet-5`. |
| `prefix`           | `fka`           | The first segment of every alias name, and so the word every permission rule keys on. Change it and the rules change with it.                                                                                               |
| `helpFlag`         | `--help`        | How the tool is asked for help.                                                                                                                                                                                             |
| `fallbackHelpFlag` | `-h`            | Used only when the help flag opens a man page, which no help-text parser can read correctly.                                                                                                                                |
| `listCommand`      | `""`            | An argv suffix, whitespace-split, that enumerates the tool's full command list. A root help sometimes names only the common commands — `git --help` lists 25 of ~200, but `git help -a` lists them all. Empty crawls what the root help lists. |
| `maxDepth`         | `3`             | How deep to descend.                                                                                                                                                                                                        |
| `maxCommands`      | `400`           | Ceiling on help calls. Prefer `include` over raising this.                                                                                                                                                                  |
| `envScrub`         | 8 names         | Variables every wrapper deletes, added to the ones the classifier finds.                                                                                                                                                    |
| `denoPath`         | automatic       | The Deno runtime the wrappers run under. It is written into each wrapper.                                                                                                                                                   |
| `spawnSamples`     | `6`             | How many cases per wrapper `verify` re-checks by running the real script.                                                                                                                                                   |

## After the tool is upgraded

New subcommands are absent from the table, so every wrapper refuses them. That
is the intended failure. `verify` records the tool's version and reports the
drift, so the failure is legible:

```bash
swamp model method run fka-gh verify --input cli=gh
```

Run the workflow again to pick up the new commands. The review gate runs again
too, which is correct: nobody reviewed those commands yet.

## When you stop wrapping a tool

```bash
swamp model method run fka-gh remove --input cli=gh
```

Takes every `gh` wrapper off `PATH` and leaves the workspace alone, so the
review file — the record of what you approved, and the thing `generate` builds
from — survives. Rewrapping later is a `generate`, not a second review.

Add `--input purge=true` to delete the workspace as well. That is the
unrecoverable half: `classify` would write a fresh proposal, not the judgement
somebody made about the last one. Hence the asymmetry — the reversible part
happens on request, the rest has to be asked for.

Removal is by exact ownership, because `bin/` is a directory on your `PATH`
holding every tool's wrappers: the segment must be one of the known set, the
tool name must match rather than merely start the same (`fka-safe-ghi` is not
`gh`), and the file must carry the generator's marker. Nothing you wrote
yourself is ever deleted.

Your permission rules need no edit. They name segments, not tools, so
`Bash(fka-safe:*)` goes on being correct for everything still wrapped and
grants nothing for a tool with no wrappers left.

## Prerequisites

- swamp initialized in the repository (`swamp repo init`)
- the CLI you want to wrap, on `PATH`
- Claude Code on `PATH`, for `classify` only

## License

MIT. See [LICENSE](LICENSE).
