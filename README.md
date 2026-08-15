# @skunk-ape/stef

Simple Technical English Flavored — a deterministic prose linter, a mechanical
fixer, and two ways to drive a rewrite loop against them.

The design is a split rather than a pipeline. A linter decides the eleven
mechanical ASD-STE100 rules a script can decide, and it is the oracle: nothing
grades its own work, so the rework loop has a real exit condition. A model
handles only the rules no script can judge.

## Install

```bash
swamp extension pull @skunk-ape/stef
swamp model create @skunk-ape/stef ste
```

`lint` and `normalize` need nothing else. `rewrite` needs Claude Code on
`PATH`. It runs on whatever credential Claude Code already holds. A
subscription token from `claude setup-token` works, so no API key is stored in
a vault.

## Methods

| Method | Needs a model | What it does |
| --- | --- | --- |
| `lint` | no | Run the eleven checks, emit `kind: findings` |
| `normalize` | no | Apply the fixes a script can make, then re-lint |
| `rewrite` | yes | Run the whole loop in one command |
| `start` / `record` | no | Hold state and gate while a calling agent writes |

## Lint a draft

```bash
swamp model method run ste lint --input path=DRAFT.md
swamp data get ste findings-latest --json |
  jq -r '.content.findings[] | select(.category != "recon") | .description'
```

Pass `--input text=` for a snippet, or `--input textType=procedural` to drop the
sentence limit from 25 words to 20.

## Fix what a script can fix

Three checks have deterministic repairs: emphasis punctuation, Latin
abbreviations, and unambiguous contractions. On a sample `CLAUDE.md` that
cleared 21 of 35 findings with no model call.

```bash
swamp model method run ste normalize --input path=DRAFT.md
swamp data get ste normalized-latest --json | jq -r '.content.text'
```

`rewrite` and `start` both apply this first. Set `normalizeFirst: false` in
`globalArguments` to turn it off.

## Rewrite in one command

```bash
swamp model method run ste rewrite --input path=DRAFT.md
swamp data get ste rewrite-latest --json |
  jq -r '.content | "attempts=\(.attempts) clean=\(.clean)"'
```

The result is data, not a file write, so you diff it before it lands.

## Rewrite with a calling agent

Referee mode splits the work: the agent writes and the model gates. When the
draft is already in the agent's context, use this mode.

```bash
swamp model method run ste start --input path=DRAFT.md
swamp data get ste session-default --json | jq -r '.content.nextAction'
swamp model method run ste record --input text="<the rewrite>"
```

`record` re-lints, counts the attempt against the cap, and refuses once the
session is clean or exhausted. The bundled `simple-english` skill drives this
loop and carries the rules the linter cannot check.

## The checks

| Check | Rule |
| --- | --- |
| long-sentence | 25 words descriptive, 20 procedural |
| contraction | spell it out |
| banned-modal | no `should`, `would`, `may`, `might`, `could` |
| perfect-tense | `has shipped` becomes `shipped` |
| ing-clause | a trailing `, ensuring X` becomes a new sentence |
| semicolon | write two sentences |
| latin-abbrev | `e.g.` becomes `for example` |
| slop-word | cut filler such as `leverage` or `robust` |
| trailing-condition | put the `if` or `when` clause first |
| synonym-rotation | one term per idea |
| emphasis | no bold or italics, except a short leading term |

The linter removes code blocks, inline code, headings, tables, URLs,
blockquotes, shell-prompt lines, and YAML frontmatter before any check runs. A
command or a quoted log line is never rewritten.

## Configuration

The style guide is data. Per-check severities, the blocking severity list, the
sentence limit, the guidance block given to the model, and wrong/right
anti-pattern examples all live in `globalArguments`. A writer tunes the style
without republishing.

```yaml
globalArguments:
  textType: descriptive
  maxAttempts: 3
  severities:
    emphasis: low
```

## Interoperability

Findings use the `kind: findings` contract that `@swamp/software-factory`'s
`findings-clear` gate consumes, so a scripted rule and a judgement-based
reviewer merge behind one gate.

## Attribution

The linter is a TypeScript port of the MIT-licensed `simple_english_lint.py` by
AminBlg. See `LICENSE`.
