// HTTP(S) fetching with a deny-by-default egress policy.
//
// The URL list is supplied by the thing being protected — an agent — so this is
// an SSRF surface with extra steps. Pattern-matching the URL is not a control:
// `http://evil.example` resolving to 127.0.0.1 defeats any string check. So
// every hop is resolved first and every resolved address is checked, and only
// then is the request made — to those addresses and no others.
//
// That last part is why this uses node:http rather than fetch. fetch resolves
// the name again on its own, so a DNS server answering with a zero TTL could
// hand the check a public address and the connection 127.0.0.1. node:http takes
// a `lookup` function, so the connection is pinned to the answer the check
// approved, while TLS still verifies the certificate against the hostname. It
// also never reads HTTP(S)_PROXY or /etc/hosts, either of which would be a
// second resolver the check never saw.

import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import zlib from "node:zlib";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

/** What the egress check decided about one host. */
export interface HostCheck {
  ok: boolean;
  addresses: string[];
  reason: string;
}

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  /** Off by default, and only for deliberately fetching an internal host. */
  allowPrivateNetworks: boolean;
  signal?: AbortSignal;
  /**
   * Test seam: replaces hostResolvesPublicly. Production never sets it; tests
   * use it to prove the connection goes where the check said, not where DNS
   * says.
   */
  resolve?: (host: string) => Promise<HostCheck>;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  ok: boolean;
  status: number;
  contentType: string;
  bytes: number;
  /** Raw body. HTML is left intact — brief-sanitize strips it far better. */
  body: string;
  /** Set when the fetch was refused or failed. */
  error: string;
  /**
   * True when the response looks like a JavaScript application shell rather
   * than content. See looksLikeAppShell.
   */
  renderRequired: boolean;
  truncated: boolean;
}

/**
 * Private, loopback, link-local and other non-public ranges.
 *
 * 169.254.169.254 deserves its own mention: it is the cloud metadata address on
 * AWS, GCP and Azure, and reading it is the single highest-value SSRF target
 * there is. It falls inside 169.254.0.0/16 and is therefore already covered —
 * noted here so nobody "optimises" that range away.
 */
function isBlockedIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (
    p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true; // Unparseable is not provably public.
  }
  const [a, b] = p;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 192 && b === 88 && p[2] === 99) return true; // 6to4 relay anycast
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if unparseable.
 *
 * Necessary because prefix-matching the text form does not work. The WHATWG URL
 * parser canonicalizes a host before anything here sees it, so
 * `http://[::ffff:127.0.0.1]/` arrives as `[::ffff:7f00:1]` — the dotted tail
 * is gone and a regex looking for it never fires. An earlier revision had
 * exactly that bug, and its test passed only because it called this module
 * directly with the dotted string, never through the parser that production
 * always uses. Numbers do not have spellings; parse to numbers.
 */
export function parseIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0].replace(/^\[|\]$/g, "");

  // A trailing dotted quad (::ffff:127.0.0.1, ::127.0.0.1) becomes two groups.
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = dotted[2].split(".").map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${dotted[1]}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((h) => {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return NaN;
      return parseInt(h, 16);
    });

  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some((n) => Number.isNaN(n))) return null;

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  return groups.length === 8 ? groups : null;
}

/** True when groups [from, to) are all zero. */
function isZeroRange(g: number[], from: number, to: number): boolean {
  return g.slice(from, to).every((x) => x === 0);
}

/**
 * True when an IPv6 address is not safe to connect to.
 *
 * Checked numerically against prefixes rather than against text, and the
 * embedded-IPv4 forms are unwrapped and re-checked as IPv4 so a v4 address
 * wearing a v6 costume gets the same answer as itself.
 */
function isBlockedIPv6(ip: string): boolean {
  const g = parseIPv6(ip);
  if (g === null) return true; // Unparseable is not provably public.

  const isZero = (n: number) => g.slice(0, n).every((x) => x === 0);

  if (isZero(7) && g[7] === 1) return true; // ::1/128 loopback
  if (isZero(8)) return true; // ::/128 unspecified
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (old)
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  // 2001::/32 Teredo hides the client's v4 address, obfuscated, in the low
  // groups. Decoding it buys nothing a public fetcher needs, so refuse it.
  if (g[0] === 0x2001 && g[1] === 0x0000) return true;
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if ((g[0] & 0xfffe) === 0x0100) return true; // 100::/64 discard-only

  // Forms that carry an IPv4 address inside them. Each is a way of reaching a
  // v4 destination, so each is unwrapped and judged as that destination.
  const embedded = (hi: number, lo: number) =>
    isBlockedIPv4(
      [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join("."),
    );

  // ::ffff:0:0/96 IPv4-mapped — this is the one that was exploitable.
  if (isZero(5) && g[5] === 0xffff) return embedded(g[6], g[7]);
  // ::/96 IPv4-compatible (deprecated, still routable by some stacks).
  if (isZero(6) && !(g[6] === 0 && g[7] === 0)) return embedded(g[6], g[7]);
  // 64:ff9b::/96 well-known NAT64 carries the v4 address in the last 32 bits.
  if (g[0] === 0x0064 && g[1] === 0xff9b && isZeroRange(g, 2, 6)) {
    return embedded(g[6], g[7]);
  }
  // 64:ff9b:1::/48 local-use NAT64. Where the v4 address sits depends on the
  // prefix length the operator chose (RFC 6052), which cannot be read off the
  // address — so no single position is safe to trust. Refuse the range.
  if (g[0] === 0x0064 && g[1] === 0xff9b) return true;
  // 2002::/16 6to4 carries the v4 address in the next two groups.
  if (g[0] === 0x2002) return embedded(g[1], g[2]);

  return false;
}

/** True when every resolved address for `host` is safe to connect to. */
export async function hostResolvesPublicly(
  host: string,
): Promise<HostCheck> {
  // A bare IP literal never reaches DNS, so check it directly.
  const bare = host.replace(/^\[|\]$/g, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    return isBlockedIPv4(bare)
      ? {
        ok: false,
        addresses: [bare],
        reason: `${bare} is not a public address`,
      }
      : { ok: true, addresses: [bare], reason: "" };
  }
  if (bare.includes(":")) {
    return isBlockedIPv6(bare)
      ? {
        ok: false,
        addresses: [bare],
        reason: `${bare} is not a public address`,
      }
      : { ok: true, addresses: [bare], reason: "" };
  }

  const addresses: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try {
      const found = await Deno.resolveDns(host, type);
      addresses.push(...found);
    } catch {
      // No records of this type, or resolution failed. Handled below.
    }
  }
  if (addresses.length === 0) {
    return { ok: false, addresses, reason: `${host} did not resolve` };
  }

  // Every address must be public. One private answer is enough to refuse —
  // a DNS name that returns both is a rebinding attempt, not a mistake.
  for (const addr of addresses) {
    const blocked = addr.includes(":")
      ? isBlockedIPv6(addr)
      : isBlockedIPv4(addr);
    if (blocked) {
      return {
        ok: false,
        addresses,
        reason: `${host} resolves to ${addr}, which is not a public address`,
      };
    }
  }
  return { ok: true, addresses, reason: "" };
}

/**
 * Guess whether a response is a JavaScript app shell rather than content.
 *
 * Plain HTTP fetching cannot render JavaScript, and a lot of the modern web —
 * product pages and search results especially — ships an empty shell plus a
 * bundle. Returning that silently would hand the caller an empty brief and let
 * them conclude the page had nothing on it, which is worse than an error.
 *
 * The heuristic is deliberately crude and deliberately reported rather than
 * acted on: strip tags, and if what is left is tiny while the markup is large,
 * say so.
 */
export function looksLikeAppShell(html: string): boolean {
  if (html.length < 200) return false;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Under 400 visible characters from a page of real size is a shell.
  return text.length < 400 && html.length > 2000;
}

/**
 * A `dns.lookup` stand-in that only ever answers with `addresses`.
 *
 * Handed to node:http, it makes the connection use the exact addresses the
 * egress check approved. Node calls it in both shapes — one address, or
 * `all: true` for a list — and may ask for one family only.
 */
export function pinnedLookup(addresses: string[]): LookupFunction {
  return (_host, options, callback) => {
    const want = options.family === "IPv4"
      ? 4
      : options.family === "IPv6"
      ? 6
      : Number(options.family ?? 0);
    const list = addresses
      .map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
      .filter((a) => want === 0 || a.family === want);
    if (list.length === 0) {
      const err: NodeJS.ErrnoException = new Error(
        "no approved address for this family",
      );
      err.code = "ENOTFOUND";
      callback(err, "", 0);
      return;
    }
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  };
}

/** Status, headers and a body stream, or a thrown network error. */
function openRequest(
  url: URL,
  o: {
    userAgent: string;
    signal: AbortSignal;
    lookup?: LookupFunction;
  },
): Promise<http.IncomingMessage> {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, {
      // A fresh connection per hop: a pooled socket would skip the lookup.
      agent: false,
      lookup: o.lookup,
      signal: o.signal,
      headers: {
        "user-agent": o.userAgent,
        accept: "text/html,text/plain,*/*",
        "accept-encoding": "gzip, deflate",
      },
    }, resolve);
    req.on("error", reject);
  });
}

/**
 * The decoded body stream, honouring Content-Encoding.
 *
 * node:http does not decompress, unlike fetch. The byte cap is applied after
 * decoding, so a small compressed body cannot inflate past it.
 */
function decodedBody(res: http.IncomingMessage): AsyncIterable<Uint8Array> {
  const enc = String(res.headers["content-encoding"] ?? "identity")
    .trim().toLowerCase();
  // An empty body labelled gzip is not a gzip stream, and zlib rejects it as
  // truncated. fetch treated it as empty; so does this.
  if (res.statusCode === 204 || res.headers["content-length"] === "0") {
    return res;
  }
  if (enc === "gzip" || enc === "x-gzip") return res.pipe(zlib.createGunzip());
  if (enc === "deflate") return res.pipe(zlib.createInflate());
  if (enc === "br") return res.pipe(zlib.createBrotliDecompress());
  if (enc === "identity" || enc === "") return res;
  throw new Error(`unsupported content-encoding ${enc}`);
}

/**
 * Fetch one URL, checking egress at every redirect hop.
 *
 * Redirects are followed manually. Letting fetch follow them would check the
 * first host and then follow a 302 to anywhere, which is the standard way an
 * SSRF filter gets bypassed.
 */
export async function fetchOne(
  rawUrl: string,
  o: FetchOptions,
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
    renderRequired: false,
    truncated: false,
  };

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return { ...base, error: "not a valid URL" };
  }

  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      return {
        ...base,
        finalUrl: current.href,
        error: `refused scheme ${current.protocol}`,
      };
    }

    // The connection is pinned to what the check approved. With private
    // networks allowed there is nothing to enforce, so the system resolver
    // is used as-is.
    let lookup: LookupFunction | undefined;
    if (!o.allowPrivateNetworks) {
      const check = await (o.resolve ?? hostResolvesPublicly)(
        current.hostname,
      );
      if (!check.ok) {
        return {
          ...base,
          finalUrl: current.href,
          error: `refused: ${check.reason}`,
        };
      }
      lookup = pinnedLookup(check.addresses);
    }

    // One deadline covering headers *and* body. Clearing it once the headers
    // arrive — as an earlier revision did — bounds only the handshake: a server
    // that dribbles a byte a minute then holds the connection open stalls the
    // read loop below forever. Fetches here are serial, so one such URL hangs
    // the whole method.
    const timer = new AbortController();
    const abort = setTimeout(() => timer.abort(), o.timeoutMs);
    // Removed in the finally, because this listener is attached per redirect
    // hop per URL on a signal owned by the caller. Leaving them attached piles
    // up dead listeners for the lifetime of the method.
    const onOuterAbort = () => timer.abort();
    o.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const release = () => {
      clearTimeout(abort);
      o.signal?.removeEventListener("abort", onOuterAbort);
    };

    // node:http never follows redirects, so every hop comes back here.
    let res: http.IncomingMessage;
    try {
      res = await openRequest(current, {
        userAgent: o.userAgent,
        signal: timer.signal,
        lookup,
      });
    } catch (e) {
      release();
      const reason = e instanceof Error ? e.message : String(e);
      const timedOut = timer.signal.aborted;
      return {
        ...base,
        finalUrl: current.href,
        error: o.signal?.aborted
          ? "cancelled"
          : timedOut
          ? `timed out after ${o.timeoutMs}ms`
          : `fetch failed: ${reason}`,
      };
    }

    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const location = res.headers.location;
      res.destroy();
      release();
      if (!location) {
        return {
          ...base,
          finalUrl: current.href,
          status,
          error: "redirect without a location",
        };
      }
      try {
        current = new URL(location, current);
      } catch {
        return {
          ...base,
          finalUrl: current.href,
          status,
          error: "redirect to an invalid URL",
        };
      }
      continue;
    }

    const contentType = String(res.headers["content-type"] ?? "");
    const ok = status >= 200 && status < 300;
    // Read with a byte cap rather than res.text(), so a multi-gigabyte body
    // cannot be pulled into memory before anyone notices.
    //
    // Wrapped, because this is where a mid-body connection reset lands. An
    // earlier revision left it outside the try, so a reset threw out of
    // fetchOne entirely — and since the caller writes its resource once at the
    // end, a flake on the fifteenth of twenty URLs discarded the first
    // fourteen. Every other failure here is a soft per-URL error; this one was
    // silently different.
    let body = "";
    let bytes = 0;
    let truncated = false;
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const value of decodedBody(res)) {
        total += value.length;
        if (total > o.maxBytes) {
          chunks.push(
            value.slice(0, Math.max(0, value.length - (total - o.maxBytes))),
          );
          truncated = true;
          break;
        }
        chunks.push(value);
      }
      // Leaving the loop early does not close the socket by itself.
      res.destroy();
      const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        buf.set(c, at);
        at += c.length;
      }
      bytes = buf.length;
      body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    } catch (e) {
      // A decode error leaves the socket open, and the deadline that would
      // have closed it is about to be cleared, so close it here.
      res.destroy();
      const reason = e instanceof Error ? e.message : String(e);
      const timedOut = timer.signal.aborted;
      release();
      return {
        ...base,
        finalUrl: current.href,
        status,
        contentType,
        error: o.signal?.aborted
          ? "cancelled while reading the body"
          : timedOut
          ? `timed out after ${o.timeoutMs}ms while reading the body`
          : `body read failed: ${reason}`,
      };
    }
    release();

    return {
      url: rawUrl,
      finalUrl: current.href,
      ok,
      status,
      contentType,
      bytes,
      body,
      error: ok ? "" : `HTTP ${status}`,
      renderRequired: looksLikeAppShell(body),
      truncated,
    };
  }

  return {
    ...base,
    finalUrl: current.href,
    error: `more than ${o.maxRedirects} redirects`,
  };
}
