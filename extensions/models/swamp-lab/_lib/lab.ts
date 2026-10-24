// The public Swamp Club Lab API. No authentication: everything here is what
// anyone can see at swamp-club.com/lab.
//
// The list endpoint returns Open issues only unless every status is named, so
// all five are. It caps a page at 500 and documents no sort order, which is
// why the corpus is deduplicated by number and its size checked against the
// `total` the server reports: offset paging over a list that grows during the
// scan can skip a record or show it twice, and a server that quietly lowered
// its page cap would otherwise look like a complete, smaller Lab.
//
// The list stopped carrying `shippedAt` and `githubPrNumber` some time before
// October 2026. Nothing here depends on them: what shipped is read from status
// changes between two corpora, not from a timestamp the server may not send.

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export const LIST_URL = "https://swamp-club.com/api/v1/lab/list";
export const DETAIL_URL = "https://swamp-club.com/api/v1/lab/issues/";
export const WEB_URL = "https://swamp-club.com/lab/";
export const STATUSES = ["open", "triaged", "in_progress", "shipped", "closed"];
const PAGE_LIMIT = 500;
const MAX_PAGES = 40;

export type Issue = {
  number: number;
  title: string;
  type: string;
  status: string;
  author: string | null;
  assignees: string[];
  blocked: boolean;
  childCount: number;
  source: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Corpus = {
  issues: Issue[];
  total: number;
  pages: number;
  duplicates: number;
  /** Seen versus reported total. Below 0.98 the corpus is incomplete. */
  coverage: number;
};

// deno-lint-ignore no-explicit-any
export function normalize(r: any): Issue | null {
  const number = Number(r?.number);
  if (!Number.isInteger(number)) return null;
  const assignees = (Array.isArray(r.assignees) ? r.assignees : [])
    // deno-lint-ignore no-explicit-any
    .map((a: any) => typeof a === "string" ? a : a?.username)
    .filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
    .sort();
  return {
    number,
    title: String(r.title ?? "").trim(),
    type: String(r.type ?? ""),
    status: String(r.status ?? ""),
    author: r.authorUsername ?? null,
    assignees,
    blocked: r.blocked === true,
    childCount: Number(r.childCount ?? 0),
    source: r.source ?? null,
    createdAt: String(r.createdAt ?? ""),
    updatedAt: String(r.updatedAt ?? ""),
  };
}

export async function fetchCorpus(opts: {
  userAgent: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  delayMs?: number;
}): Promise<Corpus> {
  const f = opts.fetchImpl ?? fetch;
  const byNumber = new Map<number, Issue>();
  let total = 0;
  let duplicates = 0;
  let pages = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const u = new URL(LIST_URL);
    for (const s of STATUSES) u.searchParams.append("status", s);
    u.searchParams.set("limit", String(PAGE_LIMIT));
    u.searchParams.set("offset", String(page * PAGE_LIMIT));
    const res = await f(u.toString(), {
      headers: {
        "User-Agent": opts.userAgent,
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Lab list: HTTP ${res.status} at offset ${page * PAGE_LIMIT}`,
      );
    }
    const body = await res.json();
    if (!body || !Array.isArray(body.issues)) {
      throw new Error(
        "Lab list: response has no issues array — the API shape changed",
      );
    }
    pages++;
    if (page === 0) total = Number(body.total ?? 0);
    for (const raw of body.issues) {
      const i = normalize(raw);
      if (!i) continue;
      if (byNumber.has(i.number)) duplicates++;
      byNumber.set(i.number, i);
    }
    if (body.issues.length < PAGE_LIMIT) break;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
  }
  const issues = [...byNumber.values()].sort((a, b) => b.number - a.number);
  return {
    issues,
    total,
    pages,
    duplicates,
    coverage: total > 0 ? issues.length / total : 0,
  };
}

export type IssueDetail = {
  number: number;
  url: string;
  title: string;
  status: string;
  body: string;
  /** Status changes with when they happened, newest last. */
  statusHistory: Array<{ at: string; from: string | null; to: string }>;
  prs: Array<{ number: number; url: string; at: string }>;
};

/** One issue's body and status history. A request per issue: use sparingly. */
export async function fetchIssue(
  number: number,
  opts: { userAgent: string; signal?: AbortSignal; fetchImpl?: FetchLike },
): Promise<IssueDetail> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(DETAIL_URL + number, {
    headers: { "User-Agent": opts.userAgent, Accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`Lab issue ${number}: HTTP ${res.status}`);
  const d = await res.json();
  const issue = d?.issue ?? {};
  // deno-lint-ignore no-explicit-any
  const events: any[] = Array.isArray(d?.events) ? d.events : [];
  return {
    number,
    url: WEB_URL + number,
    title: String(issue.title ?? ""),
    status: String(issue.status ?? ""),
    body: String(issue.body ?? ""),
    statusHistory: events
      .filter((e) => e?.type === "status_changed")
      .map((e) => ({
        at: String(e.createdAt ?? ""),
        from: e.from ?? null,
        to: String(e.to ?? ""),
      })),
    prs: events
      .filter((e) => e?.type === "pr_linked" && e.prNumber)
      .map((e) => ({
        number: Number(e.prNumber),
        url: String(e.prUrl ?? ""),
        at: String(e.createdAt ?? ""),
      })),
  };
}
