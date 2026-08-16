# Triage conventions

House rules for the `triage` stage. Copy this file to
`agent-constraints/triage-conventions.md` in your repository and edit it.
Tracker-specific rules — where issues live, which labels matter — belong here.

## The verdict

The `classification` artifact carries four fields that matter downstream:

- `type` — `bug`, `feature`, `platform`, or `security`. Pick the one that
  changes what happens next, not the one that sounds closest.
- `confidence` — `high`, `medium`, or `low`. Low confidence is a real answer.
  It tells the breakdown stage to start with a chunk that settles the
  question.
- `reasoning` — the evidence, in a sentence or two. Name the file, the log
  line, or the report that decided it.
- `isRegression` plus `regressionEvidence` — set both, or neither. A
  regression claim without the commit or the version that broke it is a guess.

## Gather before you classify

Read the issue, then read the code it names. Triage that never opens the
repository produces a breakdown built on the reporter's mental model rather
than the codebase.

For a bug, reproduce it first while reproducing stays cheap. A reproduction
turns into the first chunk of the breakdown, so the effort is not wasted.

## Scope

Triage decides what the work item is, not how to do it. No chunk list, no file
list, no design. Those belong to `breakdown`, where a reviewer attacks them.

When an issue holds two unrelated pieces of work, say so in `reasoning`. Let
the human split the work item. One work item is one lifecycle, and a breakdown
cannot fix an issue that belongs in two.

## Security

An issue with a security dimension is `type: security`, whatever label it
arrived with. Say in `reasoning` whether the vulnerability is
reachable, and do not write an exploit into the artifact.
