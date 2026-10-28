# Rocky Road

A chunked-implementation factory definition for `@swamp/software-factory`.
It replaces "produce a plan, approve it, implement it in one go" with "break
the work into small chunks, execute them a wave at a time, and adapt the
breakdown when it turns out to be wrong."

Ships no model code. The extension is a stage graph (`factory.yaml`), a board
report, a driving skill, and a set of agent-constraints conventions — the
machine is data, not code.

## Why

Monolithic plan-then-implement factories have two recurring problems this
design targets directly:

- **Review economics.** If chunk status lived in the same artifact as the
  plan, every finished chunk would bump the plan's version and drag a human
  back for another approval. Rocky Road splits the two: a `breakdown`
  artifact (the chunk list — reviewed, human-approved, changes rarely) and a
  `progress` artifact (per-chunk status — changes constantly, reviewed by
  nobody). The human is pulled in only when the decomposition itself changes,
  via an `adapt` edge back to `breakdown` that forces a fresh review and a
  fresh approval.
- **Review at the wrong grain.** Reviewing only at the end loses the point of
  chunking — a chunk is small enough to review while the reasoning is still
  fresh. Rocky Road reviews a **wave** (one chunk, or several with no
  dependency on each other) at a time, with `findings-clear` as the kickback:
  an unresolved critical or high finding leaves `rework` as the only way out.
  A per-chunk `reviewRounds` counter, not the coarser `maxCycles`, is the
  circuit breaker — a chunk stuck at its rework ceiling gets three named
  exits: `escalate`, `force_rework`, `adapt`.

See [DESIGN.md](./DESIGN.md) for the full design record, including what the
dry runs against the engine verified.

## Contents

- `factory.yaml` — the stage graph. Paste it under `globalArguments` on a
  `@swamp/software-factory` instance.
- `@skunk-ape/rocky-road/breakdown-board` — a report that joins the agreed
  breakdown with recorded progress and renders the chunk board: derived
  ready/blocked state, a Mermaid dependency graph, chunks added after the
  fact, and any chunk stalled at its rework ceiling.
- The `rocky-road` skill — the driving rules the graph itself cannot enforce:
  how to choose a wave, where `currentChunks` and `reviewRounds` come from,
  and what to put to the human when a chunk strands.
- `agent-constraints/` — triage, decomposition, and implementation
  conventions. Copy them into your own repository and edit them.

## Use

Pull the extension, create a factory instance, and paste the definition in:

```bash
swamp extension pull @skunk-ape/rocky-road
swamp behavior create @swamp/software-factory my-factory
swamp behavior edit my-factory     # paste factory.yaml under globalArguments
swamp behavior run my-factory validate
swamp behavior run my-factory start --input workItem=<ref>
```

Scope the board report in the definition so it fires on `status` and nowhere
else:

```yaml
reports:
  require:
    - { name: "@skunk-ape/rocky-road/breakdown-board", methods: [status] }
```

Once a run is underway, inspect the chunk board instead of the raw artifacts —
it derives ready/blocked state, shows the current wave, and calls out any
chunk that needs a human:

```bash
swamp behavior run my-factory status --input workItem=<ref>
```

Or pull the same board as its own report, for example as markdown:

```bash
swamp report get @skunk-ape/rocky-road/breakdown-board --model my-factory --markdown
```

## Driving a run

Approving the breakdown, adding chunks, and resolving a stranded chunk are all
covered in the `rocky-road` skill and in [DESIGN.md](./DESIGN.md#the-human-review-surface).
Short version:

- Approve the initial breakdown with `approve --input gateId=breakdown-approval`.
- Reject it with `reject` to send the run back through `rework` to `breakdown`.
- A chunk stuck at its rework ceiling can be `escalate`d, granted one more
  round with `force_rework`, or dropped with `adapt` — all three route back
  through `breakdown-review`, so nothing ships without a fresh look.

## Status

The definition validates, the gates are verified against the engine, and the
board report and driving skill ship with it. See [DESIGN.md](./DESIGN.md) for
what has and has not been run end to end yet.
