# @skunk-ape/lifeos-daily

The day's journal file in a LifeOS vault, created before anyone opens it and
already filled with what you shipped yesterday and what is on your plate.

```bash
swamp behavior create @skunk-ape/lifeos-daily lifeos-daily
swamp behavior run swamp-lab mine
swamp behavior run lifeos-daily journal \
  --input 'lab=${{ data.latest("swamp-lab", "mine").attributes }}'
```

In practice a workflow runs it: `swamp-lab sync`, then `swamp-lab mine`, then
`journal` with the `mine` record passed in, then `mine` again to record the
window once the page exists.

## Methods

| Method    | What it does                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| `journal` | Write `<journalRoot>/YYYY/MM/YYYY-MM-DD.md` for today (or `date`), or to `output` for a trial. Never overwrites. |

## The page

The vault decides the layout. Point `template` at a Markdown file and `journal`
fills in its placeholders; everything else in it is copied as it is.

| Placeholder    | Becomes                    |
| -------------- | -------------------------- |
| `{{heading}}`  | `Friday, October 30, 2026` |
| `{{date}}`     | `2026-10-30`               |
| `{{tomorrow}}` | `2026-10-31`               |
| `{{shipped}}`  | the Shipped list below     |
| `{{plate}}`    | the On my plate list below |

With no `template`, the page is a heading, Shipped yesterday, On my plate and an
empty Notes section.

- **Shipped:** one bullet per Lab issue assigned to you that moved to shipped or
  closed since the last recorded `mine` run, with the PRs linked to it:
  `**swamp-club#3868: title** — swamp#3467, swamp-uat#836`. A window that is not
  the usual day long, such as the first run, says where it starts.
- **On my plate:** open Lab issues assigned to you, grouped In progress,
  Triaged, Open, each with how long it has sat since its last status change (or
  its last update, when the history is unavailable).

Lab titles are public text, so every character Markdown or Obsidian treats as
syntax is backslash-escaped. A title cannot open HTML, a link, a tag or emphasis
in the page.

## Arguments

| Global argument  | Default       |                                                                           |
| ---------------- | ------------- | ------------------------------------------------------------------------- |
| `journalRoot`    | required      | The vault's journal directory. `~` is home.                               |
| `template`       | built-in page | The layout file. `~` is home. A named file that is missing fails the run. |
| `timezone`       | `UTC`         | Which day "today" is.                                                     |
| `maxLabAgeHours` | `3`           | A `mine` record older than this is treated as missing.                    |

## Never overwrite

If the day's file exists, someone started it. `journal` leaves it as it is and
records `reason: exists`. The write itself is an exclusive create, so the rule
holds even against a file that appears between the check and the write.

## When the Lab cannot be read

A missing `mine` record, or one older than `maxLabAgeHours` (an earlier run's,
left over after this run's step failed), still writes the page. The two Lab
sections say the Lab could not be read, instead of repeating yesterday's.

## Tests

```bash
~/.swamp/deno/deno test --allow-env --allow-read --allow-write extensions/lifeos-daily/
```
