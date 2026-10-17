# The chunk loop, in commands

Payload shapes and exact calls for the `executing` and `chunk-review` stages.
`<f>` is the factory name and `<w>` is the work item.

## Choose the wave

Read the agreed chunk list, then read what happened to it:

```bash
swamp data query 'modelName == "<f>" && name == "artifact-<w>-breakdown"' \
  --select attributes.payload.chunks --json
swamp data query 'modelName == "<f>" && name == "artifact-<w>-progress"' \
  --select attributes.payload --json
```

A chunk is eligible while every id in its `dependsOn` reads `done` or
`dropped` in `progress`. Take the eligible set, then drop any chunk that
shares a file with another chunk in the set. What remains is the wave. When in
doubt, send one chunk. A narrow wave costs one more review round. A wrong wave
costs a tangle.

The board renders the same decision. Use it while a human is watching:

```bash
swamp model method run <f> status --input workItem=<w>
swamp report get @skunk-ape/rocky-road/breakdown-board --model <f> --markdown
```

## Open the wave

`progress` carries the whole chunk list every time. Chunks the breakdown names
but progress omits read as "not started", so keep them all in the payload.

```bash
swamp model method run <f> record_artifact --input workItem=<w> \
  --input name=progress --input payload='{
    "currentChunks": ["c2", "c3"],
    "chunks": [
      {"id": "c1", "status": "done", "actualChanges": "src/tok.ts, tests"},
      {"id": "c2", "status": "in_progress"},
      {"id": "c3", "status": "in_progress"},
      {"id": "c4", "status": "pending"}
    ]
  }'
swamp model method run <f> record_dispatch --input workItem=<w>
```

Then implement `c2` and `c3` in parallel, one subagent per chunk. Give each
subagent its own chunk description from the breakdown and nothing else.
Neither one then wanders into the other chunk's files.

## Close the wave and submit it

```bash
swamp model method run <f> record_artifact --input workItem=<w> \
  --input name=progress --input payload='{
    "currentChunks": ["c2", "c3"],
    "chunks": [
      {"id": "c1", "status": "done", "actualChanges": "src/tok.ts, tests"},
      {"id": "c2", "status": "done", "actualChanges": "src/err.ts"},
      {"id": "c3", "status": "done", "actualChanges": "src/parse.ts, tests"},
      {"id": "c4", "status": "pending"}
    ]
  }'
swamp model method run <f> advance --input workItem=<w> --input transition=submit_chunk
```

Two `cel` gates guard this edge. `DEPS_NOT_DONE` means a chunk in the wave
waits on open work. The wave-peer gate means one chunk in the wave depends on
another. Submit the dependency first and the dependent later.

## Review the wave

`chunk-review` is a dispatch stage. Spawn the reviewer with the stage's
`systemPrompt`, which `status` returns with `currentChunks` already resolved.
Merge the findings into one record. Name the chunk in every finding id:

```bash
swamp model method run <f> record_artifact --input workItem=<w> \
  --input name=chunk-review --input payload='{
    "findings": [
      {"id": "c3-1", "severity": "high", "category": "correctness",
       "description": "parse() drops the trailing token on empty input"}
    ]
  }'
```

An empty `findings` array is a clean review. With no critical or high finding
open, `accept` is satisfied:

```bash
swamp model method run <f> advance --input workItem=<w> --input transition=accept
```

## Rework a wave

Shrink the wave to the chunks that failed. Raise `reviewRounds` on each of
them, and set them back to `in_progress`. Chunks that passed stay `done` and
leave the wave.

```bash
swamp model method run <f> advance --input workItem=<w> --input transition=rework
swamp model method run <f> record_artifact --input workItem=<w> \
  --input name=progress --input payload='{
    "currentChunks": ["c3"],
    "chunks": [
      {"id": "c1", "status": "done", "actualChanges": "src/tok.ts, tests"},
      {"id": "c2", "status": "done", "actualChanges": "src/err.ts"},
      {"id": "c3", "status": "in_progress", "reviewRounds": 1},
      {"id": "c4", "status": "pending"}
    ]
  }'
```

Fix the finding, then mark the resolution so `findings-clear` sees it:

```bash
swamp model method run <f> resolve_findings --input workItem=<w> \
  --input artifact=chunk-review \
  --input resolutions='[{"findingId": "c3-1", "note": "guard added, test covers empty input"}]'
```

Recording `progress` again stales the old `chunk-review`, so the next round
records a fresh one. That is the subject-version pin doing its job.

`ROUNDS_EXHAUSTED` on the `rework` gate means a chunk in the wave failed three
rounds. Stop and put the three exits to the human.

## Adapt the breakdown

From `executing` use `adapt`. From `chunk-review` use `escalate`. Both land in
`breakdown`, where a new version of the chunk list gets recorded:

```bash
swamp model method run <f> advance --input workItem=<w> --input transition=adapt
swamp model method run <f> record_dispatch --input workItem=<w>
swamp model method run <f> record_artifact --input workItem=<w> \
  --input name=breakdown --input payload='{
    "rationale": "c3 was two changes wearing one hat",
    "chunks": [
      {"id": "c1", "description": "Tokenizer", "origin": "initial"},
      {"id": "c2", "description": "Error type", "origin": "initial"},
      {"id": "c3a", "description": "Parser core", "origin": "split",
       "parentChunk": "c3", "addedReason": "the empty-input path is its own change"},
      {"id": "c3b", "description": "Empty-input handling", "origin": "split",
       "parentChunk": "c3", "addedReason": "the empty-input path is its own change"},
      {"id": "c4", "description": "CLI", "origin": "initial", "dependsOn": ["c3a"]}
    ]
  }'
```

Then walk `breakdown-review` again and stop at `breakdown-approval`. Show the
human the new chunk list and the reason, fetched fresh from the record, and
wait. On the way back through `executing`, re-record `progress` so its chunk
ids match the new breakdown.

## Finish

`complete` needs every chunk `done` or `dropped`, and every dropped chunk
needs a `droppedReason`:

```bash
swamp model method run <f> advance --input workItem=<w> --input transition=complete
```

From there the graph is ordinary: `conformance-review` compares the whole diff
against the final breakdown, then `pull-request` records the change-request
evidence and waits for `ship-approval`.

## Gate messages, and what each one means

| Message               | Cause                                     | Fix                                          |
| --------------------- | ----------------------------------------- | -------------------------------------------- |
| `DEPS_NOT_DONE`       | A chunk in the wave waits on open work    | Send a smaller wave                          |
| Wave-peer gate failed | Two chunks in the wave depend on each other | Split the wave, dependency first            |
| `ROUNDS_EXHAUSTED`    | A chunk failed three rounds               | Put the three exits to the human             |
| `artifact-fresh`      | The subject moved since the review        | Re-record the review against the new version |
| `findings-clear`      | A critical or high finding is open         | Fix it, then `resolve_findings`              |
