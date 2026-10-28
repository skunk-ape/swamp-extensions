# @skunk-ape/coros

COROS sleep, recovery, training data and workouts as swamp data.

| Behavior | Talks to | Auth | For |
| --- | --- | --- | --- |
| `@skunk-ape/coros/official` | COROS's official MCP server, called directly | OAuth, its own client | sleep, HRV, recovery, fitness, schedule, creating workouts |
| `@skunk-ape/coros/hub` | the unofficial Training Hub web API | email and password | activities and daily metrics as JSON, removing a scheduled workout |

The report `@skunk-ape/coros/recent` joins both on one page.

## Why call an MCP server without an MCP host

`mcpus.coros.com` is stateless JSON-RPC over HTTPS behind standard OAuth 2.1
(discovery, dynamic client registration, PKCE, refresh tokens). Nothing about
calling it needs a long-running MCP process, so `official` is a plain API
client: it registers its own OAuth client, signs in once in a browser, and
refreshes by itself.

It registers its own client on purpose. Refresh tokens can rotate, and two
programs sharing one would take turns invalidating each other.

## Setup

```bash
# official: create, then sign in once in a browser on this machine
swamp model create @skunk-ape/coros/official coros
swamp model method run coros authorize

# hub: credentials from a vault
swamp model create @skunk-ape/coros/hub coros-hub
swamp model edit coros-hub
#   email:    ${{ vault.get("my-vault", "coros-email") }}
#   password: ${{ vault.get("my-vault", "coros-password") }}
#   region:   us
```

`authorize` listens on `127.0.0.1:27891` (`callbackPort`) for the redirect.
The tokens are sensitive fields, so swamp stores them in a vault rather than in
data.

## Reading data

```bash
swamp model method run coros recent --input days=7
swamp model method run coros-hub recent --input days=7

swamp data query 'behavior("coros") && name.startsWith("day-")' \
  --select 'attributes.date + " " + string(attributes.sleep.score)'
```

`official.recent` writes one `day-YYYY-MM-DD` per wake-up day (sleep score and
stages, HRV against its normal range, resting HR, stress, steps, training load)
and a `snapshot` (recovery, VO2max and threshold pace, race predictions, the
coming week's schedule). `hub.recent` writes `metrics-YYYY-MM-DD` and
`activity-<labelId>`.

`official.query` calls any read-only tool on the server and keeps its text, for
questions `recent` does not cover.

## The official server answers in prose

Its tools return text written for a model, such as `Sleep Score: 91`. `recent`
parses that into typed fields and keeps the text beside them in `raw`. Each
parser reads `Key: value` lines and maps the keys it knows, so a reworded label
costs one field, not the record. A change of shape would break the parse, and
the tests pin the shape. Training Hub covers what needs to be exact.

## Creating workouts

```bash
swamp model method run coros createWorkout --input-file six-by-800.yaml
```

```yaml
name: 6 x 800m
date: 2026-11-03          # omit to save to the library instead
dryRun: true              # show the course; send nothing
steps:
  - { kind: warmup, distance: 1.5mi, hrZone: 2 }
  - repeat: 6
    steps:
      - { kind: work, distance: 800m, pace: "6:50/mi" }
      - { kind: recover, distance: 400m, hrZone: 1 }
  - { kind: cooldown, distance: 1mi, hrZone: 1 }
```

A step has one target (`distance`, `time`, `climb`, or `open: true`) and at
most one intensity (`pace`, `paceZone`, `pacePercent`, `hr`, `hrZone`,
`hrPercent`, `power`, `powerZone`). Paces are converted from the unit you write
to COROS's seconds per kilometre, and COROS's own rules are checked before
anything is sent:

- trail runs take no time targets
- running power takes watts, not zones
- `hrPercent` is a percentage of LTHR, not of max HR
- repeats hold only work and recover steps, cannot nest, and run 1-20 times

COROS cannot nest repeats, so write `6x(400m + 2x200m)` as a repeat of six with
the 200s spelled out. Without a `description`, a plain-words one is generated
from the steps, in the instance's `units`.

To take a workout off the calendar, which the official server cannot do:

```bash
swamp model method run coros-hub removeScheduledWorkout \
  --input date=2026-11-03 --input 'name=6 x 800m' --input dryRun=true
```

## No sleep from Training Hub

Training Hub reaches sleep only through COROS's mobile login, which signs the
account owner out of the COROS app on their phone. This extension has no mobile
code. Sleep comes from the official server.

## Grants

Swamp grants are behavior-scoped: `run` on an `official` instance includes
`createWorkout`, and `run` on a `hub` instance includes
`removeScheduledWorkout`. To give an agent reads but not writes, grant it a
workflow rather than the instance.

## Tests

```bash
~/.swamp/deno/deno test --allow-read extensions/coros/
```

The parser fixtures copy the official server's layout with invented numbers.
