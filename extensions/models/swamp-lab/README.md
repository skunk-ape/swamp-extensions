# @skunk-ape/swamp-lab

A daily digest of Swamp Club's public Lab, computed rather than written.

```bash
swamp model create @skunk-ape/swamp-lab swamp-lab
swamp model method run swamp-lab sync
swamp model method run swamp-lab digest
swamp data query 'modelName == "swamp-lab" && name == "current"' --select 'attributes.markdown'
```

## Methods

| Method | What it does |
| --- | --- |
| `sync` | Mirror every public Lab issue into the `corpus` record. About six requests for three thousand issues. |
| `digest` | Build the digest from the corpus and record the baseline the next one diffs against. `record: false` previews without moving the window. |
| `issues` | Fetch the body, status history and linked PRs of up to 15 issues, for discussing them from their content. |

The workflow-scoped report `@skunk-ape/swamp-lab/digest` returns the digest
page in the run's output.

## What the digest contains

- **Who was where:** shipped and opened per team member, with their areas.
- **Shipped:** issues that became shipped or closed since the last digest,
  credited to the assignee. With no assignee, the author is credited and the
  digest says no implementer was named.
- **Stagecraft:** always present. New, moved, and open items with their age.
- **Newly opened:** grouped by area.
- **Repeats:** new issues sharing an area and rare title terms with an issue
  from the previous 120 days.
- **Lands near your work:** new issues in areas where `me` opened or shipped
  at least two issues in the last 30 days.

Areas come from an ordered table of title patterns. The first match is the
issue's area: Stagecraft is rule one, so an issue about Stagecraft's tests is
filed under Stagecraft, not CI.

## The window

Each recorded digest saves every issue's status and assignees as a baseline.
The next digest's window starts where that one ended, and "shipped" and
"moved" are status changes between the baseline and the latest corpus. So two
digests a day apart, or a week apart, each cover exactly what happened since
the last one.

When the corpus is incomplete (below `minCoverage` of the total the Lab
reports) or stale (older than `maxCorpusAgeHours`), the page opens with a
coverage gap and the window is not recorded. The next digest covers that time
again.

## Phone rules

The page is read on a phone: no tables, links only on descriptive phrases,
names rather than handles, one idea per bullet. Dates are in `timezone`.

## Tests

```bash
~/.swamp/deno/deno test extensions/models/swamp-lab/
```
