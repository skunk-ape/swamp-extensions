// OAuth 2.1 for COROS's official MCP server, as a public client.
//
// The server publishes RFC 8414 metadata, accepts RFC 7591 dynamic client
// registration, and requires PKCE (S256). That is the whole flow an MCP host
// runs, and nothing in it needs an MCP host: register once, send the person to
// a browser once, then refresh.
//
// This extension registers a client of its own rather than borrowing another
// host's. Refresh tokens may rotate, and two programs sharing one refresh token
// take turns invalidating each other — whichever refreshes second holds a dead
// token and reads as "signed out" for no visible reason.

import type { FetchLike } from "./mcp.ts";

export type AuthServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
};

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  /** ISO time the access token stops working. */
  expiresAt: string;
  scope: string;
};

export const DEFAULT_SCOPE = "openid offline_access mcp.tools";

/** RFC 8414 discovery against the MCP server's origin. */
export async function discover(
  mcpUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<AuthServerMetadata> {
  const origin = new URL(mcpUrl).origin;
  const tried: string[] = [];
  for (
    const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]
  ) {
    const url = origin + path;
    tried.push(url);
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      await res.body?.cancel();
      continue;
    }
    const meta = await res.json() as AuthServerMetadata;
    if (meta.authorization_endpoint && meta.token_endpoint) return meta;
  }
  throw new Error(
    `no OAuth metadata found for ${origin} (tried ${tried.join(", ")})`,
  );
}

/** RFC 7591 registration of a public client with a loopback redirect. */
export async function register(
  meta: AuthServerMetadata,
  opts: { clientName: string; redirectUri: string; scope: string },
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  if (!meta.registration_endpoint) {
    throw new Error(
      `${meta.issuer} offers no dynamic client registration endpoint`,
    );
  }
  const res = await fetchImpl(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: opts.clientName,
      redirect_uris: [opts.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: opts.scope,
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `client registration failed: HTTP ${res.status} ${body.slice(0, 300)}`,
    );
  }
  const clientId = JSON.parse(body).client_id;
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("client registration returned no client_id");
  }
  return clientId;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function authorizationUrl(
  meta: AuthServerMetadata,
  p: {
    clientId: string;
    redirectUri: string;
    scope: string;
    state: string;
    challenge: string;
    resource: string;
  },
): string {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("scope", p.scope);
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  // RFC 8707: the token is for this MCP server. The MCP authorization spec asks
  // clients to send it, so a server that scopes tokens per resource can.
  u.searchParams.set("resource", p.resource);
  return u.toString();
}

function toTokenSet(
  // deno-lint-ignore no-explicit-any
  body: any,
  previousRefreshToken: string | null,
  now: number,
): TokenSet {
  if (typeof body.access_token !== "string") {
    throw new Error("token response carried no access_token");
  }
  // A server that does not rotate omits refresh_token on refresh. Keeping the
  // old one is then correct; dropping it would sign the instance out.
  const refreshToken = body.refresh_token ?? previousRefreshToken;
  if (!refreshToken) {
    throw new Error(
      "token response carried no refresh_token — was offline_access granted?",
    );
  }
  const expiresIn = Number(body.expires_in ?? 3600);
  return {
    accessToken: body.access_token,
    refreshToken,
    expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    scope: body.scope ?? "",
  };
}

async function tokenRequest(
  meta: AuthServerMetadata,
  form: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const res = await fetchImpl(meta.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });
  const body = await res.text();
  if (!res.ok) {
    // The error body names the reason (invalid_grant, invalid_client), which
    // is the difference between "authorize again" and "this is a bug". It
    // carries no secret: the request's secrets are not echoed back.
    throw new Error(
      `token endpoint: HTTP ${res.status} ${body.slice(0, 300)}`,
    );
  }
  return JSON.parse(body);
}

export async function exchangeCode(
  meta: AuthServerMetadata,
  p: { clientId: string; code: string; redirectUri: string; verifier: string },
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<TokenSet> {
  const body = await tokenRequest(meta, {
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.verifier,
  }, fetchImpl);
  return toTokenSet(body, null, now);
}

export async function refresh(
  meta: Pick<AuthServerMetadata, "token_endpoint">,
  p: { clientId: string; refreshToken: string },
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<TokenSet> {
  const body = await tokenRequest(meta as AuthServerMetadata, {
    grant_type: "refresh_token",
    refresh_token: p.refreshToken,
    client_id: p.clientId,
  }, fetchImpl);
  return toTokenSet(body, p.refreshToken, now);
}

/** True when the access token is gone or will be within `marginMs`. */
export function needsRefresh(
  expiresAt: string,
  now = Date.now(),
  marginMs = 24 * 3600 * 1000,
): boolean {
  const t = Date.parse(expiresAt);
  return !Number.isFinite(t) || t - now < marginMs;
}

/**
 * Wait for the browser to come back to the loopback redirect.
 *
 * Binds 127.0.0.1 only. The state check is what stops another local page from
 * completing the flow with a code of its own choosing; without it, anything
 * that could make the browser hit this port could attach its COROS account to
 * this instance.
 */
export function waitForCallback(opts: {
  port: number;
  state: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    let settled = false;
    const finish = (err: Error | null, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Let the response reach the browser before the listener goes away.
      setTimeout(() => ac.abort(), 250);
      err ? reject(err) : resolve(code!);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `no browser callback within ${Math.round(opts.timeoutMs / 1000)}s`,
          ),
        ),
      opts.timeoutMs,
    );
    opts.signal?.addEventListener("abort", () => finish(new Error("aborted")));

    const page = (msg: string, status = 200) =>
      new Response(
        `<!doctype html><meta charset="utf-8"><title>swamp coros</title><p style="font:16px system-ui;margin:3em">${msg}</p>`,
        { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );

    // deno-lint-ignore no-explicit-any
    const D = (globalThis as any).Deno;
    D.serve(
      {
        hostname: "127.0.0.1",
        port: opts.port,
        signal: ac.signal,
        onListen: () => {},
      },
      (req: Request) => {
        const u = new URL(req.url);
        if (u.pathname !== "/callback") return page("Not found.", 404);
        const err = u.searchParams.get("error");
        if (err) {
          const desc = u.searchParams.get("error_description") ?? "";
          finish(new Error(`authorization refused: ${err} ${desc}`.trim()));
          return page(
            "COROS refused the authorization. You can close this tab.",
          );
        }
        if (u.searchParams.get("state") !== opts.state) {
          // Not ours. Do not finish: the real callback may still arrive.
          return page(
            "State mismatch — this callback was not for this sign-in.",
            400,
          );
        }
        const code = u.searchParams.get("code");
        if (!code) return page("No authorization code in the callback.", 400);
        finish(null, code);
        return page("Signed in to COROS. You can close this tab.");
      },
    );
  });
}
