# fka — design record

Take a CLI the agent already has, work out which of its commands are safe to run
unattended, and generate a wrapper that enforces that answer.

**f**ormerly **k**nown **a**s. The name is the mechanism: after a run there is
no `gh` for the agent to call, only `safe-gh`, `private-gh`, and `write-gh`. The
tier moves out of the argument list and into the command name, which is the one
part of a shell command a permission rule can match cheaply and exactly.

> **Amended during implementation.** The wrappers were first named `gh-safe`,
> which reads better and does not work. See "Why the tier leads the name".

## The problem this solves

Claude Code grants Bash permission by prefix match. For a CLI with a real
command tree, both available answers are bad:

```jsonc
"allow": ["Bash(gh:*)"]      // every gh command, including `gh repo delete`
"allow": ["Bash(gh pr list:*)", "Bash(gh pr view:*)", …]   // enumerate forever
```

The first is too coarse to be safe. The second is safe and unusable: the list is
long, it goes stale on every CLI upgrade, and it is still only a _prefix_ match
— `Bash(gh pr list:*)` happily matches `gh pr list --template '{{…}}'`, and
`Bash(gh api:*)` matches `gh api -X DELETE /repos/o/r`.

That last point is the one that matters, and it is why this is not a naming
exercise. **A prefix rule cannot see options, and options are where the danger
is.** `gh api` is a read-only-sounding subcommand that will issue any HTTP verb
you ask it for. `sort` writes files with `-o`. `find` executes with `-exec`.
`git log` runs arbitrary code through `--ext-diff`. A permission system matching
on the first two words of the command line is blind to all of it.

So the generated wrapper is not a namespace. It is a parser that re-reads the
whole argument vector and refuses anything not explicitly permitted. The
namespace is what makes the _permission rule_ short; the parser is what makes it
_true_.

## Four tiers

| Tier           | Meaning                                                                   | Rule            |
| -------------- | ------------------------------------------------------------------------- | --------------- |
| `read-safe`    | Changes nothing, reveals nothing confidential.                            | `allow`         |
| `read-private` | Changes nothing, but reads secrets, private source, identity, or billing. | `ask`           |
| `modify`       | Changes state — local files, remote resources, money.                     | `ask`           |
| `escape`       | Hands over arbitrary code execution.                                      | `ask` or `deny` |

`escape` exists because `modify` was flattening two different things. Closing a
pull request changes one remote object and you can see what it did. Setting
`core.pager` to `sh -c …` changes one local file and the machine is now the
attacker's — the payload fires later, from inside an innocent `git log`, with no
prompt attached, because `git log` is in the `read-safe` tier.

Anything that names a program to run (`--exec`, `--pager`, `--editor`,
`--filter`), names an endpoint to talk to (`--endpoint-url`, `--server`,
`--hostname`), or edits the config that supplies those later, is `escape`. It
gets its own wrapper only if the operator asks for one, and it is the tier where
`deny` is a reasonable default.

`read-safe` is the only tier that runs unattended. That fact drives the whole
review design below.

### Options are tiered apart from their commands

A tier on the command alone is not enough, and the gap is not an edge case.
`git log` is exactly the command an agent should be able to run unattended, and
`git log --ext-diff` runs a program of the caller's choosing. Tiering only whole
commands forces a choice between losing `git log` from the safe wrapper and
admitting `--ext-diff` with it.

So every option carries its own optional tier, defaulting to its command's. The
policy for a wrapper is built by filtering twice — commands, then each surviving
command's options — and `git log` reaches `safe-git` with forty options and
without that one.

### Help is not a tier

Asking a tool to describe itself is the one thing an agent does constantly that
cannot change anything, and the first version of the tier model refused it. A
help flag was classified like any other option, so nothing guaranteed it landed
in `read-safe`; `safe-gh --help` failed outright because no rule existed for the
bare root path; and `safe-gh pr close --help` failed because `gh pr close` sits
above the tier — even though reading its help does nothing at all.

That last one is the case agents hit hourly, and the cost of getting it wrong is
not a refusal. It is an agent that escalates a tier, or guesses at arguments, to
find out what a command takes.

So help is orthogonal to the tier ladder. `helpOptions` in the review file lists
the tool's own spellings, and every command in the table — including the ones a
wrapper will not run — carries a **help-only rule** at `helpTier`: the help
flags permitted, no positionals, no other options, and `requireOneOf` so the
rule does not match at all without one of them.

That last condition is the load-bearing half. Without it the same rule would let
bare `safe-git commit` through, and `git commit` with no arguments opens an
editor and waits. Requiring the flag also means the only argument vector that
ever reaches the tool is `commit --help`, so the residual risk — a tool that
does not short-circuit on its help flag — has nothing to act on.

The spellings come from the crawl, never from the classifier, and from two
sources. Options named `--help` in a table, and **the flag the crawl actually
ran and got an answer from**. The second exists because the first does not cover
`git`: git mentions `[-h | --help]` only inside its usage line, so reading
option tables alone finds git no help flag at all. A bare `-h` is never assumed
to mean help — `sort -h` and `du -h` mean human-readable — unless the crawl
itself used it successfully.

## Why the tier leads the name

`gh-safe` is the better-reading name and it cannot be made to work.

Claude Code matches a Bash rule by string prefix, so `Bash(gh:*)` matches every
command line beginning with `gh` — `gh-safe pr list` included. The settings
snippet wants to deny the raw tool and allow the safe wrapper, and under a
suffix scheme the deny rule swallows its own exception. Deny wins, so the safe
wrapper would be dead on arrival, silently.

Leading with the tier fixes that and buys a second property worth more than the
first. The only rules that can bleed into one another by prefix are now rules
_within_ a tier: `safe-gh` can only ever be a prefix of another `safe-*`
wrapper, never of `write-ghi`. Over-matching on the one rule nobody controls
reaches something already judged safe. A test asserts no deny rule the generator
emits is a prefix of an allow rule it emits.

## Shape

```
discover ──► classify ──► [human edits review.yaml] ──► generate ──► verify
  help          model                  ▲                  wrappers    self-test
  crawl        session                 │                  settings
                                  the gate                 skill
```

Five stages, four of them model methods and one of them a person. The workflow
chains them; `manual_approval` is the human stage.

### discover — deterministic

Recursively run `<cli> --help`, `<cli> <sub> --help`, and parse the output. This
is the only stage that gets ground truth, so it is the only stage allowed to
decide _what the command names actually are_. It never runs a command without a
help flag, caps depth and total invocations, spawns through argv rather than a
shell, and applies a per-call timeout.

It extracts, per command: the subcommand list, the option spellings, and —
critically — **each option's arity**. Arity is not decoration. If the wrapper
believes `--limit` takes a value and the real CLI does not, the wrapper consumes
the next token as a value and never checks it, while the CLI reads it as another
option. That is a bypass. So arity is taken from help text where the text states
it, and an option whose arity cannot be determined is _not allowlisted at all_.

**A man page is refused, not parsed.** `git log --help` runs `man git-log`, and
roff read by a help-text parser does not fail loudly — it yields a table full of
plausible, wrong arities, which is the bypass above arriving with a straight
face. So the crawl recognises a man page by its running header and flush-left
section names, and asks again with `-h`. That retry is narrow by construction:
it only ever fires for a tool that has already shown it routes `--help` to
`man`. If the second answer is also roff, the node is marked unusable with a
message naming the knob to set, and nothing about it enters the table.

**Framework-specific spellings are worth handling one at a time.** Recognising
git's `--[no-]decorate` as the pair it stands for took four lines and doubled
the options recovered from `git log`. Every one of these is a judgement about a
real format, not a generic rule, which is why the parser stays heuristic and
conservative rather than pretending to be a grammar.

### classify — judgment, structured, and untrusted

A model session reads the discovered surface and proposes a tier per command,
plus a per-command option allowlist and an environment scrub list. It may fetch
the tool's documentation, because help text alone often does not say whether an
operation is billable or whether a subcommand reaches a private resource.

Two properties keep this honest:

- **Its output is a proposal, not a policy.** It cannot grant anything. The
  approved table is whatever the human signs off on in the next stage.
- **It cannot install what it writes.** This model writes wrapper scripts and a
  settings _snippet_; it never edits `settings.json`. The thing that generates a
  permission policy must not be able to put that policy into force. That is a
  deliberate boundary, not an oversight — see "What this does not do".

The classifier reads attacker-influenceable text (fetched docs, and help output
from a binary you did not write) and holds a network capability while doing it,
which is exactly the arrangement `@skunk-ape/web-brief` argues against. The
mitigating differences are that its output is a constrained table rather than
prose, that the table is reviewed by a person before it means anything, and that
the material it could exfiltrate is a public tool's help text.
`docsMode: "none"` turns the capability off for operators who would rather
classify blind.

### the human gate — and why it stays tractable

`classify` writes `review.yaml`, the human edits it, `manual_approval` releases
the workflow, and `generate` reads back **the edited file**, not the
classifier's original proposal.

The obvious objection is scale: `aws --help` is hundreds of services and
thousands of operations, and nobody reviews that. The resolution is that **only
the `read-safe` list needs careful reading.** Every other tier still stops at a
human at run time; a mistake there costs a prompt. A mistake in `read-safe` is a
command that runs with nobody watching. So `review.yaml` puts `read-safe` first,
annotated, and lets the rest be skimmed — and `subtrees` lets you scope a run to
`gh pr` and `gh issue` instead of all of `gh`.

Fail-closed does the rest: anything the classifier was unsure of is not
`read-safe`, and anything absent from the table is refused.

### generate — one render, three artifacts

Wrapper scripts, the settings snippet, and the skill snippet come out of one
method, from one approved table. They are not three methods, because they are
three views of a single fact and splitting them is how they drift: a permission
rule naming a wrapper that no longer exists, or a skill telling the agent to use
a tier that was removed.

The wrapper is TypeScript on Deno, chosen over shell so the argv parser can be
unit-tested — it is the security boundary, and an untested parser guarding an
`allow` rule is worse than no rule. But the tested module and the shipped script
must not be two different pieces of code, which is the classic way a tested
boundary ships broken. So `_lib/validate.ts` has no imports, and `generate`
reads that exact file — shipped as a manifest asset and located with
`ctx.extensionFile`, never a second copy kept in sync — and pastes its text
verbatim into each wrapper alongside the approved table. The code that runs in
the wrapper is the code the suite exercised; only the data differs per CLI.

**Launching it is where the elegance stops.** `#!/usr/bin/env -S deno run …` is
the obvious way to run a TypeScript file as a command, and the first real tool
broke it: a shebang line is capped at 127 bytes on Linux, and the flags plus a
nix store path for git came to 957. Over the cap the kernel drops the shebang
and `/bin/sh` gets the file, so the wrapper does not refuse the command — it
emits a page of shell syntax errors and exits 2. A wrapper that fails to start
is not a safe wrapper, so the launcher moved to line two:

```sh
#!/bin/sh
":" //; exec '/path/to/deno' 'run' … "$0" "$@"
```

`sh` reads line 2 as the null command with an argument, then `exec`s. TypeScript
reads it as a string literal followed by a comment, and Deno strips line 1 the
way it strips any shebang. The cap applies to the shebang, not the file.

`--allow-run` names the one absolute binary, which is a real boundary.
`--allow-env` is deliberately not narrowed to a name list: the child inherits
the whole environment either way, so restricting the wrapper's own reads
protects nothing while costing the 957-byte line above.

### verify — proof, without running anything

Every wrapper honours `FKA_CHECK=1`: validate the argument vector, print the
verdict, exit, and **never exec**. `verify` uses it to assert that every command
in a tier passes its own wrapper, that no command passes a wrapper below its
tier, and that `escape` commands pass nothing. The self-test never executes a
single wrapped command, which is the only reason it is safe to run at all.

The matrix runs twice, and the two runs answer different questions. In process,
against the policies derived from the approved table, it asks whether the
_table_ is coherent — complete, because it is cheap. Spawned against the files
on disk, it asks whether the _scripts_ agree: that the launcher resolves, that
the policy survived being written out, that the pasted validator behaves like
the module under test. That run is sampled, because it costs a process each and
it is checking wiring rather than logic.

Splitting it that way is not bookkeeping. On the first end-to-end run the
in-process sweep passed all 79 cases while all 15 spawned checks failed, which
is exactly the shape of a rendering bug — and it was: `Deno.execPath()` inside a
swamp model returns the swamp binary, not Deno, so every launcher named the
wrong runtime. A single-run design would have reported success.

## Details that are load-bearing

**The binary path is resolved at generate time and embedded absolute.** A
wrapper that runs `gh` off `PATH` can be aimed at `./gh` by the agent it is
restraining.

**A consumed option value that looks like an option is refused.** If `--limit`
consumes `--ext-diff`, that is either a mis-modelled arity or a deliberate
smuggle, and both should fail.

**`--` is honoured.** Everything after it is positional: never an option, never
a subcommand. `git log -- --ext-diff` asks about a file with a strange name.

**Positionals are denied unless the rule permits them**, optionally by pattern.
This is where `gh api <endpoint>` hides — the subcommand is harmless and the
whole risk is in the argument.

**Short-option bundles are parsed properly** (`-abc` is three flags, unless `-a`
takes a value and `bc` is it) or refused. Guessing here is a bypass.

**CLI upgrades fail closed.** New subcommands are absent from the table and get
refused. `verify` records the tool's version string and reports drift, so the
failure is legible instead of mysterious.

## What this does not do

It does not sandbox. An allowlisted `git log` still reads `~/.gitconfig`, and
`[diff] external = …` there still runs. The wrapper scrubs the environment
variables that supply that kind of hook, but it cannot scrub a config file
without breaking the tool. **A wrapper is a control on the argument vector and
nothing else.** If the threat model includes an attacker who can already write
your dotfiles, this is not the layer that helps.

It does not install its own output. The permission snippet is handed to the
driving agent, which proposes it to a person. Nothing here writes
`settings.json`.

It does not make the classifier trustworthy. It makes the classifier's mistakes
cheap: they surface as a refused command or a review-stage edit, not as an
unattended `gh repo delete`.

And it does not help against a hostile CLI. `discover` runs the binary to read
its help. If you do not trust the tool enough to run `--help` on it, the problem
is upstream of this model.

## One grant covers every method

Swamp grants are model-scoped with no method dimension, so `run` on this model
is `run` on all of it. This model executes a binary you name and writes
executable files to disk. That is a developer tool driven by a human-in-the-loop
workflow, not something to hand an unattended agent — and unlike
`@skunk-ape/web-brief`, which was built to be granted, this one is not. Keep the
grant on the person running the analysis.
