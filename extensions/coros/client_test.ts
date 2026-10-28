/**
 * The network edges — MCP, OAuth, Training Hub — against fake fetches.
 *
 * Run with: ~/.swamp/deno/deno test --allow-read
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { callTool, decodeContent, McpAuthError, parseSse } from "./_lib/mcp.ts";
import { authorizationUrl, needsRefresh, pkce, refresh } from "./_lib/oauth.ts";
import {
  compactDetail,
  findScheduled,
  Hub,
  md5hex,
  mergeDaily,
  parseActivity,
} from "./_lib/hub.ts";

type Call = { url: string; init?: RequestInit };
function fakeFetch(respond: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = (input: string | URL, init?: RequestInit) => {
    const c = { url: String(input), init };
    calls.push(c);
    return Promise.resolve(respond(c));
  };
  return { f, calls };
}
const json = (body: unknown, status = 200, type = "application/json") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": type },
  });

// --- MCP -------------------------------------------------------------------

Deno.test("tool text is JSON-encoded once more, and is decoded", () => {
  // What mcpus.coros.com actually sends: the text item is a JSON string literal.
  const r = decodeContent([{ type: "text", text: JSON.stringify("Recovery: 98%\nLevel: Fresh") }]);
  assertEquals(r.text, "Recovery: 98%\nLevel: Fresh");
  assertEquals(r.json, null);
});

Deno.test("plain text passes through, and a JSON object is kept as json", () => {
  assertEquals(decodeContent([{ type: "text", text: "No training schedule found." }]).text, "No training schedule found.");
  const r = decodeContent([{ type: "text", text: '{"score":91}' }]);
  assertEquals(r.json, { score: 91 });
});

Deno.test("SSE bodies yield their last JSON message", () => {
  assertEquals(parseSse('event: message\ndata: {"id":1}\n\ndata: {"id":2}\n'), { id: 2 });
});

Deno.test("callTool posts JSON-RPC with the bearer token", async () => {
  const { f, calls } = fakeFetch(() =>
    json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '"ok"' }] } })
  );
  const r = await callTool({ url: "https://x/mcp", token: "T", name: "queryRecoveryStatus", args: {}, fetchImpl: f });
  assertEquals(r.text, "ok");
  const h = calls[0].init!.headers as Record<string, string>;
  assertEquals(h.Authorization, "Bearer T");
  const body = JSON.parse(calls[0].init!.body as string);
  assertEquals(body.method, "tools/call");
  assertEquals(body.params, { name: "queryRecoveryStatus", arguments: {} });
});

Deno.test("a 401 is an auth error the caller can refresh on", async () => {
  const { f } = fakeFetch(() => json({}, 401));
  await assertRejects(
    () => callTool({ url: "https://x/mcp", token: "T", name: "t", args: {}, fetchImpl: f }),
    McpAuthError,
  );
});

Deno.test("isError results are returned, not thrown, so the caller can keep the reason", async () => {
  const { f } = fakeFetch(() =>
    json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: '"date out of range"' }] } })
  );
  const r = await callTool({ url: "https://x/mcp", token: "T", name: "t", args: {}, fetchImpl: f });
  assert(r.isError);
  assertEquals(r.text, "date out of range");
});

// --- OAuth -----------------------------------------------------------------

Deno.test("PKCE challenge is the S256 of the verifier, base64url without padding", async () => {
  const { verifier, challenge } = await pkce();
  assert(/^[A-Za-z0-9_-]{43}$/.test(verifier));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const expect = btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assertEquals(challenge, expect);
});

Deno.test("the authorization URL carries PKCE, state and the resource", () => {
  const u = new URL(authorizationUrl(
    { issuer: "i", authorization_endpoint: "https://a/authorize", token_endpoint: "https://a/token" },
    { clientId: "c", redirectUri: "http://127.0.0.1:1/callback", scope: "s", state: "st", challenge: "ch", resource: "https://m/mcp" },
  ));
  assertEquals(u.searchParams.get("code_challenge_method"), "S256");
  assertEquals(u.searchParams.get("state"), "st");
  assertEquals(u.searchParams.get("resource"), "https://m/mcp");
});

Deno.test("refresh keeps the old refresh token when the server does not rotate", async () => {
  const { f, calls } = fakeFetch(() => json({ access_token: "A2", expires_in: 100 }));
  const t = await refresh({ token_endpoint: "https://a/token" }, { clientId: "c", refreshToken: "R1" }, f, 0);
  assertEquals(t.refreshToken, "R1");
  assertEquals(t.expiresAt, new Date(100_000).toISOString());
  const form = new URLSearchParams(calls[0].init!.body as string);
  assertEquals(form.get("grant_type"), "refresh_token");
  assertEquals(form.get("client_id"), "c");
});

Deno.test("refresh takes a rotated refresh token", async () => {
  const { f } = fakeFetch(() => json({ access_token: "A2", refresh_token: "R2", expires_in: 100 }));
  const t = await refresh({ token_endpoint: "https://a/token" }, { clientId: "c", refreshToken: "R1" }, f, 0);
  assertEquals(t.refreshToken, "R2");
});

Deno.test("needsRefresh within a day of expiry, or on a bad date", () => {
  const now = Date.parse("2026-01-10T00:00:00Z");
  assert(!needsRefresh("2026-01-20T00:00:00Z", now));
  assert(needsRefresh("2026-01-10T12:00:00Z", now));
  assert(needsRefresh("garbage", now));
});

// --- Training Hub ----------------------------------------------------------

Deno.test("the password is sent as unsalted lowercase MD5 hex", () => {
  assertEquals(md5hex("password"), "5f4dcc3b5aa765d61d8327deb882cf99");
});

Deno.test("hub calls carry accessToken and yfheader", async () => {
  const { f, calls } = fakeFetch(() => json({ result: "0000", data: {} }));
  await new Hub({ accessToken: "T", userId: "42", region: "us" }, f).validate();
  assertEquals(calls[0].url, "https://teamapi.coros.com/dashboard/query");
  const h = calls[0].init!.headers as Record<string, string>;
  assertEquals(h.accessToken, "T");
  assertEquals(JSON.parse(h.yfheader), { userId: "42" });
});

Deno.test("a non-0000 result is an error, and a token message is an auth error", async () => {
  const { f } = fakeFetch(() => json({ result: "1030", message: "Access token is invalid" }));
  const e = await assertRejects(() => new Hub({ accessToken: "T", userId: "1", region: "us" }, f).validate());
  // deno-lint-ignore no-explicit-any
  assertEquals((e as any).auth, true);
});

Deno.test("activity detail posts a form body, not JSON", async () => {
  const { f, calls } = fakeFetch(() => json({ result: "0000", data: { summary: {}, graphList: [1, 2] } }));
  const d = await new Hub({ accessToken: "T", userId: "1", region: "us" }, f).activityDetail("123", 100);
  assert(calls[0].init!.body instanceof URLSearchParams);
  assertEquals((calls[0].init!.headers as Record<string, string>)["Content-Type"], undefined);
  assertEquals(d.graphList, undefined);
});

Deno.test("daily metrics merge fitness fields only onto days already present", () => {
  const rows = mergeDaily(
    [
      { happenDay: 20260110, avgSleepHrv: 70, rhr: 50, trainingLoad: 80, tiredRateNew: 12, vo2max: null },
      { happenDay: "20260111", avgSleepHrv: 65, rhr: 51, trainingLoad: 0 },
    ],
    [
      { happenDay: 20260110, vo2max: 51, ltsp: 270 },
      { happenDay: 20260109, vo2max: 50 },
    ],
  );
  assertEquals(rows.map((r) => r.date), ["2026-01-10", "2026-01-11"]);
  assertEquals(rows[0].vo2max, 51);
  assertEquals(rows[0].thresholdPaceSecPerKm, 270);
  assertEquals(rows[0].fatigue, 12);
  // A zero is a value, not a missing one.
  assertEquals(rows[1].trainingLoad, 0);
});

Deno.test("activities: id kept as a string, calories to kcal, zero distance kept", () => {
  const a = parseActivity({
    labelId: 123456789012345678n.toString(),
    sportType: 102,
    startTime: 1768050000,
    totalTime: 2974,
    distance: 0,
    totalDistance: 6750,
    calorie: 377000,
  });
  assertEquals(a.labelId, "123456789012345678");
  assertEquals(a.sport, "Trail Run");
  assertEquals(a.calories, 377);
  assertEquals(a.distanceMetres, 0);
});

Deno.test("compactDetail drops series and empty lap fields", () => {
  const d = compactDetail({
    summary: { x: 1 },
    frequencyList: [1],
    lapList: [{ lapItemList: [{ distance: 1000, avgHr: 0, lapIndex: 3, name: "" }] }],
  });
  assertEquals(d.frequencyList, undefined);
  assertEquals(d.lapList[0].lapItemList[0], { distance: 1000 });
});

Deno.test("findScheduled matches by id or exact name, joined through idInPlan", () => {
  const schedule = {
    id: 99,
    entities: [
      { idInPlan: 3, planProgramId: 300, happenDay: 20260112 },
      { idInPlan: 4, happenDay: 20260112 },
    ],
    programs: [{ idInPlan: 3, name: "6 x 800m" }, { idInPlan: 4, name: "Easy" }],
  };
  assertEquals(findScheduled(schedule, { name: "6 X 800M" }), [
    { idInPlan: "3", planProgramId: "300", planId: "99", happenDay: "20260112", name: "6 x 800m" },
  ]);
  // planProgramId falls back to idInPlan, as coros-mcp does.
  assertEquals(findScheduled(schedule, { idInPlan: "4" })[0].planProgramId, "4");
});
