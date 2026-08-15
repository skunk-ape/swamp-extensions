---
name: simple-english
description: >
  Rewrite drafts into Simple English (ASD-STE100 Simplified Technical English)
  using the @skunk-ape/stef model, which lints deterministically and gates the
  rework loop. Use when asked to lint, simplify, or rewrite prose. This covers
  docs, CLAUDE.md and agent instruction files, commit messages, tickets,
  release notes, and error messages. Also use to check a draft before you emit
  it. Triggers on
  "simple english", "simplify this", "plain language", "STE", "lint prose",
  "lint my writing", "rewrite in simple english", "check this draft", "stef".
  Also use to interpret findings the model already produced.
---

# Simple English

Rewrite prose so a tired reader who does not speak English as a first language
reads each sentence once and gets it right.

A deterministic linter decides eleven mechanical rules. You decide everything
else. The linter is the oracle: never declare a draft clean on your own
judgement, and never argue with a finding — fix it.

## Pick a mode

**Referee mode** — you do the writing, the model lints and gates. Use this by
default: you already have the draft in context, and no credential is involved.

**Tool-call mode** — one command runs the whole loop by spawning `claude -p`.
Use when the caller wants a single command, or for a file you do not want to
pull into context.

```
swamp model method run <model> rewrite --input path=DRAFT.md
swamp data get <model> rewrite-latest --json | jq -r '.content.text'
```

## Referee mode loop

Run these in order. Do not skip the lint step and do not hand-wave the result.

### Step 1 — Open a session

Use `--input text=` for a snippet or `--input path=` for a file. Every method
takes both. Add `--input session=<name>` to run several drafts at once — it
names the state slot, and defaults to `latest`.

```
swamp model method run <model> start --input path=DRAFT.md
```

### Step 2 — Read the packet

`nextAction` states exactly what to do next.

```
swamp data get <model> session-latest --json | jq -r '.content |
  "\(.phase) \(.attempt)/\(.maxAttempts)\n\(.nextAction)"'
```

### Step 3 — Rewrite

Fix every finding in `findings`, and apply the judgement rules below. Read the
findings with:

```
swamp data get <model> session-latest --json |
  jq -r '.content.findings[] | select(.category != "recon") | .description'
```

### Step 4 — Submit

The model re-lints your rewrite and advances the attempt count.

```
swamp model method run <model> record --input text="<your rewrite>"
# or, for a file you edited in place:
swamp model method run <model> record --input path=DRAFT.md
```

### Step 5 — Repeat

Repeat from step 2 while `phase` is `reworking`.

When `phase` is `clean`, stop. When `phase` is `exhausted`, stop and report what
still fails. Do not keep trying. By design, `record` refuses on a clean or
exhausted session. That refusal is the gate working, not an error to route
around.

## Delegate the rewrite

Step 3 does not have to run in your own context. Spawn a subagent to do the
rewrite and hand back only the result. Delegate in these cases:

- The draft is long enough that holding it and its findings crowds your context.
- You want to pin a model for the rewrite that differs from your own.
- You have several drafts open and want them rewritten at the same time.

For a short snippet, rewrite it yourself. A subagent costs a start-up round trip
that a two-sentence fix does not repay.

Give the subagent three things: the draft, the findings, and the rules from the
two sections below. Tell it to return only the rewritten text. Then call
`record` yourself. The gate belongs to you, not to the subagent. A subagent that
records its own work can walk past a refusal you needed to read.

**On model choice**. The linter is the oracle, so a weaker writer costs you
attempts, not correctness. That makes a cheaper model worth trying. One measured
run is a warning, though. On a 44-line file, Claude Sonnet 5 took longer per
attempt than Claude Opus 5 and it fixed less. It never found that `**Term**.`
beats `**Term.**`. Measure before you settle on a model.

## What the linter checks

Do not spend reasoning on these. Run the tool.

| Check              | Rule                                                           |
| ------------------ | -------------------------------------------------------------- |
| long-sentence      | 25 words descriptive, 20 procedural                            |
| contraction        | spell it out (`do not`, `it is`)                               |
| banned-modal       | no `should`/`would`/`may`/`might`/`could`; use `can` or `must` |
| perfect-tense      | `has shipped` becomes `shipped`                                |
| ing-clause         | a trailing `, ensuring X` becomes a new sentence               |
| semicolon          | write two sentences                                            |
| latin-abbrev       | `e.g.` becomes `for example`                                   |
| slop-word          | cut filler such as `leverage` or `robust`                      |
| trailing-condition | put the `if`/`when` clause first                               |
| synonym-rotation   | one term per idea                                              |
| emphasis           | no bold or italics, except a short leading definition term     |

## What you must reason about

The linter cannot judge these. They are yours.

- **Active voice**. Name the actor. "The worker retries the job", not "the job
  is retried". Use passive only for an unknown actor.
- **Verbs, not noun forms**. "Compress the file", not "perform compression of
  the file".
- **One word, one meaning**. Pick one of delete/remove/drop, one of
  run/execute/invoke, and hold it across the document.
- **Paragraph shape**. One topic per paragraph, about six sentences at most, one
  new fact per sentence.
- **Classify the passage**. A step is procedural: imperative, 20 words, one
  instruction per sentence. An explanation is descriptive: simple tense, 25
  words. Do not mix them in one passage. Pass `--input textType=procedural` for
  steps.
- **Order**. Main point first, then facts in the order the reader needs them.
- **Keep the grammar**. Short does not mean clipped. Keep articles and the word
  "that". This is the rule an agent breaks most under sentence-length pressure:

  > Terse: Ensure file exists before running.
  >
  > Full: Make sure that the file exists before you run the command.
- **Short noun clusters**. Three words maximum. Break a longer one with a
  preposition: "the connection pool timeout configuration value" becomes "the
  timeout value for the connection pool".
- **No phrasal verbs**. "Go down" becomes "decrease". "Set up" becomes "install"
  or "configure".
- **One part of speech**. "Check that X" becomes "make sure that X".
- **Safety first, in order**. For a destructive action lead with `WARNING`
  (injury) or `CAUTION` (damage). State the command or condition first, then the
  risk.
- **American spelling**.

## Hard constraints on every rewrite

- Keep every technical fact, number, identifier, command, flag, file path, and
  code span exactly as written.
- Never add information that is not in the source. Never drop information.
- Leave headings, tables, URLs, and blockquotes alone. The linter strips them
  before checking, so a rewrite that touches them is unchecked and unwanted.
- Return only the rewritten text. No preamble, no commentary, no code fences.

## State uncertainty in plain words

The ban on `may`, `might`, and `could` is not a ban on doubt. Name the doubt.

> Not this: this may evict the cache.
>
> Capability: this can evict the cache.
>
> Real doubt: I am not sure whether this evicts the cache.

## Do not lint human prose

The style covers text you write. It does not cover what a human wrote. Do not
lint, flag, or rewrite a human's message. Read their hedging as intent, not as a
defect to report:

> We should probably do X.

That is an instruction. Act on it.

## When a finding looks wrong

Two known false positives, both inherited from the reference linter:

- A bare dunder such as `__init__` reads as bold. Wrap it in backticks.
- A short bold rule label that ends in a period fires `emphasis`. That is the
  rule working as specified. To keep such labels, make the check non-blocking in
  the model definition rather than fighting it:

```yaml
globalArguments:
  severities:
    emphasis: low
```
