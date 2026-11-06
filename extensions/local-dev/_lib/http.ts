// The one way this extension talks to a server: JSON, with a token if there is
// one, retries on the answers that ask for them, and each attempt on its own
// timeout. Redirects are refused rather than followed, so a token cannot be
// carried to another host, and a token never appears in an error message.

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = 1000;
const MAX_RETRY_AFTER_MS = 30_000;
const TIMEOUT_MS = 30_000;

export type HttpOptions = {
  userAgent: string;
  token?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

export type RequestSpec = {
  method?: "GET" | "POST";
  /** A JSON document to send. */
  body?: string;
  /** Which answers to try again. 429 and 503 unless this says otherwise. */
  retryable?: (res: Response) => boolean;
};

/** A server's refusal, with its status for callers that treat some differently. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function retryDelay(res: Response, attempt: number): number {
  const seconds = Number(res.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  return BACKOFF_MS * 2 ** attempt;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Sends one request, retrying as `spec` says, and returns the parsed JSON. */
export async function requestJson(
  url: string,
  opts: HttpOptions,
  spec: RequestSpec = {},
): Promise<unknown> {
  return (await requestWithHeaders(url, opts, spec)).body;
}

/** `requestJson`, for a caller that also needs what the headers say. */
export async function requestWithHeaders(
  url: string,
  opts: HttpOptions,
  spec: RequestSpec = {},
): Promise<{ body: unknown; headers: Headers }> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => abortableSleep(ms, opts.signal));
  const retryable = spec.retryable ??
    ((res: Response) => res.status === 429 || res.status === 503);
  const headers: Record<string, string> = {
    "User-Agent": opts.userAgent,
    Accept: "application/json",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (spec.body !== undefined) headers["Content-Type"] = "application/json";
  for (let attempt = 0;; attempt++) {
    // Per attempt, so waiting out a Retry-After doesn't spend the next one's time.
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeout])
      : timeout;
    const res = await f(url, {
      method: spec.method ?? "GET",
      redirect: "manual",
      headers,
      body: spec.body,
      signal,
    });
    if (
      res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)
    ) {
      await res.body?.cancel();
      throw new Error(`refused a redirect (HTTP ${res.status})`);
    }
    if (!res.ok && retryable(res) && attempt < MAX_ATTEMPTS - 1) {
      await res.body?.cancel();
      await sleep(retryDelay(res, attempt));
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new HttpError(res.status);
    }
    const text = await res.text(); // a timeout here says so, rather than "not JSON"
    try {
      return { body: JSON.parse(text), headers: res.headers };
    } catch {
      throw new Error("the response was not JSON");
    }
  }
}

/** Runs `work` over `items`, at most `limit` at a time. `work` handles its own errors. */
export async function mapBounded<T>(
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

/** An error's text, whatever was thrown. */
export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
