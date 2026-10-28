---
name: rocky-road
description: >
  Drive a Rocky Road factory — a @swamp/software-factory definition that
  breaks a work item into chunks, executes them a wave at a time, reviews
  each wave on its own, and routes every change to the chunk list back
  through human approval. Use when a run sits in the breakdown, executing,
  or chunk-review stages, when a chunk is stranded at its rework ceiling,
  when the chunk list turns out to be wrong, or when someone asks where the
  chunks stand. Triggers on "rocky road", "chunked factory", "breakdown",
  "chunk", "chunk board", "breakdown board", "chunk wave", "adapt the
  breakdown", "re-slice", "stranded chunk", "force_rework", "escalate the
  chunk".
---

# Rocky Road

Rocky Road is a factory definition, not a model. The generic drive loop lives
in the `software-factory` skill: `status`, `record_dispatch`, do the work,
`record_artifact`, `advance`. Load that skill for the loop and the method
surface. This skill adds only the rules the chunk graph puts on top.

The design rests on one split:

| Artifact    | Answers                  | Moves            | Reviewed by            |
| ----------- | ------------------------ | ---------------- | ---------------------- |
| `breakdown` | What did we agree to do? | Rarely           | An agent, then a human |
| `progress`  | What actually happened?  | After every wave | Nobody directly        |

Hold that line. Record what happened in `progress`. Record a change to what
was agreed in `breakdown`, which costs a fresh review and a fresh human
approval. That cost is the point.

## The chunk loop

```
executing --submit_chunk--> chunk-review --accept--> executing  (next wave)
                                         --rework--> executing  (same chunks)
```

A wave is the set of chunks under one review. One chunk is the normal case.
All three of these must hold before several chunks make a wave:

- No chunk in the wave depends on another chunk in the wave.
- Every chunk they depend on is already `done` or `dropped`.
- They touch disjoint files.

The first two are gates on `submit_chunk`. The factory refuses a wave that
breaks them. The third is yours to check, because the graph cannot see the
diff. Two chunks that edit one file are one chunk, or they are sequential.

One pass, in order:

1. Choose the wave. Set each chunk in it to `in_progress` in `progress`, and
   set `currentChunks` to their ids.
2. `record_dispatch`, then implement those chunks and nothing else. A wave is
   independent by construction, so run it in parallel. One subagent per chunk
   is the natural shape.
3. Re-record `progress` with each chunk at `done` and `actualChanges` filled
   in. Every `record_artifact` call carries the full payload, so send the
   whole chunk list each time, not the entries that changed.
4. `advance transition=submit_chunk`. One review covers the wave, and each
   finding names the chunk it belongs to.
5. On `accept`, go back to step 1 with the next wave. On `rework`, do the
   bookkeeping below. Then go back to step 2, with the wave shrunk to the
   chunks that failed.

Two rules the engine cannot enforce for you:

- **`currentChunks` is what focuses the review.** The `chunk-review` system
  prompt binds to it. A stale wave sends the reviewer at the wrong chunks,
  and the review still passes, so the mistake is silent.
- **`reviewRounds` is the circuit breaker.** You keep the count. At the start
  of a rework round, raise it by one on each chunk you rework. An absent count
  reads as zero. The `cel` gate on `rework` checks every chunk in the wave.
  One bad chunk trips the breaker, and a wide healthy wave never does. An
  agent that never raises the count disables the only per-chunk guard in the
  graph.

Payloads and exact commands: [references/chunk-loop.md](references/chunk-loop.md).

## When the breakdown is wrong

An artifact records only from the stage that declares it, so you cannot add a
chunk from `executing`. That is deliberate. Adding work, dropping work, and
re-slicing a chunk all change what was agreed. All three take one route:

- From `executing`, `advance transition=adapt`.
- From `chunk-review`, `advance transition=escalate`.

Both land in `breakdown`. Record a new `breakdown` version there. Mark each
new chunk with `origin: added` or `origin: split`, name its `parentChunk`, and
write an `addedReason`. Then walk `breakdown-review` again. The old review is
stale and the old approval does not carry, so the human sees the change.

Neither transition is gated. An agent that finds its chunk wrong does not need
permission to say so. It still needs permission to proceed.

## The stranded wave

Three failed rounds on any chunk in the wave closes the `rework` gate. The
open findings already block `accept`. The wave is stranded on purpose. Three
ways out, each a human decision:

| Exit           | Meaning                            | Gate                                    |
| -------------- | ---------------------------------- | --------------------------------------- |
| `escalate`     | The chunk was wrong, not the code  | None — lands in `breakdown`             |
| `force_rework` | Nearly there, grant one more round | `human-approval: chunk-rework-override` |
| `adapt`        | Drop the chunk entirely            | None — lands in `breakdown`             |

Present all three with the findings that blocked the chunk, then stop. Do not
call `approve` on the override yourself. Read the board first — it names the
stranded chunk without being asked.

## Never do these

- Never mark a chunk `dropped` to get past work you cannot finish. That is how
  scope disappears quietly. A drop is a scope change, so route it through
  `adapt` and let the human see it.
- Never record a `dropped` chunk without a `droppedReason`. A `cel` gate on
  `complete` refuses it, and that refusal arrives late.
- Never widen a wave to make progress look fast. Chunks that touch the same
  files produce one review of a tangle. Chunking exists to prevent exactly
  that.
- Never edit the chunk list inside `progress`. It carries status for chunks
  the breakdown already names.

## Read the board

`status` reports the stage. `summary` reports the history. The board reports
the chunks, which is the question a human asks mid-run:

```bash
swamp behavior run <factory> status --input workItem=<ref>
swamp report get @skunk-ape/rocky-road/breakdown-board --model <factory> --markdown
```

The board derives `ready` and `blocked` from each chunk's dependencies. It
bolds the chunks in the current wave and marks the chunks added after the
initial decomposition. Any chunk at its rework ceiling raises a "Needs a
human" section. Show the board before you ask a human for anything.

## Human touchpoints

Four gates, and no others:

| Gate id                 | Where              | Asks                         |
| ----------------------- | ------------------ | ---------------------------- |
| `breakdown-approval`    | `breakdown-review` | Is this the right split?     |
| `chunk-rework-override` | `chunk-review`     | Grant one more rework round? |
| `ship-approval`         | `pull-request`     | Ship it?                     |
| `abort-confirmation`    | Anywhere           | Abandon the run?             |

The chunk loop holds no human gate. Execution stays agent-autonomous between
two approvals of the breakdown, which is the trade this design makes.

## Set up a factory

```bash
swamp extension pull @skunk-ape/rocky-road
swamp behavior create @swamp/software-factory <factory>
swamp behavior edit <factory>     # paste factory.yaml under globalArguments
swamp behavior run <factory> validate
swamp behavior run <factory> describe
swamp behavior run <factory> start --input workItem=<ref>
```

`factory.yaml` and the constraints files arrive under
`.swamp/pulled-extensions/@skunk-ape/rocky-road/files/`. Register the board in
the definition, as a top-level sibling of `globalArguments`:

```yaml
reports:
  require:
    - { name: "@skunk-ape/rocky-road/breakdown-board", methods: [status] }
```

The stages name constraints files under `agent-constraints/`. Copy the shipped
ones to that path in your repository and edit them. They carry the conventions
for chunk size, chunk shape, wave width, and what one chunk is allowed to
touch. A repository with its own house style edits those files rather than the
graph.
