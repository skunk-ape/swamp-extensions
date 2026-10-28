// The digest: what shipped, what opened, what moved, and what it resembles —
// all computed, none of it written by a model.
//
// Ported from Apalone's swamp_lab_digest.py. The shape of the output and the
// heuristics (echo strength, Seth's focus areas, the Stagecraft section) are
// the same. What changed, and why:
//
// - "What moved" is a diff between the corpus now and the baseline the last
//   recorded digest saved, rather than an event log written poll by poll. The
//   window is therefore always "since the last digest", which fixes the old
//   behaviour of re-announcing items when two digests ran less than 24 hours
//   apart, and it no longer depends on `shippedAt`, which the list API stopped
//   sending.
// - Primary area follows rule order (see classify.ts).
// - Assignees are matched by membership, not by substring of a JSON string,
//   so `hammz` no longer matches `hammz2`.
// - Issues that vanish upstream are reported as vanished instead of counted
//   forever.
// - "Your recent areas" leaves out the excluded areas, as the focus already did.

import { type Area, classify, labelFor, primaryArea } from "./classify.ts";
import { type Issue, WEB_URL } from "./lab.ts";

export type Baseline = Record<string, { status: string; assignees: string[] }>;

export type Team = Record<string, string>;

const DONE = new Set(["shipped", "closed"]);
const OPEN = new Set(["open", "triaged", "in_progress"]);
const ECHO_EXCLUDED = new Set(["docs", "cli_ux", "other"]);
const STOPWORDS = new Set(
  ("the a an and or but is are was were be been being to of in on at for with from by as it its this that " +
    "these those not no so if then than when while after before into out up down over under again once all any " +
    "both each more most other some such only own same can will just should now does did has have had would " +
    "could may might must shall swamp issue lab run runs new use uses used using")
    .split(" "),
);

export type Brief = {
  number: number;
  url: string;
  title: string;
  type: string;
  status: string;
  author: string | null;
  authorPerson: string;
  assignees: string[];
  assigneePeople: string[];
  areas: string[];
  primaryArea: string;
  areaLabel: string;
  createdAt: string;
  blocked: boolean;
  isStagecraft: boolean;
};

type Enriched = Issue & { areaList: Area[]; primary: string };

function enrich(i: Issue): Enriched {
  const areaList = classify(i.title);
  return { ...i, areaList, primary: primaryArea(areaList) };
}

export function person(team: Team, handle: string | null): string {
  return handle ? team[handle] ?? handle : "unassigned";
}

function brief(i: Enriched, team: Team): Brief {
  return {
    number: i.number,
    url: WEB_URL + i.number,
    title: i.title,
    type: i.type,
    status: i.status,
    author: i.author,
    authorPerson: person(team, i.author),
    assignees: i.assignees,
    assigneePeople: i.assignees.map((a) => person(team, a)),
    areas: i.areaList.map((a) => a.area),
    primaryArea: i.primary,
    areaLabel: labelFor(i.primary),
    createdAt: i.createdAt,
    blocked: i.blocked,
    isStagecraft: i.areaList.some((a) => a.area === "stagecraft"),
  };
}

/** Distinctive words from a title, as the Python tokenizer chose them. */
export function keywords(title: string): Set<string> {
  const words = title.toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w) && w.length > 3));
}

function countAreas(items: Enriched[], max: number) {
  const counts = new Map<string, number>();
  for (const i of items) {
    for (const a of i.areaList) {
      counts.set(a.area, (counts.get(a.area) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, max)
    .map(([area, count]) => ({ area, label: labelFor(area), count }));
}

export type DigestInput = {
  issues: Issue[];
  baseline: Baseline | null;
  windowStart: string;
  windowEnd: string;
  team: Team;
  me: string;
  coverage: {
    total: number;
    seen: number;
    coverage: number;
    ok: boolean;
    note: string;
  };
  widened: boolean;
};

export function buildDigest(inp: DigestInput) {
  const { team, me } = inp;
  const since = inp.windowStart;
  const all = inp.issues.map(enrich);
  const byNumber = new Map(all.map((i) => [i.number, i]));
  const b = (i: Enriched) => brief(i, team);
  const prev = (n: number) => inp.baseline?.[String(n)];

  // ---- movement: every status change since the baseline -----------------
  const movement = inp.baseline
    ? all.filter((i) => prev(i.number) && prev(i.number)!.status !== i.status)
      .map((i) => ({
        ...b(i),
        transition: `${prev(i.number)!.status} → ${i.status}`,
      }))
    : [];
  const vanished = inp.baseline
    ? Object.keys(inp.baseline).map(Number).filter((n) => !byNumber.has(n))
    : [];

  // ---- shipped ------------------------------------------------------------
  // Done now, and not done at the baseline. With no baseline (the first run),
  // fall back to "done and touched inside the window" — approximate, and said
  // so in the coverage note.
  const shippedIssues = all.filter((i) => {
    if (!DONE.has(i.status)) return false;
    const p = prev(i.number);
    if (inp.baseline) return p ? !DONE.has(p.status) : i.createdAt >= since;
    return i.updatedAt >= since;
  }).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));

  type Bucket = {
    person: string;
    handle: string;
    items: Array<Brief & { basis: "assignee" | "author_only" }>;
    areas: ReturnType<typeof countAreas>;
    implemented: number;
    authoredOnly: number;
    _raw: Enriched[];
  };
  const buckets = new Map<string, Bucket>();
  const bucket = (handle: string) => {
    if (!buckets.has(handle)) {
      buckets.set(handle, {
        person: person(team, handle),
        handle,
        items: [],
        areas: [],
        implemented: 0,
        authoredOnly: 0,
        _raw: [],
      });
    }
    return buckets.get(handle)!;
  };
  for (const i of shippedIssues) {
    // Implementer is the assignee. Authoring a report is not shipping it; when
    // nothing names an implementer the author is credited, and marked as such.
    if (i.assignees.length) {
      for (const a of i.assignees) {
        const bk = bucket(a);
        bk.items.push({ ...b(i), basis: "assignee" });
        bk.implemented++;
        bk._raw.push(i);
      }
    } else {
      const bk = bucket(i.author ?? "unassigned");
      bk.items.push({ ...b(i), basis: "author_only" });
      bk.authoredOnly++;
      bk._raw.push(i);
    }
  }
  const byPerson = [...buckets.values()].map((bk) => {
    const { _raw, ...rest } = bk;
    return { ...rest, areas: countAreas(_raw, 6) };
  }).sort((x, y) =>
    Number(!(x.handle in team)) - Number(!(y.handle in team)) ||
    y.items.length - x.items.length
  );

  // ---- opened -------------------------------------------------------------
  const openedIssues = all.filter((i) => i.createdAt >= since)
    .sort((x, y) => y.number - x.number);
  const groups = new Map<string, Enriched[]>();
  for (const i of openedIssues) {
    groups.set(i.primary, [...(groups.get(i.primary) ?? []), i]);
  }
  const opened = {
    total: openedIssues.length,
    byArea: [...groups].map(([area, items]) => ({
      area,
      label: labelFor(area),
      count: items.length,
      authors: [...new Set(items.map((i) => person(team, i.author)))].sort(),
      items: items.map(b),
    })).sort((x, y) =>
      Number(x.area === "other") - Number(y.area === "other") ||
      y.count - x.count
    ),
  };

  // ---- stagecraft ---------------------------------------------------------
  const isSc = (i: Enriched) => i.areaList.some((a) => a.area === "stagecraft");
  const now = Date.parse(inp.windowEnd);
  const scNew = openedIssues.filter(isSc).map(b);
  const scMoved = movement.filter((m) => m.isStagecraft);
  const scOpen = all.filter((i) => isSc(i) && OPEN.has(i.status))
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
    .map((i) => ({
      ...b(i),
      ageDays: Math.floor((now - Date.parse(i.createdAt)) / 86400000),
    }));
  const stagecraft = {
    new: scNew,
    moved: scMoved,
    openItems: scOpen,
    openTotal: scOpen.length,
    quiet: scNew.length === 0 && scMoved.length === 0,
  };

  // ---- echoes: new issues on the same ground as older ones ---------------
  const df = new Map<string, number>();
  for (const i of all) {
    for (const t of keywords(i.title)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = all.length;
  const rarity = (t: string) => Math.log(N / (df.get(t) ?? 1));
  const unit = N > 2 ? Math.log(N / 2) : 1;
  const lookbackStart = new Date(Date.parse(since) - 120 * 86400000)
    .toISOString();
  const echoes = [];
  for (const i of openedIssues) {
    if (ECHO_EXCLUDED.has(i.primary)) continue;
    const kw = keywords(i.title);
    if (kw.size === 0) continue;
    const candidates = all
      .filter((c) =>
        c.number !== i.number && c.createdAt >= lookbackStart &&
        c.createdAt < since &&
        c.areaList.some((a) => a.area === i.primary)
      )
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 400);
    const matches = [];
    for (const c of candidates) {
      const shared = [...keywords(c.title)].filter((t) => kw.has(t));
      if (shared.length < 2) continue;
      const strength = shared.reduce((s, t) => s + rarity(t), 0) / unit;
      if (strength < 1.2) continue;
      matches.push({
        number: c.number,
        url: WEB_URL + c.number,
        title: c.title,
        status: c.status,
        authorPerson: person(team, c.author),
        createdAt: c.createdAt,
        sharedTerms: shared.sort((x, y) => rarity(y) - rarity(x)),
        strength: Math.round(strength * 100) / 100,
      });
    }
    if (!matches.length) continue;
    matches.sort((x, y) => y.strength - x.strength);
    echoes.push({
      issue: b(i),
      area: i.primary,
      areaLabel: labelFor(i.primary),
      priorCount: matches.length,
      topStrength: matches[0].strength,
      prior: matches.slice(0, 3),
    });
  }
  echoes.sort((x, y) => y.topStrength - x.topStrength);

  // ---- near my recent work -----------------------------------------------
  const recentStart = new Date(now - 30 * 86400000).toISOString();
  const mine = all.filter((i) =>
    (i.author === me && i.createdAt >= recentStart) ||
    (i.assignees.includes(me) && DONE.has(i.status) &&
      i.updatedAt >= recentStart)
  );
  const myAreas = new Map<string, number[]>();
  for (const i of mine) {
    for (const a of i.areaList) {
      if (ECHO_EXCLUDED.has(a.area)) continue;
      myAreas.set(a.area, [...(myAreas.get(a.area) ?? []), i.number]);
    }
  }
  const ranked = [...myAreas].sort((x, y) => y[1].length - x[1].length).slice(
    0,
    6,
  );
  const focus = new Set(
    ranked.filter(([, ns]) => ns.length >= 2).map(([a]) => a),
  );
  const connections = openedIssues
    .filter((i) => i.author !== me && i.areaList.some((a) => focus.has(a.area)))
    .slice(0, 10)
    .map((i) => ({
      issue: b(i),
      sharedAreas: i.areaList.filter((a) => focus.has(a.area)).map((a) => ({
        area: a.area,
        label: a.label,
        myIssues: (myAreas.get(a.area) ?? []).slice(0, 4),
      })),
    }));
  const mineSection = {
    recentAreas: ranked.map(([area, ns]) => ({
      area,
      label: labelFor(area),
      count: ns.length,
      issues: ns.slice(0, 8),
    })),
    focusAreas: [...focus],
    connections,
  };

  // ---- who was where ------------------------------------------------------
  const teamActivity = Object.entries(team).map(([handle, name]) => {
    const op = openedIssues.filter((i) => i.author === handle);
    const sh = shippedIssues.filter((i) => i.assignees.includes(handle));
    return {
      person: name,
      handle,
      opened: op.length,
      shipped: sh.length,
      // Areas of what they opened or shipped in the window — not of whatever
      // they happen to be assigned that was merely touched.
      topAreas: countAreas([...op, ...sh], 4),
    };
  });

  return {
    window: {
      start: inp.windowStart,
      end: inp.windowEnd,
      hours: Math.round((now - Date.parse(since)) / 360000) / 10,
      widened: inp.widened,
      firstRun: inp.baseline === null,
    },
    coverage: inp.coverage,
    tracked: all.length,
    teamActivity,
    shipped: { total: shippedIssues.length, byPerson },
    opened,
    stagecraft,
    echoes: echoes.slice(0, 10),
    mine: mineSection,
    movement,
    vanished,
  };
}

export type Digest = ReturnType<typeof buildDigest>;

/** What the next digest diffs against. */
export function baselineOf(issues: Issue[]): Baseline {
  return Object.fromEntries(
    issues.map((
      i,
    ) => [String(i.number), { status: i.status, assignees: i.assignees }]),
  );
}
