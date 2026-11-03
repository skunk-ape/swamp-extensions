// The day's journal page.
//
// Everything filled in is computed: the date heading, what shipped since the
// last run, and what is on the plate. The page around them comes from a
// template, so each vault keeps its own layout. Nothing is written by a model.

export type Pr = { repo: string; number: number };

export type Lab = {
  generatedAt: string;
  window: { start: string; end: string; from: string };
  coverage: { ok: boolean; note: string };
  shipped: Array<{ number: number; title: string; status: string; prs: Pr[] }>;
  plate: Array<{
    number: number;
    title: string;
    status: string;
    since: string;
    sinceSource: string;
  }>;
};

const STATUS_LABEL: Record<string, string> = {
  in_progress: "In progress",
  triaged: "Triaged",
  open: "Open",
};

/** Today's date, YYYY-MM-DD, in `tz`. */
export function today(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
}

/** A YYYY-MM-DD shifted by whole days, without a timezone in sight. */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T12:00:00Z`) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function checkDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) {
    throw new Error(`date: not YYYY-MM-DD: ${date}`);
  }
}

/** `# Friday, October 30, 2026` */
export function heading(date: string): string {
  checkDate(date);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(Date.parse(`${date}T12:00:00Z`));
}

/** `journal/2026/10/2026-10-30.md` under the root. */
export function journalPath(root: string, date: string): string {
  checkDate(date);
  return `${root.replace(/\/+$/, "")}/${date.slice(0, 4)}/${
    date.slice(5, 7)
  }/${date}.md`;
}

function sat(since: string, source: string, date: string, tz: string) {
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return "age unknown";
  const day = today(tz, new Date(t));
  const days = Math.round(
    (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) /
      86400000,
  );
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
  }).format(t);
  const age = days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
  return source === "status"
    ? `since ${when} (${age})`
    : `last updated ${when} (${age})`;
}

function windowNote(lab: Lab, tz: string): string | null {
  const hours = (Date.parse(lab.window.end) - Date.parse(lab.window.start)) /
    3600000;
  if (lab.window.from === "baseline" && hours <= 30) return null;
  const at = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(Date.parse(lab.window.start));
  return `*(Since ${at}.)*`;
}

/**
 * `swamp#3467`. A PR in the swamp-club repo would print as `swamp-club#N`,
 * which on this page means a Lab issue, so it says PR instead.
 */
export const prRef = (p: Pr) =>
  p.repo === "swamp-club"
    ? `swamp-club PR #${p.number}`
    : `${p.repo}#${p.number}`;

/**
 * A Lab title is public text anyone can write, and it lands in the vault as
 * Markdown, so every character Markdown or Obsidian gives meaning to is
 * escaped. Unescaped, `<email>` opened an HTML element in Live Preview and
 * left every later heading a literal `##` (2026-11-01..03).
 */
export const escapeTitle = (title: string) =>
  title.replace(/[\\`*_\[\]<>&|#$~=%^{}]/g, (c) => `\\${c}`);

const item = (n: number, title: string) =>
  `**swamp-club#${n}: ${escapeTitle(title)}**`;

function shippedSection(lab: Lab | null, tz: string): string[] {
  if (!lab) {
    return [
      "*(The Lab could not be read this morning; nothing shipped is listed.)*",
    ];
  }
  const out: string[] = [];
  if (!lab.coverage.ok) out.push(`*(Coverage gap: ${lab.coverage.note})*`, "");
  const note = windowNote(lab, tz);
  if (note) out.push(note, "");
  if (lab.shipped.length === 0) {
    out.push("- Nothing shipped or closed.");
    return out;
  }
  for (const s of lab.shipped) {
    const prs = s.prs.map(prRef).join(", ");
    const closed = s.status === "closed" ? " *(closed)*" : "";
    out.push(`- ${item(s.number, s.title)}${closed}${prs ? ` — ${prs}` : ""}`);
  }
  return out;
}

function plateSection(lab: Lab | null, date: string, tz: string): string[] {
  if (!lab) return ["*(The Lab could not be read this morning.)*"];
  if (lab.plate.length === 0) return ["- Nothing open."];
  const out: string[] = [];
  for (const status of Object.keys(STATUS_LABEL)) {
    const items = lab.plate.filter((p) => p.status === status);
    if (!items.length) continue;
    if (out.length) out.push("");
    out.push(`### ${STATUS_LABEL[status]}`);
    for (const p of items) {
      out.push(
        `- ${item(p.number, p.title)} — ${
          sat(p.since, p.sinceSource, date, tz)
        }`,
      );
    }
  }
  return out;
}

/**
 * The page when no template is given: the computed sections and room for
 * notes. A vault with its own layout passes a template instead.
 */
export const DEFAULT_TEMPLATE = [
  "# {{heading}}",
  "",
  "## Shipped yesterday",
  "",
  "{{shipped}}",
  "",
  "## On my plate",
  "",
  "{{plate}}",
  "",
  "## Notes",
  "",
  "-",
  "",
].join("\n");

/**
 * The whole page: `template` with its placeholders filled. `lab` null means
 * the Lab step produced nothing usable.
 *
 * Placeholders: `{{heading}}` (Friday, October 30, 2026), `{{date}}`
 * (2026-10-30), `{{tomorrow}}` (2026-10-31), `{{shipped}}`, `{{plate}}`.
 * Anything else in the template is copied as it is.
 */
export function renderJournal(
  date: string,
  lab: Lab | null,
  tz: string,
  template = DEFAULT_TEMPLATE,
): string {
  const values: Record<string, string> = {
    heading: heading(date),
    date,
    tomorrow: addDays(date, 1),
    shipped: shippedSection(lab, tz).join("\n"),
    plate: plateSection(lab, date, tz).join("\n"),
  };
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (m, key: string) => values[key] ?? m,
  );
}
