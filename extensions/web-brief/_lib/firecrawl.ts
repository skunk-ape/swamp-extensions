// Fetching through Firecrawl, which renders JavaScript.
//
// The plain HTTP fetcher cannot run a page's bundle, so anything that ships an
// empty shell — product listings, search results, most of the pages an agent is
// actually asked about — comes back nearly empty. Firecrawl runs the browser on
// its own infrastructure and returns markdown.
//
// Worth being clear about what that trades. It *strengthens* the process
// boundary: no browser ever runs on your machine, so a malicious page has
// nothing local to exploit. It weakens privacy: every URL the agent asks for is
// seen by a third party. Neither of those is a detail, and the choice belongs to
// whoever configures the model rather than to this file.

import type { FetchResult } from "./fetch.ts";
import { hostResolvesPublicly } from "./fetch.ts";

export interface FirecrawlOptions {
  apiKey: string;
  /** Override for a self-hosted instance. */
  apiUrl: string;
  timeoutMs: number;
  maxBytes: number;
  onlyMainContent: boolean;
  /** Off by default; see fetchOne's egress note. */
  allowPrivateNetworks: boolean;
  signal?: AbortSignal;
}

interface FirecrawlResponse {
  success?: boolean;
  error?: string;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string | string[];
      sourceURL?: string;
      url?: string;
      statusCode?: number;
      contentType?: string;
    };
  };
}

/** Firecrawl returns title as a string or an array, depending on the page. */
function firstString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

/**
 * Scrape one URL through Firecrawl.
 *
 * The egress check still runs. It is tempting to skip it — the request goes to
 * Firecrawl, not to the target, so this process never connects to a private
 * address. But Firecrawl is a general-purpose fetcher reachable from the public
 * internet, and asking it to fetch `http://169.254.169.254/` is asking a
 * third party to do the SSRF on your behalf. It would fail against *their*
 * metadata service rather than yours, which is not a reason to send it. Keeping
 * the same policy on both fetchers also means the model's egress posture does
 * not silently change with a configuration flag.
 */
export async function firecrawlOne(
  rawUrl: string,
  o: FirecrawlOptions,
): Promise<FetchResult> {
  const base: FetchResult = {
    url: rawUrl,
    finalUrl: rawUrl,
    ok: false,
    status: 0,
    contentType: "",
    bytes: 0,
    body: "",
    error: "",
    // Firecrawl runs a real browser, so a shell is rendered rather than
    // returned as a shell. This is the point of using it.
    renderRequired: false,
    truncated: false,
  };

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ...base, error: "not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ...base, error: `refused scheme ${parsed.protocol}` };
  }
  if (!o.allowPrivateNetworks) {
    const check = await hostResolvesPublicly(parsed.hostname);
    if (!check.ok) {
      return { ...base, error: `refused: ${check.reason}` };
    }
  }

  const endpoint = `${o.apiUrl.replace(/\/+$/, "")}/v2/scrape`;
  const timer = new AbortController();
  const abort = setTimeout(() => timer.abort(), o.timeoutMs);
  // Removed in release(), as in fetchOne: this runs once per URL on a signal
  // the caller owns, and a listener left behind lives as long as the method.
  const onOuterAbort = () => timer.abort();
  o.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const release = () => {
    clearTimeout(abort);
    o.signal?.removeEventListener("abort", onOuterAbort);
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      signal: timer.signal,
      headers: {
        "content-type": "application/json",
        // A self-hosted instance may run without auth, so only send the header
        // when a key is configured.
        ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}),
      },
      body: JSON.stringify({
        url: parsed.href,
        formats: ["markdown"],
        onlyMainContent: o.onlyMainContent,
        // Firecrawl's own cap, in milliseconds, kept just under ours so it
        // returns an error rather than having the connection cut from here.
        timeout: Math.max(1000, Math.min(300_000, o.timeoutMs - 2000)),
      }),
    });
  } catch (e) {
    release();
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      error: timer.signal.aborted
        ? `firecrawl timed out after ${o.timeoutMs}ms`
        : `firecrawl request failed: ${reason}`,
    };
  }

  // The deadline stays armed across the body read for the same reason as in
  // fetchOne: clearing it when the headers land bounds only the handshake.
  // The read is capped too. The envelope is JSON around the markdown, so it is
  // allowed headroom past maxBytes, but not an unbounded pull into memory.
  let text: string;
  try {
    text = await readCapped(res, responseCap(o.maxBytes));
  } catch (e) {
    release();
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      status: res.status,
      error: timer.signal.aborted
        ? `firecrawl timed out after ${o.timeoutMs}ms while reading the response`
        : `firecrawl body read failed: ${reason}`,
    };
  }
  release();
  if (!res.ok) {
    // Surface the status distinctly: 402 means credits exhausted and 429 means
    // rate limited, and both are operational conditions a caller can act on
    // rather than page-level failures.
    const hint = res.status === 402
      ? " — Firecrawl credits exhausted"
      : res.status === 429
      ? " — Firecrawl rate limit"
      : res.status === 401
      ? " — Firecrawl rejected the API key"
      : "";
    return {
      ...base,
      status: res.status,
      error: `firecrawl HTTP ${res.status}${hint}: ${text.slice(0, 300)}`,
    };
  }

  let payload: FirecrawlResponse;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ...base, error: "firecrawl returned a non-JSON body" };
  }
  if (payload.success === false || !payload.data) {
    return {
      ...base,
      error: `firecrawl: ${payload.error ?? "no data returned"}`,
    };
  }

  const markdown = payload.data.markdown ?? "";
  const meta = payload.data.metadata ?? {};
  const finalUrl = meta.sourceURL || meta.url || parsed.href;
  // Bytes, not UTF-16 code units, so maxBytesPerUrl means the same thing on
  // both fetchers.
  const encoded = new TextEncoder().encode(markdown);
  const truncated = encoded.length > o.maxBytes;
  const body = truncated
    ? new TextDecoder("utf-8", { fatal: false }).decode(
      encoded.slice(0, o.maxBytes),
    )
    : markdown;
  const bytes = Math.min(encoded.length, o.maxBytes);

  // Firecrawl reports the target page's own status in metadata. A 200 from
  // Firecrawl saying the page 404'd is not a successful fetch.
  const pageStatus = typeof meta.statusCode === "number"
    ? meta.statusCode
    : 200;
  const pageOk = pageStatus >= 200 && pageStatus < 400 &&
    body.trim().length > 0;

  return {
    url: rawUrl,
    finalUrl,
    ok: pageOk,
    status: pageStatus,
    contentType: meta.contentType ?? "text/markdown",
    bytes,
    body,
    error: pageOk
      ? ""
      : pageStatus >= 400
      ? `HTTP ${pageStatus}`
      : "firecrawl returned no content for this page",
    renderRequired: false,
    truncated,
  };
}

/**
 * Most bytes of Firecrawl response read for a page capped at `maxBytes`:
 * four times the cap, since JSON escaping can inflate markdown, plus room for
 * metadata. Exported for tests.
 */
export function responseCap(maxBytes: number): number {
  return maxBytes * 4 + 64 * 1024;
}

/** Read a response body as text, throwing once it passes `cap` bytes. */
async function readCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(`response exceeded ${cap} bytes`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/** Title from Firecrawl metadata, for the sanitizer item. Exported for tests. */
export function titleFrom(
  metadata: { title?: string | string[] } | undefined,
  fallback: string,
): string {
  const t = firstString(metadata?.title).trim();
  return t || fallback;
}
