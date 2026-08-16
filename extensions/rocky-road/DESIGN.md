# Rocky Road

**Status:** design draft. `factory.yaml` is written but not yet validated.

Chunks, and a bumpy path — the work is broken into chunks, and the route through
them is expected to change under you.

A `@swamp/software-factory` stage graph that replaces "produce a plan, approve
it, implement it in one go" with "break the work into small sub-tickets, execute
them incrementally, and adapt the breakdown when it turns out to be wrong."

Built **on** `@swamp/software-factory`, borrowing details from
`@swamp/issue-lifecycle`. Not a change to either.

## Why the engine choice matters

`@swamp/software-factory` is a generic state machine whose stages, gates, and
artifacts live in `globalArguments` as data. Nearly everything this idea needs is
already a primitive:

| Need                                       | Engine primitive                                        |
| ------------------------------------------ | ------------------------------------------------------- |
| Breakdown is reviewable                    | `kind: findings` artifact with `reviews: breakdown`     |
| Human approves the breakdown               | `human-approval` gate, cycle-scoped                     |
| Adding a sub-ticket forces re-review        | `artifact-fresh` + the `reviews:` subject-version pin   |
| Adaptation is a real, recorded act         | Loop-back transition; re-entry increments the cycle     |
| "All chunks done" is enforced, not asserted | `cel` gate over the progress artifact                   |
| History is inspectable                     | Versioned immutable artifacts + `summary`               |
| Runaway agent is bounded                   | `maxCycles` × `maxDispatchesPerCycle`                   |

So this extension ships **no model code**. It is a factory definition, a driving
skill, and one report.

## The central decision: chunks are artifact entries, not work items

The engine already has a concurrency unit — the work item. One factory instance
serves many, with all run data namespaced (`artifact-<workItem>-<name>`). The
obvious move is to make each sub-ticket a work item.

**Rejected**, for two reasons:

1. **Gates are per work item.** A `cel` gate sees `artifacts.*`, `evidence.*`,
   `approvals`, `state`, and `workItem` for *that* item only
   (`_lib/gates.ts:347`, `buildCelContext`). A parent could not gate on its
   children's states without a custom aggregating model — which is exactly the
   model code this design is trying not to write.
2. **A chunk is not a lifecycle.** Every work item walks the whole stage graph.
   A chunk that takes twenty minutes does not need triage, breakdown review,
   conformance review, and a PR of its own — that was the mistake in the
   earlier PR-per-ticket draft.

Instead: **one work item per issue**, with the chunk list carried in artifacts.

The important refinement is that it takes **two** artifacts, not one:

- **`breakdown`** — the chunk list. The plan of record. Changes only when the
  decomposition genuinely changes. Reviewed and human-approved.
- **`progress`** — per-chunk status. Changes constantly during execution.
  Reviewed by nobody.

Splitting them is what makes the review economics work. If chunk status lived in
the `breakdown` artifact, every completed chunk would bump its version, stale the
`reviews:` link, and drag the human back for another approval. With them split,
`breakdown` sits still while `progress` moves, and the human is pulled in
**only** when the decomposition itself changes.

If a chunk later turns out to warrant its own full lifecycle, nothing stops it
from being started as its own work item in the same factory. That stays
available; it is just not the default.

## Stage graph

```
triage ──> breakdown ──> breakdown-review ──> executing ──> conformance-review
              ^   ^______________|                |    ^__________|
              |         rework                    |
              |__________________________________ |
                          adapt

           executing ──> conformance-review ──> pull-request ──> done
```

The `adapt` edge from `executing` back to `breakdown` is the whole point. It is
an ordinary transition, and because re-entry increments the stage cycle and
`human-approval` is cycle-scoped, adapting the breakdown **automatically**
invalidates the previous sign-off and routes back through review. Nobody has to
remember to ask.

Full definition in `factory.yaml`.

## The human review surface

The question this design has to answer: how does a human see the initial
breakdown, watch it evolve, notice when sub-tickets are added, review those, and
add their own.

### See the initial breakdown — and approve it

`breakdown-review` is a normal review stage. The transition out of it carries a
`human-approval` gate, so execution cannot begin until a human runs:

```
swamp model method run chunked approve --input workItem=issue-42 \
  --input gateId=breakdown-approval
```

Before approving, the human reads the breakdown. Three ways, increasing detail:

```bash
# What is this work item waiting on right now, and which gates are unmet?
swamp model method run chunked status --input workItem=issue-42

# Just the chunk list, without pulling the whole envelope
swamp data query --select attributes.payload.chunks \
  --name artifact-issue-42-breakdown

# Everything, as markdown — statically rendered, no LLM
swamp model method run chunked summary --input workItem=issue-42
```

### Watch it evolve

Artifacts are versioned and immutable, so **every** breakdown revision is
retained. The version history is the evolution:

```bash
swamp data query --name artifact-issue-42-breakdown --all-versions
```

Diffing v1 against v2 shows exactly which chunks were added, split, or dropped.
The `origin` (`initial` / `split` / `added`), `parentChunk`, and `addedReason`
fields on each chunk make that readable without a diff — a chunk that was split
three times still names the chunk it came from.

`summary` renders the whole run history including every stage entry and cycle,
so "we went back to breakdown twice" is visible without querying anything.

### Review newly-added sub-tickets

This one is enforced rather than remembered, and it is worth being precise about
the mechanism:

1. The agent records a new `breakdown` version (adding a chunk).
2. The `breakdown-review` artifact declares `reviews: breakdown`, which pins the
   subject version it reviewed.
3. `artifact-fresh` now fails — the pinned version is no longer current.
4. `human-approval` is scoped to (stage, cycle), so the previous approval does
   not count for the new entry.

The result: **an added sub-ticket cannot reach execution without a fresh
adversarial review and a fresh human approval.** Not a convention in a skill —
a gate the engine evaluates in pre-flight checks and re-validates inside
`advance`.

### Add sub-tickets yourself

The human says what they want added; the agent records the new breakdown
version. Two ways to reject instead:

```bash
# Refuse the current breakdown outright — blocks the gate for this cycle
swamp model method run chunked reject --input workItem=issue-42 \
  --input gateId=breakdown-approval --input reason="missing the migration step"
```

A `reject` blocks the `human-approval` gate, which pushes the run back through
`rework` to `breakdown`. Editing the chunk list directly is deliberately not a
thing — every change goes through `record_artifact` so it is versioned,
schema-validated, and re-reviewed.

### The gap: there is no board

`status` is stage-level. `summary` is history-level. Neither renders *the chunk
list as a board* — "7 chunks: 3 done, 1 in progress, 2 blocked on c3, 1 added in
v2 and not yet started."

**This is the one thing that has to be built.** A swamp report
(`design/reports.md` in the swamp repo) scoped to this factory:

```
@skunk-ape/rocky-road/breakdown-board
```

It joins the latest `breakdown` and `progress` artifacts, resolves `dependsOn`
into ready/blocked, and renders a table plus a Mermaid graph of the chunk
dependency structure. Pure projection — no LLM, no model state touched. It is
the artifact a human actually looks at when asked "how is this going."

## What to borrow from `@swamp/issue-lifecycle`

Concrete, not conceptual:

| From issue-lifecycle                                          | Where it lands here                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ClassificationSchema` — bug/feature/platform/security, confidence, regression fields | the `classification` artifact schema in `triage`               |
| `PlanStepSchema` — `{order, description, files, risks}`        | the shape of a chunk, plus `dependsOn` / `origin` / `sizeEstimate`             |
| `StepVerificationSchema` — implemented / deviated / partially_implemented / missing / added | the conformance-review verdict vocabulary          |
| The `agent-constraints/` convention                            | `triage-conventions.md`, `decomposition-conventions.md`, `implementation-conventions.md` |
| The adversarial-review framing (attack it, don't soften)       | the `breakdown-review` system prompt, retargeted at seams rather than steps    |
| `PR_COOLDOWN_MS` (3 min for CI)                                | a `cooldown` gate if PR status checking is added later                         |

Not borrowed: the swamp-club API client, the phase enum, the notify/summarize
tail. Those are issue-lifecycle's own concerns.

## Roles

The model never names an actor. `record_artifact` and `advance` are transitions;
nothing knows whether the same agent or a different one called them. Both
arrangements run against identical definitions:

- **Single context** — one agent implements a chunk and checks its own work
  before recording progress. Cheapest, keeps context, matches how the existing
  flow works locally.
- **Role-specific agents** — `mode: dispatch` on the review stages already spawns
  one subagent per listed skill in parallel, with a clean context. That is the
  engine's native answer for reviewers.

Note that `breakdown-review` and `conformance-review` are already `dispatch`
stages, so reviews get fresh-context agents by default while implementation stays
interactive. That is probably the right split.

The standing caveat: on a laptop there is no identity on the CLI, so "a different
agent reviewed this" is a convention. `human-approval` records exist and are
cycle-scoped, but nothing proves who produced them. Enforcing that needs
`swamp serve` with scoped grants.

## Open questions

1. **Is `adapt` too heavy?** Every material adaptation costs a full re-review and
   re-approval. That is correct for "I discovered three more chunks of work" and
   probably wrong for "chunk 4 needs a slightly different file." Options: let
   trivial refinements ride in `progress.note` and reserve `adapt` for material
   change (current draft), or add a second lighter transition with only
   `findings-clear`. Needs a real run to tell.
2. **`maxCycles: 8` on `breakdown` and `executing`** is a guess. Too low and a
   legitimately messy issue gets parked for a cycle-override; too high and a
   thrashing agent burns budget. Wants calibration.
3. **Does `triage` belong here at all?** If issues arrive already triaged, the
   graph could start at `breakdown` and take classification as evidence.
4. **Should `conformance-review` review `progress` or `breakdown`?** Draft says
   `progress` (what was actually done). The counter-argument is that the
   approved breakdown is the contract, and reviewing against progress lets the
   agent grade its own homework.
5. **Chunk-level parallelism is unmodelled.** `dependsOn` is recorded but nothing
   enforces ordering — the executing stage is one interactive stage, so the
   skill decides what to run concurrently. A `cel` gate could enforce it, but
   only at stage boundaries, not per chunk. Probably fine; worth confirming.
6. **Where does this get published?** The repo has a root `manifest.yaml` for
   `@skunk-ape/stef`. A second extension needs either its own subdirectory
   manifest under `extensions/<kind>/` (per-subdirectory identity, see
   `design/extension.md` "Per-Subdirectory Extension Identity") or a separate
   repo. Unresolved — this directory is deliberately outside `extensions/models/`
   so it is not yet claimed by discovery.

## Next steps

1. `swamp model create @swamp/software-factory chunked`, paste `factory.yaml`
   under `globalArguments`, run `validate` until clean.
2. Run `describe` and check the Mermaid against the graph above.
3. Dry-run one real issue through `triage → breakdown → breakdown-review` and
   stop at the approval gate. That exercises the riskiest part — whether the
   `reviews:`/`artifact-fresh` pairing actually behaves as described when the
   breakdown changes.
4. Build the `breakdown-board` report.
5. Write the driving skill last, once the graph has survived a real run.
