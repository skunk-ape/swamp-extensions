# Implementation conventions

House rules for the `executing` and `pull-request` stages. Copy this file to
`agent-constraints/implementation-conventions.md` in your repository and edit
it. Repository-specific rules — the test command, the commit format, the
directories that are off limits — belong here.

## Stay inside the wave

Implement the chunks named in `currentChunks` and nothing else. A fix you
notice in passing is a new chunk, recorded through `adapt`, not a quiet extra
diff. Unrelated changes make the chunk review meaningless. The reviewer can no
longer tell what the chunk was.

When a chunk turns out to need work the breakdown never mentioned, stop and
take `adapt`. Do not absorb it.

## Parallel chunks

Chunks in one wave run in parallel, one agent per chunk. That is safe only
while they stay disjoint:

- Touch only the files your chunk names. A file another chunk in the wave owns
  is off limits, even for a one-line fix.
- Do not depend on behaviour another chunk in the wave introduces. If you need
  it, the wave was wrong, so say so rather than waiting for it.
- Some files every chunk wants: a barrel export, a lockfile, a registry. They
  belong to a chunk of their own, ahead of the wave.

## Leave the tree working

Each chunk ends with the build passing and the tests green. Run the suite
before recording the chunk as `done`. A chunk that ends red is not done.
Recording it as done is the one lie the graph cannot catch.

Write the test in the chunk that introduces the behaviour. Test-shaped chunks
that trail the implementation break the "one reason to be rejected" rule.

## Record what you did

`actualChanges` on each chunk is what conformance review reads at the end. Say
what changed, in files and behaviour, and say where you deviated from the
chunk description. A deviation recorded now is a discussion. A deviation found
at conformance review is a finding.

## Rework rounds

On a rework round, fix the finding and nothing beyond it. Raise `reviewRounds`
on the chunk you are reworking, and shrink `currentChunks` to the chunks that
actually failed. Chunks that passed stay `done` and leave the wave.

Three failed rounds strands the chunk on purpose. Do not work around the
breaker by re-recording the chunk under a new id.

## The pull request

One pull request for the whole breakdown, not one per chunk. The description
follows the chunk list in order, one line each. It names every chunk that was
added, split, or dropped along the way, with its reason. The reviewer of the
pull request reads the same story the breakdown tells.
