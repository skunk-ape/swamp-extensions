# Decomposition conventions

House rules for the `breakdown` stage. Copy this file to
`agent-constraints/decomposition-conventions.md` in your repository and edit
it. The graph reads nothing here. The chunking agent and its reviewer do.

## What one chunk is

A chunk is one change that stands on its own:

- One reviewer reads it in one sitting.
- It leaves the tree in a working state. Tests pass at the end of it.
- It has one reason to be rejected. A chunk that fails review for two
  unrelated reasons was two chunks.
- Size estimate `S` is under an hour, `M` is a few hours, `L` is a day. An `L`
  chunk needs a sentence saying why it resists splitting.

Chunk descriptions name the change, not the activity. "Add the `--json` flag
to `report get`" is a chunk. "Work on the CLI" is not.

## What one chunk is not

- Not a phase. "Write the tests" across five files is not a chunk, because it
  cannot be reviewed against one behaviour.
- Not a file. Two files that change together for one reason are one chunk.
- Not a checklist. A chunk with six bullet points is six chunks, or a chunk
  whose description is too vague to review.

## Dependencies

`dependsOn` names chunks that must finish first, and nothing else. Do not use
it for "these feel related". Every edge you add narrows the waves that can run
in parallel, so an invented edge costs real time.

A chunk list where every chunk depends on the one before it is a sequence, not
a decomposition. When that happens, look again for the seam.

## Waves and file overlap

Chunks with no dependency between them run in one wave, in parallel. That
works only for chunks that touch disjoint files. Fill in `files` on every
chunk, and mean it. Two chunks whose `files` overlap merge into one chunk, or
take a `dependsOn` edge that puts them in different waves.

An honest `files` list is what makes parallel execution safe. A guess is worse
than an empty list, because a reviewer trusts it.

## Ordering

Order the list so a reader sees the shape of the work. Foundations first,
surface last. Ordering is a reading aid — the gates enforce `dependsOn`, not
list position.

## Changing the list later

Every change to the chunk list is a new `breakdown` version, reviewed and
approved again:

- `origin: initial` — from the first decomposition.
- `origin: split` — carved out of a chunk that was too big. Name the
  `parentChunk` and give the `addedReason`.
- `origin: added` — work nobody saw at the start. The `addedReason` says what
  made it visible.

Dropping a chunk is a scope change. It goes through the breakdown, with a
reason, and never through a quiet status edit in `progress`.

## What the reviewer attacks

The `breakdown-review` stage tries to refute the decomposition. Expect these
questions, and answer them in the `rationale` before they get asked:

- Which chunk is too large to finish in one sitting?
- Which two chunks are secretly the same change?
- Which chunk depends on a chunk listed after it?
- What work does the list miss?
- Which chunks claim to be independent while touching the same files?
