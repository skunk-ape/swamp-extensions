# @skunk-ape/is-it-us

When something breaks, find out whether it is upstream before assuming it is
you. Reads the public status pages for GitHub, Cloudflare and AWS, rolls them
into one report, and hands a ready-made alert to ntfy when an incident appears
that the previous check had not seen.

## What you get

- **`@skunk-ape/is-it-us`** — a behavior with one read-only method, `check`.
  One GET per provider; nothing is written anywhere but swamp data. It writes
  `provider-github`, `provider-cloudflare`, `provider-aws` and a `summary`.
- **`@skunk-ape/is-it-us/rollup`** — a report attached by default:

  ```
  Maybe not us: 3 open incidents upstream, 3 new since the last check.

  | Provider   | Status                                  | Open incidents |
  | GitHub     | operational — All Systems Operational   |              0 |
  | Cloudflare | major — Partial System Outage           |              1 |
  | AWS        | critical — 2 open events                |              2 |
  ```

## Setup

```bash
swamp extension pull @skunk-ape/is-it-us   # also pulls @mgreten/ntfy-notify
swamp behavior create @skunk-ape/is-it-us is-it-us
swamp behavior run is-it-us check
swamp report get @skunk-ape/is-it-us/rollup --model is-it-us --markdown
```

Global arguments, all optional:

| Argument         | Default                    | Meaning                                                   |
| ---------------- | -------------------------- | --------------------------------------------------------- |
| `providers`      | `[github, cloudflare, aws]` | Which pages to read.                                      |
| `awsRegions`     | `[]` (all)                 | Region codes to care about, plus `global`.                |
| `timeoutSeconds` | `20`                       | Per-provider cap; a slow page is reported as unreachable. |

Set `awsRegions` to the regions you run in. AWS regional events can stay open
for months, and without a filter they show in every report.

## Pushing to ntfy

A topic on public ntfy.sh works like a password, so keep it in a vault:

```bash
swamp vault create local_encryption ntfy
swamp vault put ntfy NTFY_TOPIC        # prompts with hidden input
swamp behavior create @mgreten/ntfy-notify is-it-us-ntfy
```

In the `is-it-us-ntfy` definition:

```yaml
globalArguments:
  ntfyUrl: https://ntfy.sh
  defaultTopic: ${{ vault.get(ntfy, NTFY_TOPIC) }}
```

Then a workflow that checks, and pushes only when something is new:

```yaml
vaults: [ntfy]
jobs:
  - name: main
    steps:
      - name: check
        task: { type: behavior, behavior: is-it-us, methodName: check }
      - name: notify
        guard: >-
          ${{ data.latest("is-it-us", "summary").?attributes.?newIncidentCount.orValue(0) == 0 }}
        dependsOn: [{ step: check, condition: { type: succeeded } }]
        task:
          type: behavior
          behavior: is-it-us-ntfy
          methodName: sendOutboxTransport
          inputs:
            idempotencyKey: >-
              ${{ "is-it-us-" + data.latest("is-it-us", "summary").?attributes.?checkedAt.orValue("") }}
            payload:
              title: ${{ data.latest("is-it-us", "summary").?attributes.?alertTitle.orValue("") }}
              message: ${{ data.latest("is-it-us", "summary").?attributes.?alertMessage.orValue("") }}
            options:
              priority: ${{ data.latest("is-it-us", "summary").?attributes.?alertPriority.orValue(3) }}
              tags: [warning]
```

`sendOutboxTransport` rather than `send`: it fails the step when ntfy rejects
the POST, where `send` records the failure and reports success. Note that
ntfy-notify writes the topic into its own notification record and log line.

## What counts as new

An incident is new when its id (the Statuspage incident id, or the AWS event
ARN) was not in the previous summary's `seenIncidentIds`.

- An incident that stays open pushes once, however long it lasts.
- A status page that is unreachable for a check keeps its previous incidents
  marked as seen, so it does not re-alert when it comes back.
- The first check treats everything open as new. That is when watching began,
  and an outage already in progress is worth one push.
- Running `check` by hand counts as a check. If you run it before the
  workflow's first run, the workflow will not push for incidents that check
  already saw.

Priority follows the worst new incident: critical 5, major 4, otherwise 3.

## Sources

| Provider   | Endpoint                                                | Notes                                  |
| ---------- | ------------------------------------------------------- | -------------------------------------- |
| GitHub     | `https://www.githubstatus.com/api/v2/summary.json`      | Statuspage; unresolved incidents only. |
| Cloudflare | `https://www.cloudflarestatus.com/api/v2/summary.json`  | Statuspage; maintenance is ignored.    |
| AWS        | `https://health.aws.amazon.com/public/currentevents`    | UTF-16 JSON, decoded before parsing.   |

AWS event status maps 1 → minor, 2 → major, 3 → critical. These endpoints are
public but undocumented in places, so a provider that changes its format
shows as unreachable in the report rather than as all clear.
