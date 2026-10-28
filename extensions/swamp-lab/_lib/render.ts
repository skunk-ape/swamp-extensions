// The digest as Seth reads it: on a phone.
//
// Ported from swamp_lab_render.py and held to its rules, which the tests pin:
// no tables, links only on descriptive phrases (never a bare issue number),
// names rather than handles, one idea per bullet, and Stagecraft always
// present, saying plainly when it is quiet. The narrative — "the read" at the
// top — is left to the agent; this is the grounded body underneath it.
//
// Dates are rendered in the reader's timezone. The Python version printed UTC,
// which put an 8pm Chicago issue on the next day.

import type { Brief, Digest } from "./digest.ts";
import { WEB_URL } from "./lab.ts";

const MAX_ITEMS_PER_AREA = 4;
const MAX_AREAS = 5;
const MAX_SHIPPED_PER_PERSON = 4;
const TITLE_CHARS = 76;
const STALE_DAYS = 14;

const link = (text: string, n: number) =>
  `[${text.replace(/[[\]]/g, "")}](${WEB_URL}${n})`;

/** Drop a short "area: " style prefix, so the phrase says what the issue is. */
export function stripPrefix(title: string): string {
  for (const sep of [": ", " — ", " - "]) {
    const i = title.indexOf(sep);
    if (i > 0) {
      const head = title.slice(0, i);
      const tail = title.slice(i + sep.length);
      if (tail && head.length <= 34 && /[A-Za-z]/.test(head)) return tail;
    }
  }
  return title;
}

export function phrase(title: string, limit = TITLE_CHARS): string {
  const t = stripPrefix(title).trim();
  if (t.length <= limit) return t;
  let cut = t.slice(0, limit);
  const sp = cut.lastIndexOf(" ");
  if (sp > limit / 2) cut = cut.slice(0, sp);
  return cut.replace(/[ ,;:·—-]+$/, "") + "…";
}

function dateFmt(tz: string, opts: Intl.DateTimeFormatOptions) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz || undefined,
    ...opts,
  });
  return (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? f.format(t) : "unknown";
  };
}

export function render(d: Digest, tz = ""): string {
  const day = dateFmt(tz, { day: "numeric", month: "short" });
  const head = dateFmt(tz, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const when = dateFmt(tz, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const L: string[] = [];

  L.push(`## Lab — ${head(d.window.end).replace(",", "")}`);
  const scope = [
    `Window ${when(d.window.start)} → ${
      when(d.window.end)
    } (${d.window.hours}h)`,
    `${d.opened.total} opened`,
    `${d.shipped.total} shipped or closed`,
  ];
  if (d.window.widened) scope.push("window widened to cover a missed run");
  if (d.window.firstRun) {
    scope.push("first run: shipped is approximate, from last-updated times");
  }
  L.push(`*${scope.join(" · ")}*`);
  L.push(`*Tracking ${d.tracked.toLocaleString("en-US")} issues.*`);

  if (!d.coverage.ok) {
    // Never report quiet when the source failed.
    L.push(
      "",
      `**Coverage gap:** ${d.coverage.note} Treat empty sections below as unknown, not quiet.`,
    );
  }
  if (d.vanished.length) {
    L.push(
      "",
      `*${d.vanished.length} issue${
        d.vanished.length === 1 ? "" : "s"
      } no longer listed publicly since the last digest.*`,
    );
  }

  L.push("", "**Who was where**");
  for (const t of d.teamActivity) {
    const quiet = t.shipped === 0 && t.opened === 0;
    const areas = t.topAreas.slice(0, 2).map((a) => a.label.toLowerCase()).join(
      ", ",
    );
    L.push(
      quiet
        ? `- **${t.person}** — quiet`
        : `- **${t.person}** — shipped ${t.shipped}, opened ${t.opened}${
          areas ? ` — ${areas}` : ""
        }`,
    );
  }

  // ---- shipped ------------------------------------------------------------
  L.push("", "---", "", "## Shipped");
  if (d.shipped.total === 0) {
    L.push("", "Nothing landed in this window.");
  } else {
    const also: string[] = [];
    for (const bk of d.shipped.byPerson) {
      const onTeam = d.teamActivity.some((t) => t.handle === bk.handle);
      if (!onTeam && bk.items.length < 2) {
        also.push(bk.person);
        continue;
      }
      const parts = [];
      if (bk.implemented) parts.push(`${bk.implemented} implemented`);
      if (bk.authoredOnly) {
        parts.push(
          `${bk.authoredOnly} of their reports closed with no implementer named`,
        );
      }
      L.push("", `**${bk.person}** — ${parts.join(", ")}`);
      if (bk.areas.length) {
        L.push(
          `*Areas: ${
            bk.areas.slice(0, 3).map((a) => a.label.toLowerCase()).join(", ")
          }*`,
        );
      }
      for (const it of bk.items.slice(0, MAX_SHIPPED_PER_PERSON)) {
        L.push(
          `- ${link(phrase(it.title), it.number)}${
            it.status === "closed" ? " — closed" : ""
          }`,
        );
      }
      if (bk.items.length > MAX_SHIPPED_PER_PERSON) {
        L.push(
          `- …and ${
            bk.items.length - MAX_SHIPPED_PER_PERSON
          } more in the same areas`,
        );
      }
    }
    if (also.length) {
      L.push("", `**Also shipping:** ${also.slice(0, 6).join(", ")}`);
    }
  }

  // ---- stagecraft ---------------------------------------------------------
  const sc = d.stagecraft;
  L.push("", "---", "", "## Stagecraft");
  if (sc.quiet) {
    L.push("", "Nothing new opened, nothing moved. Clean.");
  } else {
    L.push("");
    for (const it of sc.new) {
      L.push(
        `- **New** — ${link(phrase(it.title), it.number)} (${it.authorPerson})`,
      );
    }
    for (const it of sc.moved) {
      L.push(`- **${it.transition}** — ${link(phrase(it.title), it.number)}`);
    }
  }
  if (sc.openTotal) {
    const stale = sc.openItems.filter((i) => i.ageDays > STALE_DAYS);
    L.push(
      "",
      `*${sc.openTotal} open*, ${stale.length} sitting more than ${STALE_DAYS} days`,
    );
    for (const it of (stale.length ? stale : sc.openItems).slice(0, 4)) {
      L.push(`- ${link(phrase(it.title), it.number)} · ${it.ageDays}d`);
    }
  }

  // ---- newly opened -------------------------------------------------------
  const echoOf = new Map(d.echoes.map((e) => [e.issue.number, e]));
  const near = new Set(d.mine.connections.map((c) => c.issue.number));
  const tags = (it: Brief) => {
    const t: string[] = [];
    const e = echoOf.get(it.number);
    if (e) {
      const p = e.prior[0];
      const more = e.priorCount > 1 ? ` (+${e.priorCount - 1})` : "";
      t.push(
        `[same ground as ${
          day(p.createdAt)
        }'s report${more}](${p.url}), ${p.status}`,
      );
    }
    if (near.has(it.number)) t.push("near your work");
    if (it.blocked) t.push("blocked");
    return t.length ? ` — *${t.join("; ")}*` : "";
  };
  L.push("", "---", "", "## Newly opened");
  if (d.opened.total === 0) {
    L.push("", "Nothing new in this window.");
  } else {
    for (const g of d.opened.byArea.slice(0, MAX_AREAS)) {
      L.push("", `**${g.label}** — ${g.count} from ${g.authors.join(", ")}`);
      for (const it of g.items.slice(0, MAX_ITEMS_PER_AREA)) {
        L.push(`- ${link(phrase(it.title), it.number)}${tags(it)}`);
      }
      if (g.items.length > MAX_ITEMS_PER_AREA) {
        L.push(`- …and ${g.items.length - MAX_ITEMS_PER_AREA} more`);
      }
    }
    const rest = d.opened.byArea.slice(MAX_AREAS);
    if (rest.length) {
      L.push(
        "",
        `**Also opened:** ${
          rest.map((g) => `${g.label.toLowerCase()} (${g.count})`).join(", ")
        }`,
      );
    }
  }

  // ---- repeats ------------------------------------------------------------
  if (d.echoes.length) {
    L.push(
      "",
      "---",
      "",
      "## Repeats",
      "",
      "*New issues matching older ones — matched on area plus rare shared terms.*",
    );
    for (const e of d.echoes.slice(0, 4)) {
      const p = e.prior[0];
      const others = e.priorCount > 1
        ? `, and ${e.priorCount - 1} other${e.priorCount > 2 ? "s" : ""}`
        : "";
      L.push(
        `- ${
          link(phrase(e.issue.title, 70), e.issue.number)
        } — ${e.areaLabel.toLowerCase()}`,
      );
      L.push(
        `  Matches [an earlier issue](${p.url}) from ${
          day(p.createdAt)
        } (${p.status})${others}`,
      );
    }
  }

  // ---- near my work -------------------------------------------------------
  if (d.mine.connections.length) {
    L.push("", "---", "", "## Lands near your work");
    if (d.mine.recentAreas.length) {
      L.push(
        "",
        `*Your recent areas: ${
          d.mine.recentAreas.slice(0, 4).map((a) => a.label.toLowerCase()).join(
            ", ",
          )
        }.*`,
      );
    }
    for (const c of d.mine.connections.slice(0, 4)) {
      L.push(
        `- ${
          link(phrase(c.issue.title), c.issue.number)
        } — ${c.issue.authorPerson}, ${
          c.sharedAreas.map((a) => a.label.toLowerCase()).join(", ")
        }`,
      );
    }
  }
  return L.join("\n") + "\n";
}
