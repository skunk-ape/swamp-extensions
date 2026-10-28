# Rocky Road

**Status:** the definition validates (9 stages), the gates are verified
against the engine, and the board report and driving skill ship with it.
`rr-publish-ready` is now running through the factory as a real work item: the
breakdown was reviewed, kicked back twice on real findings, rewritten, and
human-approved on the third pass. The second kickback was DEC-3 — a chunk
description falsely claimed a colocated `_test.ts` file would be auto-packaged
and shipped, which swamp's own docs contradict. A four-chunk wave then executed
in parallel and cleared review with no blocking findings. Conformance-review,
pull-request, and the remaining chunks (the manifest version bump, the
adversarial quality review) are still ahead — this run is not finished.

Chunks, and a bumpy path — the work is broken into chunks, and the route through
them is expected to change under you.

A `@swamp/software-factory` stage graph that replaces "produce a plan, approve
it, implement it in one go" with "break the work into small chunks
(sub-tickets), execute them incrementally, and adapt the breakdown when it
turns out to be wrong."

Built on `@swamp/software-factory` as a factory definition (no model code). It
borrowing shape from `@swamp/issue-lifecycle`.

Here is how the design maps to the software-factory primitives:

| Need                                        | Engine primitive                                        |
| ------------------------------------------  | ------------------------------------------------------- |
| Breakdown is reviewable                     | `kind: findings` artifact with `reviews: breakdown`     |
| Human approves the breakdown                | `human-approval` gate, cycle-scoped                     |
| Adding a chunk forces re-review             | `artifact-fresh` + the `reviews:` subject-version pin   |
| Adaptation is a real, recorded act          | Loop-back transition; re-entry increments the cycle     |
| "All chunks done" is enforced, not asserted | `cel` gate over the progress artifact                   |
| History is inspectable                      | Versioned immutable artifacts + `summary`               |
| Runaway agent is bounded                    | `maxCycles` × `maxDispatchesPerCycle`                   |

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
only when the decomposition itself changes.

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
`human-approval` is cycle-scoped, adapting the breakdown automatically
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
swamp behavior run rocky-road approve --input workItem=issue-42 \
  --input gateId=breakdown-approval
```

Before approving, the human reads the breakdown. Three ways, increasing detail:

```bash
# What is this work item waiting on right now, and which gates are unmet?
swamp behavior run rocky-road status --input workItem=issue-42

# Just the chunk list, without pulling the whole envelope
swamp data query --select attributes.payload.chunks \
  --name artifact-issue-42-breakdown

# Everything, as markdown — statically rendered, no LLM
swamp behavior run rocky-road summary --input workItem=issue-42
```

### Watch it evolve

Artifacts are versioned and immutable, so every breakdown revision is
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

### Enforced review of newly-added chunks

**Verified in a dry run** (`workItem=dry-run-1`, 2026-08-16). Three independent
mechanisms stack, and the first is stronger than originally assumed:

1. **An artifact can only be recorded from the stage that declares it.**
   Attempting `record_artifact name=breakdown` from `breakdown-review` or
   `executing` is refused outright:

   ```
   Error: Artifact 'breakdown' is not declared on stage 'executing'.
          Declared: progress
   ```

   So a chunk cannot be added in place at all. The `adapt` edge back to
   `breakdown` is the only route, which makes re-review structural rather than
   something a gate has to catch after the fact.

2. **The subject-version pin stales the review.** `breakdown-review` declares
   `reviews: breakdown`, so `artifact-fresh` fails once the breakdown moves:

   ```
   'breakdown-review' reviews 'breakdown' v1 but the current version is v2
   — re-record 'breakdown-review' against the current version
   ```

3. **Cycle scope resets the approval.** Re-entering the stage increments its
   cycle, and a cycle-1 approval does not satisfy cycle 2:

   ```
   awaiting human approval 'breakdown-approval' (0/1) for stage
   'breakdown-review' cycle 2
   ```

An added chunk cannot reach execution without a fresh adversarial review and a
fresh human approval — enforced in pre-flight checks and re-validated inside
`advance`, not by convention in a skill.

### Add your own chunks

The human says what they want added; the agent records the new breakdown
version. Two ways to reject instead:

```bash
# Refuse the current breakdown outright — blocks the gate for this cycle
swamp behavior run rocky-road reject --input workItem=issue-42 \
  --input gateId=breakdown-approval --input reason="missing the migration step"
```

A `reject` blocks the `human-approval` gate, which pushes the run back through
`rework` to `breakdown`. Editing the chunk list directly is deliberately not a
thing — every change goes through `record_artifact` so it is versioned,
schema-validated, and re-reviewed.

### The board

`status` is stage-level. `summary` is history-level. Neither renders the chunk
list as a board, which is the question a human actually asks mid-run.

`@skunk-ape/rocky-road/breakdown-board` fills that in. It joins the agreed
`breakdown` with the recorded `progress`, resolves
`dependsOn` against what is finished, and renders a table, a Mermaid dependency
graph, and two conditional sections. Pure projection — no LLM, no model state
touched, so the same run data always renders the same board.

Scoped in the definition so it fires on `status` and nowhere else:

```yaml
reports:
  require:
    - { name: "@skunk-ape/rocky-road/breakdown-board", methods: [status] }
```

Sample output, from `dry-run-2` at the moment the circuit breaker tripped:

```
**2 chunks** — 1 in progress · 1 blocked

| | Chunk | State | Rounds | Depends on | Description |
| --- | --- | --- | --- | --- | --- |
| `>` | **c1** | in progress | **3** | — | Tokenizer |
| `.` | c2 | blocked | — | **c1** | Renderer |

## Needs a human
- **c1** has failed review 3 times — escalate to re-slice, force_rework to
  grant a round, or adapt to drop it.
```

Three things it does that the raw artifacts do not:

- **Derives state rather than echoing it.** The recorded status is only
  `pending`/`in_progress`/`done`/`dropped`. The board resolves `pending` into
  **ready** or **blocked** by checking each chunk's dependencies, and reports a
  chunk present in the breakdown but absent from progress as **not started**.
  Blocking dependencies are bolded, so the thing to fix next is visible without
  reading the graph.
- **Surfaces the stalled chunk without being asked.** Any chunk at
  `reviewRounds >= 3` gets a "Needs a human" section naming the three exits.
  The board is where a stranded run announces itself.
- **Names what was added after the fact.** Chunks with `origin` other than
  `initial` are marked in the table and listed with their `addedReason`, so
  scope growth is legible without diffing breakdown versions.
- **Shows the wave.** Chunk ids in `currentChunks` are bolded, so a reader
  sees which chunks the current review covers. The state column cannot say
  that: at review time every chunk in the wave reads `done`.

It stays silent — empty markdown, empty json — on any `@swamp/software-factory`
instance with no `breakdown` artifact, so it is safe to leave registered
alongside other factories.

## Per-chunk review and kickback

The graph as drafted has one `executing` stage and reviews only at the end. That
loses the main advantage of chunking: a chunk is small enough to review while
the reasoning behind it is still fresh, and cheap enough to redo.

The fix is a review stage in the chunk loop, with both exits returning to
`executing`:

```
executing --submit_chunk--> chunk-review --accept--> executing   (next wave)
                                         --rework--> executing   (same chunks)
```

```yaml
- id: chunk-review
  description: Review the wave just finished, not the whole change.
  work:
    mode: dispatch
    skills: [code-review]
    systemPrompt: |
      Review only the chunks named below, against their descriptions in the
      approved breakdown. Ignore unrelated changes.
      Wave: ${{ data.latest(self.name, "artifact-progress").payload.currentChunks }}
  artifacts:
    - name: chunk-review
      kind: findings
      reviews: progress
  transitions:
    - name: accept
      to: executing
      gates:
        - type: artifact-fresh
          config: { artifact: chunk-review, recordedThisCycle: true }
        - type: findings-clear
          config: { artifact: chunk-review, blocking: [critical, high] }
    - name: rework
      to: executing
```

Three things make this work:

- **`findings-clear` is the kickback.** An unresolved critical or high finding
  makes `accept` unsatisfiable, so `rework` is the only way out. The reviewer
  does not ask the implementer to redo the chunk; it records a finding, and the
  graph leaves no other route.
- **`reviews: progress` focuses each round.** Finishing a chunk bumps
  `progress`, which stales the previous `chunk-review` — so every chunk gets its
  own review rather than one review covering whatever has accumulated.
- **`currentChunks` on the progress payload** is what makes the review focused
  rather than whole-diff. The system prompt binds to it, so the subagent is
  told exactly which chunks to look at.

## Parallel chunks: the wave

The reason to chunk at all is partly that independent chunks can run at the
same time. The graph models that as a **wave** — the set of chunks under one
review. One chunk is the normal case. Several chunks form a wave when they do
not depend on each other, when everything they depend on is finished, and when
they touch disjoint files.

The first two conditions are `cel` gates on `submit_chunk`, so the engine
refuses a bad wave rather than trusting the driving agent:

```
DEPS_NOT_DONE    a chunk in the wave waits on work that is not done or dropped
INTRA_WAVE_DEP   one chunk in the wave depends on another chunk in the wave
```

That also closes the older worry that `dependsOn` was recorded but never
enforced. Ordering is now checked at every submission, not left to the skill.

The third condition — disjoint files — stays a convention, in
`decomposition-conventions.md` and in the `chunk-review` prompt. A gate cannot
see the diff, and comparing declared `files` lists would enforce a promise
rather than a fact. The review is the enforcement: the reviewer is told the
chunks ran in parallel and asked whether one touched another's files, or
assumed behaviour another introduced.

`reviewRounds` stays per chunk while the breaker is checked across the wave.
One chunk that keeps failing strands the wave. A wide healthy wave never trips
it. On rework the wave shrinks to the chunks that actually failed, so a
five-chunk wave with one bad chunk becomes a one-chunk wave, and the passing
work stays `done`.

**Verified against the engine** (throwaway factory, 2026-08-16). A wave of two
independent finished chunks advanced. A wave whose dependency was still
`in_progress` failed with `DEPS_NOT_DONE`. A wave holding both a chunk and its
dependent failed with `INTRA_WAVE_DEP`. The breaker allowed a wave at two
rounds and refused the same wave at three.

That last test found a real defect in the first draft of the breaker.
`c.reviewRounds < 3` aborts CEL evaluation with `No such key: reviewRounds`
when the field is absent, which is exactly the state of a chunk on its first
rework. The gate then failed for the wrong reason, with a message about
missing keys rather than the authored one. The expression now reads
`!has(c.reviewRounds) || c.reviewRounds < 3`, so an absent count means zero
rounds. Worth remembering as a general rule for `cel` gates over optional
payload fields: reach for `has()` before every optional field, because the
failure is an evaluation error rather than a false.

No human is involved in this loop. `chunk-review` carries no `human-approval`
gate, so execution stays agent-autonomous — consistent with the human being
pulled in only when the decomposition itself changes.

## The cycle budget, and why `maxCycles` is the wrong guard here

`maxCycles` exists to stop non-convergence: review kicks back, the fix does not
land, review kicks back again, forever. Unbounded, that burns money quietly.
The engine's enforcement is `entries < limit + overrides`, and each human
override grants exactly **one** more entry — so hitting the limit parks the run
and makes a human the reset.

Chunking breaks the measurement. `maxCycles` counts **entries into a stage, per
work item**. With a single monolithic implement stage, "entered 8 times" means
"reworked this change 8 times" — a real smell. Once work is chunked,
`executing` is entered once per chunk *when everything is going well*. Seven
chunks, no problems, seven entries. The counter now conflates:

- **progress** — moving to the next chunk (healthy)
- **thrash** — the same chunk bouncing (unhealthy)

Raising the limit does not fix this, it switches the breaker off: one chunk
could bounce thirty times without tripping it, while a healthy forty-chunk run
trips for no reason.

**So the guard moves into the data.** The engine cannot count per chunk —
chunks are payload inside an artifact, invisible to stage counters — but a `cel`
gate reads payload. `reviewRounds` on each chunk, checked on the `rework` edge,
bounds the thing that actually matters. `maxCycles` on `executing` is then set
generously (40) on purpose: it is a crude backstop against whole-run thrash,
which is all it can honestly be once chunks exist.

### The stranded chunk and its three exits

When the breaker trips, `accept` is already blocked by `findings-clear` and
`rework` is now blocked too. The chunk is stranded, which is the desired
outcome — but a stranded run needs named ways out, all involving a human:

| Exit           | Gate                                  | When                                    |
| -------------- | ------------------------------------- | --------------------------------------- |
| `escalate`     | none — lands in `breakdown`            | The chunk was wrong, not the code        |
| `force_rework` | `human-approval: chunk-rework-override` | Nearly there, grant one more round      |
| `adapt`        | none — lands in `breakdown`            | Drop the chunk entirely                 |

`escalate` and `adapt` are deliberately ungated. They do not let the agent skip
the human — both land in `breakdown`, and leaving `breakdown-review` requires a
fresh adversarial review and a fresh `human-approval`. An agent that recognises
its chunk is wrong should not need permission to *say so*; it still needs
permission to *proceed*.

**Verified** (`workItem=dry-run-2`): three reworks succeeded, the fourth was
refused with the authored message, `status` showed `accept`/`rework`/
`force_rework` all unsatisfied with `escalate` the only open door, and a human
`approve` on `chunk-rework-override` released the chunk back to `executing`.

## Cancelling a chunk

Real work gets abandoned mid-flight, so the graph should say what that means.
It is already half-modelled: `progress.chunks[].status` includes `dropped`, and
the `complete` gate accepts `done || dropped`, so a cancelled chunk does not
block the run.

The failure mode to design against is **silent self-cancellation** — an agent
that cannot finish a chunk drops it and reports success. That is how scope
quietly evaporates.

The position taken here: **cancelling goes through the breakdown, not through
progress.** Removing work is a change to what was agreed, and the breakdown gate
is exactly where changes to what was agreed get reviewed. It costs a re-review
and a human approval, and the version diff is the audit trail. This keeps the
line the whole design already draws — *progress records what happened,
breakdown records what we agreed to do.*

A `cel` gate on `complete` backs this up by refusing any dropped chunk without a
`droppedReason`, so a drop that does slip into progress cannot reach conformance
review unexplained.

Still worth separating: "not needed after all", "deferred to its own issue", and
"could not do it" are different outcomes that `dropped` currently flattens into
one. The third is a failure, and probably should never be self-service.

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
5. ~~**Chunk-level parallelism is unmodelled.**~~ Answered by the wave: two
   `cel` gates on `submit_chunk` enforce `dependsOn` at every submission, and
   the wave is the unit of review. What stays unenforced is file disjointness
   inside a wave, which the review is asked about instead.
6. ~~**Where does this get published?**~~ Answered: a per-subdirectory manifest
   at `extensions/rocky-road/manifest.yaml` with `paths.base: manifest`.
   `swamp extension quality` packages it on its own.
7. **How wide should a wave get?** Nothing bounds the wave size. Five parallel
   chunks means five agents in one working tree, and one review reading five
   diffs. The honest limit is probably about three, but that wants a real run
   rather than a number picked here.

## Next steps

Done: the definition validates and is loaded as the `rocky-road` instance, the
`reviews:`/`artifact-fresh` pairing and the circuit breaker are verified in dry
runs, the wave gates are verified against the engine, the `breakdown-board`
report ships, and the `rocky-road` skill plus the three constraints files ship
with it.

Left:

1. `rr-publish-ready` is that real work item, in progress. The breakdown was
   reviewed, kicked back twice on real findings, rewritten, and human-approved
   on the third pass. Wave 1 (c1, c2, c3, c6) executed four chunks in parallel
   — the first real multi-chunk wave this factory has run — and cleared review
   with no blocking findings. Wave 2 (c4, plus c6 re-entered to close a review
   finding) followed. Still ahead: c5, `conformance-review`, and
   `pull-request` — none of those have run yet.
2. Calibrate from that run. Answered so far: a four-chunk wave is workable, so
   the "about three" ceiling in open question 7 was pessimistic. Still open:
   `maxCycles` on `breakdown`, and the rework ceiling of three. The sharper
   question the run surfaced is not how *wide* a wave can be but how *small* a
   chunk should be — below roughly an hour of work, the dispatch and review
   overhead exceeds the chunk it protects.
3. What `swamp` surface a sandboxed implementing agent needs is answered by
   "What the access probe found" below — `swamp serve` plus a per-sandbox
   token, with the two upstream asks it surfaced (method-scoped grants, actor
   stamped from the authenticated principal) still unfiled.
4. Publish with `swamp extension push extensions/rocky-road/manifest.yaml`
   once this run has been through it.

## Notes

1. We need to try implementing a sample project to see how the DX is for the human. It may be enough to run a report periodically to assess status. But we may want to have a "live" view of status. Which could be a locally running web server and html view or a set of md files kept in sync (viewed in Obsidian?) or maybe a cute terminal based TUI with live update (?)
2. We need to explore and define the specific swamp calls that are needed for the implementing and reviewing agents to function. I want to run the agent or agents in a sandbox and then turn permission checking off. The sandbox will not have open network egress, will run as a different user or in a container with a different filesystem. So we need to explore how to either poke holes in the sandbox just for the required swamp actions or drive the sandboxed agents from the outside providing them with a simple input/output interface of some files. The sandboxing is the key unlock to get efficient work. Without it, you cannot safely run with no perm checking. And perm checking is a huge efficiency and focus killer for the human in the loop.

### What the access probe found (2026-08-16)

Swamp is repo-local, so a sandboxed agent with its own clone gets its own
`.swamp/` and its own divergent run. The factory needs one shared store. The
route that keeps that true, without a shared writable directory, is
`swamp serve` on the host plus one loopback hole per sandbox:

```
swamp serve --auth-mode token --host 127.0.0.1 --port 8899 --admins user:<you>
swamp behavior run <factory> status --input workItem=<ref> \
  --server ws://127.0.0.1:8899 --token <name>.<secret>
```

Probed against a live server in this repo. What holds:

- **Default deny works.** With no grant, `user:dev1` got
  `Access denied: user:dev1 does not have 'run' on model:rocky-road`.
- **A token identifies the caller.** The server logs
  `Authenticated token "probe-dev1" as "user:dev1"`, and every method run
  lands in run history with `initiatedBy: user:dev1`.
- **Reports come through.** The board rendered in the client's `status`
  output over the socket, so a sandboxed agent sees the same board.

What does not hold, and this is the crux:

- **Grants cannot separate one method from another.** Resource kinds are
  `workflow`, `model`, `data`, and `access` only — `method:` is rejected, and
  `model:rocky-road:approve` parses as a model named `rocky-road:approve`,
  which matches nothing. The condition environment declares `tags`,
  `principal`, and `name`. Every attempt at the requested method
  (`method`, `methodName`, `action`) fails with
  `CEL type error: Unknown variable`.
- **So `run` on a model is `run` on all of its methods.** With one grant of
  `run` on `model:rocky-road`, `user:dev1` ran `status` and reached the
  business-logic pre-flight of `approve`. Authorization let `approve` through.
  Only the missing work item stopped it.
- **`actor` is self-declared.** `approve` writes
  `actor: decision.actor` straight from the input
  (`software_factory.ts:2062`). An agent can call `approve` with
  `actor=seth`, and the approval record cannot tell.

So the human-approval gate is **detectable, not preventable**, over serve
today. The prevention story needs one of:

1. Method-scoped grants upstream — a `methodName` variable in the condition
   environment would be enough, and it is a small ask.
2. The factory stamping `actor` from the authenticated principal rather than
   from the input, when a run arrives through a server.

Until then the honest arrangement is: sandboxed agents hold a token with
`run` on the factory model, the human approves from the host, and forged
approvals are caught by cross-checking each `approval-*` record against the
`initiatedBy` on the run that wrote it. Worth filing both upstream asks
before the first real run.
