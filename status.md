## @skunk-ape/rocky-road/breakdown-board

Model: rocky-road (@swamp/software-factory)  |  Scope: method  |  v8  |  2026-08-17T03:13:12.418Z

# Breakdown board — rr-publish-ready

**Stage:** breakdown-review · **Breakdown recorded:** 2026-08-17T02:34:55.889Z

**5 chunks** — 2 blocked · 3 not started

| | Chunk | State | Rounds | Depends on | Description |
| --- | --- | --- | --- | --- | --- |
| ` ` | c1 | not started | — | — | Add README.md for @skunk-ape/rocky-road with at least two fenced examples, and list it in additionalFiles. Fixes readme-example and rich-readme. |
| ` ` | c2 | not started | — | — | JSDoc the exported symbols in breakdown_board.ts so symbols-docs clears 80%. Comments only, no behaviour change. |
| ` ` | c3 | not started | — | — | Add breakdown_board_test.ts covering derived state (ready vs blocked vs not started), wave rendering from currentChunks and the legacy currentChunk, the stalled-chunk section, and silence on a factory with no breakdown artifact. Run with ~/.swamp/deno/deno test. |
| `.` | c4 | blocked | — | **c1**, **c2**, **c3** | Perform the adversarial review swamp extension push asks for and write the report to the path it names, obtained via push --dry-run --json. |
| `.` | c5 | blocked | — | **c4** | Verify: swamp extension quality reports 12/12 and push --dry-run is warning-free, then bump the manifest version. |

```mermaid
flowchart LR
  c1["c1<br/>not started"]:::not_started
  c2["c2<br/>not started"]:::not_started
  c3["c3<br/>not started"]:::not_started
  c4["c4<br/>blocked"]:::blocked
  c5["c5<br/>blocked"]:::blocked
  c1 --> c4
  c2 --> c4
  c3 --> c4
  c4 --> c5
  classDef done fill:#d7ebd7,stroke:#4a7a4a,color:#14321a
  classDef in_progress fill:#fde8c8,stroke:#a2621b,color:#3a2408
  classDef ready fill:#e8eef7,stroke:#4a6a9a,color:#12243a
  classDef blocked fill:#eeeeee,stroke:#999999,color:#333333
  classDef dropped fill:#f3d9d4,stroke:#97392c,color:#3a120c
  classDef not_started fill:#f7f7f5,stroke:#bbbbbb,color:#444444
```



