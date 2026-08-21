/**
 * Tests for @skunk-ape/web-brief.
 *
 * Weighted towards the egress policy, because that is the part where being
 * wrong is a vulnerability rather than a bug: the URL list comes from the agent
 * this extension exists to contain.
 *
 * Run with: ~/.swamp/deno/deno test --allow-net --allow-read
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { hostResolvesPublicly, looksLikeAppShell } from "./_lib/fetch.ts";
import { extractBriefJson } from "./web_brief.ts";

// --- egress policy -------------------------------------------------------

Deno.test("loopback is refused in every spelling", async () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
    const r = await hostResolvesPublicly(host);
    assert(!r.ok, `${host} should be refused`);
  }
});

Deno.test("RFC1918 ranges are refused", async () => {
  for (
    const host of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
    ]
  ) {
    const r = await hostResolvesPublicly(host);
    assert(!r.ok, `${host} should be refused`);
  }
});

Deno.test("the cloud metadata address is refused", async () => {
  // 169.254.169.254 is the highest-value SSRF target on AWS, GCP and Azure.
  const r = await hostResolvesPublicly("169.254.169.254");
  assert(!r.ok);
  assertStringIncludes(r.reason, "not a public address");
});

Deno.test("172.32 and 172.15 are public — the RFC1918 block is /12, not /8", async () => {
  // An off-by-one here would either open 172.16-31 or wrongly refuse a large
  // slice of the public internet.
  for (const host of ["172.15.0.1", "172.32.0.1"]) {
    const r = await hostResolvesPublicly(host);
    assert(r.ok, `${host} is public and should be allowed`);
  }
});

Deno.test("IPv4-mapped IPv6 loopback is refused", async () => {
  // ::ffff:127.0.0.1 reaches loopback while looking like an IPv6 address.
  const r = await hostResolvesPublicly("::ffff:127.0.0.1");
  assert(!r.ok);
});

Deno.test("link-local and unique-local IPv6 are refused", async () => {
  for (const host of ["fe80::1", "fd00::1", "fc00::1", "::"]) {
    const r = await hostResolvesPublicly(host);
    assert(!r.ok, `${host} should be refused`);
  }
});

Deno.test("CGNAT and multicast are refused", async () => {
  for (const host of ["100.64.0.1", "224.0.0.1", "0.0.0.0"]) {
    const r = await hostResolvesPublicly(host);
    assert(!r.ok, `${host} should be refused`);
  }
});

Deno.test("a malformed address is refused rather than assumed public", async () => {
  for (const host of ["999.1.1.1", "1.2.3", "1.2.3.4.5"]) {
    const r = await hostResolvesPublicly(host);
    assert(!r.ok, `${host} is unparseable and must not be treated as public`);
  }
});

Deno.test("a name resolving to loopback is refused", async () => {
  // The reason URL pattern-matching is not a control. localhost is the
  // portable case of a public-looking name with a private answer; the same
  // logic is what stops a DNS-rebinding host.
  const r = await hostResolvesPublicly("localhost");
  assert(!r.ok, "localhost resolves privately and must be refused");
  assertStringIncludes(r.reason, "not a public address");
});

Deno.test("a name that does not resolve is refused", async () => {
  const r = await hostResolvesPublicly("no-such-host.invalid");
  assert(!r.ok);
  assertStringIncludes(r.reason, "did not resolve");
});

// --- app-shell detection -------------------------------------------------

Deno.test("an empty JS shell is reported rather than returned as content", () => {
  const shell = `<!doctype html><html><head><title>Shop</title></head><body>
<div id="root"></div><script>${"x".repeat(5000)}</script></body></html>`;
  assert(looksLikeAppShell(shell));
});

Deno.test("a real page is not flagged as a shell", () => {
  const page = `<!doctype html><html><body><article>${
    "Real sentences about a real subject. ".repeat(60)
  }</article></body></html>`;
  assert(!looksLikeAppShell(page));
});

Deno.test("a short page is not flagged — too little to judge", () => {
  assert(!looksLikeAppShell("<html><body>Hi</body></html>"));
});

// --- summarizer output handling ------------------------------------------

Deno.test("a clean JSON reply parses", () => {
  const out = extractBriefJson('{"answer":"x","keyPoints":[]}');
  assertEquals((out as { answer: string }).answer, "x");
});

Deno.test("a fenced JSON reply parses", () => {
  const out = extractBriefJson('```json\n{"answer":"y"}\n```');
  assertEquals((out as { answer: string }).answer, "y");
});

Deno.test("prose around the object is discarded", () => {
  const out = extractBriefJson(
    'Here is the summary:\n{"answer":"z"}\nHope that helps!',
  );
  assertEquals((out as { answer: string }).answer, "z");
});

Deno.test("a reply with no JSON is an error, not a passthrough", () => {
  // Found by testing rather than guessed: a session started with `--tools ""`
  // has no capabilities, but it does not say so. It role-plays, and was
  // observed emitting literal `</function_calls>` and a fabricated tool result.
  // That text must never reach a downstream agent.
  let threw = false;
  try {
    extractBriefJson(
      "Reading the file now.\n\n</function_calls>\n\nError: File does not exist.",
    );
  } catch (e) {
    threw = true;
    assertStringIncludes(String(e), "did not return a JSON object");
  }
  assert(threw, "an unparseable reply must be refused");
});
