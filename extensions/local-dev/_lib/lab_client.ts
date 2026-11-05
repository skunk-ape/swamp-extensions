// A small read-only client for the Swamp Club Lab API.
//
// GET only. The key, when there is one, goes only to the Lab: redirects are
// refused rather than followed, so it cannot be carried to another host, and it
// never appears in an error message.

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export const API_URL = "https://swamp-club.com/api/v1/lab";
export const WEB_URL = "https://swamp-club.com/lab/";
export const STATUSES = [
  "open",
  "triaged",
  "in_progress",
  "shipped",
  "closed",
] as const;
export type Status = typeof STATUSES[number];

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 1000;
const MAX_RETRY_AFTER_MS = 30_000;
const TIMEOUT_MS = 30_000;

export type ClientOptions = {
  userAgent: string;
  apiKey?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

/** A list row: everything about an issue except its body. */
export type Row = {
  number: number;
  url: string;
  title: string;
  status: string;
  type: string;
  author: string | null;
  assignees: string[];
  blocked: boolean;
  updatedAt: string;
};

export type Detail = { row: Row; body: string };

function headers(opts: ClientOptions): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": opts.userAgent,
    Accept: "application/json",
  };
  if (opts.apiKey) h.Authorization = `Bearer ${opts.apiKey}`;
  return h;
}

function retryDelay(res: Response, attempt: number): number {
  const seconds = Number(res.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  return BACKOFF_MS * 2 ** attempt;
}

async function getJson(url: string, opts: ClientOptions): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ??
    ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout;
  for (let attempt = 0;; attempt++) {
    const res = await f(url, {
      method: "GET",
      redirect: "manual",
      headers: headers(opts),
      signal,
    });
    if (
      res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)
    ) {
      await res.body?.cancel();
      throw new Error(`refused a redirect (HTTP ${res.status})`);
    }
    const retryable = res.status === 429 || res.status === 503;
    if (retryable && attempt < MAX_ATTEMPTS - 1) {
      await res.body?.cancel();
      await sleep(retryDelay(res, attempt));
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new Error("the response was not JSON");
    }
  }
}

// deno-lint-ignore no-explicit-any
export function normalizeRow(r: any): Row | null {
  const number = Number(r?.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  const assignees = (Array.isArray(r.assignees) ? r.assignees : [])
    // deno-lint-ignore no-explicit-any
    .map((a: any) => typeof a === "string" ? a : a?.username)
    .filter((u: unknown): u is string => typeof u === "string" && u.length > 0)
    .sort();
  return {
    number,
    url: WEB_URL + number,
    title: String(r.title ?? "").trim(),
    status: String(r.status ?? ""),
    type: String(r.type ?? ""),
    author: typeof r.authorUsername === "string" ? r.authorUsername : null,
    assignees,
    blocked: r.blocked === true,
    updatedAt: String(r.updatedAt ?? ""),
  };
}

/** One page of the list, most recently updated first. Spans the named statuses. */
export async function listPage(
  statuses: readonly Status[],
  offset: number,
  limit: number,
  opts: ClientOptions,
): Promise<Row[]> {
  const u = new URL(`${API_URL}/list`);
  u.searchParams.set("sort", "updated-desc");
  for (const s of statuses) u.searchParams.append("status", s);
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("offset", String(offset));
  // deno-lint-ignore no-explicit-any
  const body = await getJson(u.toString(), opts) as any;
  if (!body || !Array.isArray(body.issues)) {
    throw new Error("the list response has no issues array");
  }
  return body.issues.map(normalizeRow).filter((r: Row | null) => r !== null);
}

/** One issue with its full body. A request per issue: the list carries no bodies. */
export async function readIssue(
  number: number,
  opts: ClientOptions,
): Promise<Detail> {
  // deno-lint-ignore no-explicit-any
  const d = await getJson(`${API_URL}/issues/${number}`, opts) as any;
  const row = normalizeRow(d?.issue);
  if (!row || row.number !== number) {
    throw new Error("the response is not this issue");
  }
  return { row, body: String(d.issue.body ?? "") };
}
