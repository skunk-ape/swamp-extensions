// One person's Lab: what they shipped since the last recorded run, and what is
// still on their plate.
//
// The window works the way the digest's does — a diff between the corpus and
// a baseline the last recorded run saved — but against a baseline of its own.
// The digest's baseline belongs to whoever records digests, and a second
// recorder would take items out of their window. So two readers on different
// schedules (a 06:00 journal, an 08:00 digest) each see every change once.
//
// With no baseline yet, or with an explicit `since`, there is nothing to diff
// against. Then an issue counts as shipped in the window if its last move into
// shipped or closed happened after the window start, read from its status
// history; the list's `updatedAt` only picks the candidates, because a comment
// on an issue shipped last month also moves it.

import type { Baseline } from "./digest.ts";
import { type Issue, type IssueDetail, WEB_URL } from "./lab.ts";

const DONE = new Set(["shipped", "closed"]);
const OPEN = ["in_progress", "triaged", "open"];

export type Pr = { repo: string; number: number; url: string; at: string };

export type ShippedItem = {
  number: number;
  url: string;
  title: string;
  status: string;
  /** When it moved to shipped or closed, if the history says. */
  at: string | null;
  prs: Pr[];
};

export type PlateItem = {
  number: number;
  url: string;
  title: string;
  status: string;
  /** When it last changed status, else when it was last updated. */
  since: string;
  sinceSource: "status" | "updated";
};

const mineOf = (issues: Issue[], me: string) =>
  issues.filter((i) => i.assignees.includes(me));

/**
 * Issues assigned to `me` that may have shipped in the window. With a
 * baseline, this is the answer: the status moved into done since it was
 * taken. Without one, it is a candidate list that `confirmShipped` narrows.
 */
export function shippedCandidates(inp: {
  issues: Issue[];
  me: string;
  baseline: Baseline | null;
  windowStart: string;
}): Issue[] {
  return mineOf(inp.issues, inp.me).filter((i) => {
    if (!DONE.has(i.status)) return false;
    if (!inp.baseline) return i.updatedAt >= inp.windowStart;
    const prev = inp.baseline[String(i.number)];
    // Not in the baseline: created after it. Shipped inside the window.
    if (!prev) return i.createdAt >= inp.windowStart;
    return !DONE.has(prev.status);
  });
}

/** The last time the history moved this issue into shipped or closed. */
export function doneAt(d: IssueDetail | undefined): string | null {
  const moves = (d?.statusHistory ?? []).filter((e) => DONE.has(e.to));
  return moves.length ? moves[moves.length - 1].at : null;
}

/** The last status change in the history, if there is one. */
export function lastMove(d: IssueDetail | undefined): string | null {
  const h = d?.statusHistory ?? [];
  return h.length ? h[h.length - 1].at : null;
}

/** `swamp#3467` from a pull URL (GitHub `/pull/`, Gitea `/pulls/`); else `pr`. */
export function prOf(p: IssueDetail["prs"][number]): Pr {
  const m = p.url.match(/\/[^/]+\/([^/]+)\/pulls?\/(\d+)/);
  return { repo: m ? m[1] : "pr", number: p.number, url: p.url, at: p.at };
}

export function shippedItems(
  candidates: Issue[],
  details: Map<number, IssueDetail>,
  opts: { confirmFrom: string | null },
): ShippedItem[] {
  return candidates.flatMap((i) => {
    const d = details.get(i.number);
    const at = doneAt(d);
    // Confirming from history: a candidate whose history says it shipped
    // before the window is a late comment, not a ship. One with no history
    // to read (a failed fetch) is kept: better a repeat than a silent drop.
    if (opts.confirmFrom && at && at < opts.confirmFrom) return [];
    // A PR relinked shows up twice in the events; keep the first link.
    const byKey = new Map<string, Pr>();
    for (const p of (d?.prs ?? []).map(prOf)) {
      const key = `${p.repo}#${p.number}`;
      if (!byKey.has(key)) byKey.set(key, p);
    }
    const prs = [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at));
    return [{
      number: i.number,
      url: WEB_URL + i.number,
      title: i.title,
      status: i.status,
      at,
      prs,
    }];
  }).sort((a, b) => a.number - b.number);
}

/** Open issues assigned to `me`, in progress first, oldest-sitting first. */
export function plateCandidates(issues: Issue[], me: string): Issue[] {
  return mineOf(issues, me).filter((i) => OPEN.includes(i.status));
}

export function plateItems(
  candidates: Issue[],
  details: Map<number, IssueDetail>,
): PlateItem[] {
  return candidates.map((i) => {
    const moved = lastMove(details.get(i.number));
    return {
      number: i.number,
      url: WEB_URL + i.number,
      title: i.title,
      status: i.status,
      since: moved ?? i.updatedAt,
      sinceSource: moved ? "status" as const : "updated" as const,
    };
  }).sort((a, b) =>
    OPEN.indexOf(a.status) - OPEN.indexOf(b.status) ||
    a.since.localeCompare(b.since)
  );
}
