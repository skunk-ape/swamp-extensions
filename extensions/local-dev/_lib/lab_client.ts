// A small read-only client for the Swamp Club Lab API.
//
// GET only. The key, when there is one, goes only to the Lab: redirects are
// refused rather than followed, so it cannot be carried to another host, and it
// never appears in an error message.

import { type FetchLike, type HttpOptions, requestJson } from "./http.ts";

export type { FetchLike };

export const API_URL = "https://swamp-club.com/api/v1/lab";
export const WHOAMI_URL = "https://swamp-club.com/api/whoami";
export const WEB_URL = "https://swamp-club.com/lab/";
export const STATUSES = [
  "open",
  "triaged",
  "in_progress",
  "shipped",
  "closed",
] as const;
export type Status = typeof STATUSES[number];

export type ClientOptions = Omit<HttpOptions, "token"> & { apiKey?: string };

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

function getJson(url: string, opts: ClientOptions): Promise<unknown> {
  const { apiKey, ...rest } = opts;
  return requestJson(url, { ...rest, token: apiKey });
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
): Promise<{ rows: Row[]; received: number; total?: number }> {
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
  return {
    rows: body.issues.map(normalizeRow).filter((r: Row | null) => r !== null),
    received: body.issues.length,
    total: typeof body.total === "number" ? body.total : undefined,
  };
}

/**
 * The Lab answers a rejected key as if there were none, with 200s and public
 * data, so a bad key would otherwise read as a complete, smaller Lab. Only
 * whoami refuses it.
 */
export async function checkKey(opts: ClientOptions): Promise<void> {
  try {
    await getJson(WHOAMI_URL, opts);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`the API key could not be confirmed: ${why}`);
  }
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
  // Missing is not empty: recording "" would claim a whole body we never saw.
  if (d.issue.body === undefined) throw new Error("the response has no body");
  return { row, body: String(d.issue.body ?? "") };
}
