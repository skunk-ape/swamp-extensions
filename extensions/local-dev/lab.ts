/**
 * @skunk-ape/local-dev/lab — Swamp Club Lab issues in one call and one shape.
 *
 * `issues` selects by number, by status, or by what changed since a cursor, and
 * writes one record. A trimmed body says so, with its original size and the
 * exact input that returns it whole. A failed read is listed, never dropped.
 *
 * Read-only. Issue text is stored as data, for a reader to weigh, not to obey.
 */
import { z } from "npm:zod@4";
import {
  checkKey,
  type ClientOptions,
  type Detail,
  listPage,
  readIssue,
  type Row,
  type Status,
  STATUSES,
} from "./_lib/lab_client.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const BODY_CONCURRENCY = 6;
const DEFAULT_BODY_LIMIT = 2000;
const DEFAULT_MAX_ISSUES = 100;
const CURSOR_OVERLAP_MS = 5 * 60_000;

const GlobalArgsSchema = z.object({
  apiKey: z.string().min(1).meta({ sensitive: true }).optional().describe(
    "A Swamp Club API key, from a vault. Without one, only public issues can be read.",
  ),
  userAgent: z.string().default(
    "skunk-ape-local-dev/1.0 (+https://github.com/skunk-ape/swamp-extensions)",
  ),
});

const IssuesArgs = z.object({
  numbers: z.array(z.number().int().positive()).min(1).optional().describe(
    "Issues to read by number. Always one request each, whatever bodyLimit is.",
  ),
  since: z.string().optional().describe(
    "ISO time. Selects issues updated at or after it, across statuses unless `status` narrows them. To follow changes, pass the `asOf` of the latest `changes` record.",
  ),
  status: z.array(z.enum(STATUSES)).min(1).optional().describe(
    "Selects issues in these statuses, most recently updated first.",
  ),
  bodyLimit: z.number().int().min(0).nullable().default(DEFAULT_BODY_LIMIT)
    .describe(
      "Characters of body to keep per issue. 0 omits bodies, and skips their requests for issues selected by `since` or `status`. null keeps them whole.",
    ),
  maxIssues: z.number().int().min(1).max(1000).default(DEFAULT_MAX_ISSUES)
    .describe("Stop here and set `truncated`."),
});
type IssuesInput = z.infer<typeof IssuesArgs>;

const IssueSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  status: z.string(),
  type: z.string(),
  author: z.string().nullable(),
  assignees: z.array(z.string()),
  blocked: z.boolean(),
  updatedAt: z.string(),
  body: z.string().nullable(),
  bodyBytes: z.number().nullable().describe(
    "UTF-8 size of the whole body. Null when it was not read.",
  ),
  bodyTruncated: z.boolean().describe(
    "True when `body` is not the whole body, including when it is null because it was omitted or its read failed.",
  ),
});
/** One issue in a digest. `bodyTruncated` is true whenever `body` is not the whole body. */
export type DigestIssue = z.infer<typeof IssueSchema>;

const FailureSchema = z.object({
  number: z.number().nullable().describe(
    "The issue whose read failed. Null when a list page failed, so an unknown number of issues is missing.",
  ),
  error: z.string(),
});
type Failure = z.infer<typeof FailureSchema>;

const DigestSchema = z.object({
  issues: z.array(IssueSchema),
  failures: z.array(FailureSchema),
  complete: z.boolean().describe(
    "False when anything selected is missing: a failed read, or truncated.",
  ),
  truncated: z.boolean().describe("maxIssues or the page limit was reached."),
  since: z.string().nullable().describe("The `since` this read used."),
  asOf: z.string().nullable().describe(
    "The `since` for the next read: this read's own `since` when it was incomplete, so nothing is skipped. Null unless this read used `since` across all statuses. Moves the cursor only if each read chains from the last one's asOf.",
  ),
  fullBodyInput: z.object({
    numbers: z.array(z.number()),
    bodyLimit: z.null(),
    maxIssues: z.number(),
  }).nullable().describe(
    "The input that returns every incomplete body whole, to pass as JSON: --input '<this>'. Numbers in `failures` that have no row are not in it; retry those by number. Null when none is incomplete.",
  ),
});
/** The record an `issues` run writes: the issues, any failed reads, and the cursor. */
export type Digest = z.infer<typeof DigestSchema>;

const textEncoder = new TextEncoder();

function trimBody(body: string, limit: number): string {
  let end = limit;
  const last = body.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // never split a surrogate pair
  return body.slice(0, end);
}

function shape(
  row: Row,
  detail: Detail | undefined,
  bodyLimit: number | null,
): DigestIssue {
  const base = { ...row, ...detail?.row };
  if (!detail) {
    return { ...base, body: null, bodyBytes: null, bodyTruncated: true };
  }
  const bodyBytes = textEncoder.encode(detail.body).length;
  if (bodyLimit === 0 && bodyBytes > 0) {
    return { ...base, body: null, bodyBytes, bodyTruncated: true };
  }
  if (bodyLimit === null || detail.body.length <= bodyLimit) {
    return { ...base, body: detail.body, bodyBytes, bodyTruncated: false };
  }
  return {
    ...base,
    body: trimBody(detail.body, bodyLimit),
    bodyBytes,
    bodyTruncated: true,
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function mapBounded<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

/** Pages the list, newest first, until the cursor or the cap. */
async function selectRows(
  statuses: readonly Status[],
  sinceMs: number | undefined,
  cursorRead: boolean,
  capacity: number,
  known: Set<number>,
  opts: ClientOptions,
): Promise<{ rows: Row[]; truncated: boolean; failures: Failure[] }> {
  const rows = new Map<number, Row>();
  const failures: Failure[] = [];
  let previousTotal: number | undefined;
  let moved = false;
  const reportMoved = (detail: string) => {
    if (moved) return;
    moved = true;
    failures.push({
      number: null,
      error:
        `the list changed during the read (${detail}), so an issue may be missing`,
    });
  };
  let added = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    let batch: Row[];
    let received: number;
    let total: number | undefined;
    try {
      ({ rows: batch, received, total } = await listPage(
        statuses,
        offset,
        PAGE_SIZE,
        opts,
      ));
    } catch (e) {
      failures.push({
        number: null,
        error: `list at offset ${offset}: ${message(e)}`,
      });
      return { rows: [...rows.values()], truncated: false, failures };
    }
    if (batch.length < received) {
      failures.push({
        number: null,
        error: `list at offset ${offset}: ${
          received - batch.length
        } row(s) had no valid number`,
      });
    }
    // Offset paging. An issue leaving the list shifts the rows after it up, and an
    // unrelated one falls between two pages, so a total lower than the page before
    // is always reported, even if an earlier rise brings it back to where it began.
    // Without a cursor to catch up next time, so is a total that moved at all, and
    // a repeated row: an unread issue updated mid-read jumps to the top, behind the
    // reader, and the rows it passed repeat.
    if (
      total !== undefined && previousTotal !== undefined &&
      (total < previousTotal || (!cursorRead && total !== previousTotal))
    ) {
      reportMoved(`total ${previousTotal}, then ${total}`);
    }
    previousTotal = total ?? previousTotal;
    for (const row of batch) {
      if (sinceMs !== undefined && Date.parse(row.updatedAt) < sinceMs) {
        return { rows: [...rows.values()], truncated: false, failures };
      }
      if (!cursorRead && rows.has(row.number)) {
        reportMoved(`#${row.number} appeared twice`);
      }
      // An issue seen twice, or named in `numbers`, doesn't take up capacity.
      if (!rows.has(row.number) && !known.has(row.number)) {
        if (added >= capacity) {
          return { rows: [...rows.values()], truncated: true, failures };
        }
        added++;
      }
      rows.set(row.number, row);
    }
    if (received < PAGE_SIZE) {
      return { rows: [...rows.values()], truncated: false, failures };
    }
  }
  return { rows: [...rows.values()], truncated: true, failures };
}

/** Selects, reads and shapes. Input problems throw; read problems are reported. */
export async function buildDigest(
  args: {
    numbers?: number[];
    since?: string;
    status?: Status[];
    bodyLimit: number | null;
    maxIssues: number;
  },
  opts: ClientOptions,
  now: () => Date = () => new Date(),
): Promise<Digest> {
  const { since, status, bodyLimit, maxIssues } = args;
  if (!args.numbers?.length && since === undefined && !status?.length) {
    throw new Error("Name at least one of numbers, since or status.");
  }
  const sinceMs = since === undefined ? undefined : Date.parse(since);
  if (sinceMs !== undefined && Number.isNaN(sinceMs)) {
    throw new Error(`since is not a time: ${since}`);
  }

  if (opts.apiKey) await checkKey(opts);

  // Taken before the first request, so an update during the read is seen again
  // next time rather than missed. The overlap covers a local clock ahead of the
  // Lab's; a reader sees an issue twice rather than never.
  const cursor = new Date(now().getTime() - CURSOR_OVERLAP_MS).toISOString();
  const failures: Failure[] = [];
  const unique = [...new Set(args.numbers ?? [])];
  const numbers = unique.slice(0, maxIssues);
  let truncated = unique.length > numbers.length;

  let rows: Row[] = [];
  if (since !== undefined || status?.length) {
    const selected = await selectRows(
      status?.length ? status : STATUSES,
      sinceMs,
      since !== undefined && !status?.length,
      maxIssues - numbers.length,
      new Set(numbers),
      opts,
    );
    rows = selected.rows;
    truncated ||= selected.truncated;
    failures.push(...selected.failures);
  }

  const rowsByNumber = new Map(rows.map((r) => [r.number, r]));
  const toRead = bodyLimit === 0
    ? numbers
    : [...new Set([...numbers, ...rowsByNumber.keys()])];
  const details = new Map<number, Detail>();
  await mapBounded(toRead, BODY_CONCURRENCY, async (number) => {
    try {
      details.set(number, await readIssue(number, opts));
    } catch (e) {
      failures.push({ number, error: message(e) });
    }
  });
  opts.signal?.throwIfAborted(); // a cancelled run is not a run of failed reads

  // A row whose body read failed is still reported, without its body. A number
  // with neither appears only in failures.
  const issues: DigestIssue[] = [];
  for (const number of new Set([...numbers, ...rowsByNumber.keys()])) {
    const row = details.get(number)?.row ?? rowsByNumber.get(number);
    if (row) issues.push(shape(row, details.get(number), bodyLimit));
  }
  issues.sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number
  );
  failures.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  const incomplete = issues.filter((i) => i.bodyTruncated).map((i) => i.number);
  const complete = failures.length === 0 && !truncated;
  return {
    issues,
    failures,
    complete,
    truncated,
    since: since ?? null,
    // A read narrowed by status covers only those statuses, so moving the cursor
    // on it would skip changes in the others.
    asOf: since === undefined || status?.length
      ? null
      : complete
      ? cursor
      : since,
    fullBodyInput: incomplete.length
      ? {
        numbers: incomplete,
        bodyLimit: null,
        maxIssues: Math.max(DEFAULT_MAX_ISSUES, incomplete.length),
      }
      : null,
  };
}

// deno-lint-ignore no-explicit-any
type Ctx = any;

/** The `@skunk-ape/local-dev/lab` behavior type, with its one method, `issues`. */
export const behavior = {
  type: "@skunk-ape/local-dev/lab",
  version: "2026.11.04.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    digest: {
      description:
        "The issues the last `issues` run selected. Instance `changes` for a `since` read across all statuses, so other reads can't replace its cursor; `digest` otherwise.",
      schema: DigestSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    issues: {
      description:
        "Read Lab issues by number, by status, or by what changed since a cursor, into one record with bodies trimmed visibly. Bodies take one request per issue; bodyLimit 0 skips them for issues selected by since or status.",
      arguments: IssuesArgs,
      execute: async (args: IssuesInput, ctx: Ctx) => {
        ctx.logger.info(
          "Reading: {numbers} number(s), since {since}, status {status}",
          {
            numbers: args.numbers?.length ?? 0,
            since: args.since ?? "none",
            status: args.status?.join(",") ?? "none",
          },
        );
        const digest = await buildDigest(args, {
          apiKey: ctx.globalArgs.apiKey,
          userAgent: ctx.globalArgs.userAgent,
          signal: ctx.signal,
        });
        // Writing this would put an empty record where the last good one is.
        if (digest.issues.length === 0 && digest.failures.length > 0) {
          const f = digest.failures[0];
          throw new Error(
            `Nothing could be read: ${digest.failures.length} failure(s), first ${
              f.number === null ? "" : `#${f.number}: `
            }${f.error}`,
          );
        }
        if (!digest.complete) {
          ctx.logger.warning(
            "Incomplete: {failures} failed read(s), truncated {truncated}",
            { failures: digest.failures.length, truncated: digest.truncated },
          );
        }
        ctx.logger.info("{n} Lab issue(s)", { n: digest.issues.length });
        const handle = await ctx.writeResource(
          "digest",
          digest.asOf === null ? "digest" : "changes",
          digest,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
