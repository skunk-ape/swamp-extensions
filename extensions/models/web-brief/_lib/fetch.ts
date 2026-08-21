// HTTP(S) fetching with a deny-by-default egress policy.
//
// The URL list is supplied by the thing being protected — an agent — so this is
// an SSRF surface with extra steps. Pattern-matching the URL is not a control:
// `http://evil.example` resolving to 127.0.0.1 defeats any string check. So
// every hop is resolved first and every resolved address is checked, and only
// then is the request made.

// deno-lint-ignore no-explicit-any
declare const Deno: any;

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  /** Off by default, and only for deliberately fetching an internal host. */
  allowPrivateNetworks: boolean;
  signal?: AbortSignal;
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
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const s = ip.toLowerCase().split("%")[0];
  if (s === "::1" || s === "::") return true; // loopback, unspecified
  if (s.startsWith("fe80")) return true; // link-local
  if (s.startsWith("fc") || s.startsWith("fd")) return true; // unique local
  if (s.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:127.0.0.1) — check the embedded address.
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  return false;
}

/** True when every resolved address for `host` is safe to connect to. */
export async function hostResolvesPublicly(
  host: string,
): Promise<{ ok: boolean; addresses: string[]; reason: string }> {
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

    if (!o.allowPrivateNetworks) {
      const check = await hostResolvesPublicly(current.hostname);
      if (!check.ok) {
        return {
          ...base,
          finalUrl: current.href,
          error: `refused: ${check.reason}`,
        };
      }
    }

    const timer = new AbortController();
    const abort = setTimeout(() => timer.abort(), o.timeoutMs);
    if (o.signal) {
      o.signal.addEventListener("abort", () => timer.abort(), { once: true });
    }

    let res: Response;
    try {
      res = await fetch(current.href, {
        method: "GET",
        redirect: "manual",
        signal: timer.signal,
        headers: {
          "user-agent": o.userAgent,
          accept: "text/html,text/plain,*/*",
        },
      });
    } catch (e) {
      clearTimeout(abort);
      const reason = e instanceof Error ? e.message : String(e);
      return {
        ...base,
        finalUrl: current.href,
        error: `fetch failed: ${reason}`,
      };
    }
    clearTimeout(abort);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) {
        return {
          ...base,
          finalUrl: current.href,
          status: res.status,
          error: "redirect without a location",
        };
      }
      try {
        current = new URL(location, current);
      } catch {
        return {
          ...base,
          finalUrl: current.href,
          status: res.status,
          error: "redirect to an invalid URL",
        };
      }
      continue;
    }

    const contentType = res.headers.get("content-type") ?? "";
    // Read with a byte cap rather than res.text(), so a multi-gigabyte body
    // cannot be pulled into memory before anyone notices.
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
        if (total > o.maxBytes) {
          chunks.push(
            value.slice(0, Math.max(0, value.length - (total - o.maxBytes))),
          );
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      buf.set(c, at);
      at += c.length;
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(buf);

    return {
      url: rawUrl,
      finalUrl: current.href,
      ok: res.ok,
      status: res.status,
      contentType,
      bytes: buf.length,
      body,
      error: res.ok ? "" : `HTTP ${res.status}`,
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
