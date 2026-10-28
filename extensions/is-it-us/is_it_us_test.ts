/**
 * Parsing and new-incident detection, against real status responses saved
 * on 2026-10-28.
 *
 * Run with: ~/.swamp/deno/deno test --allow-read
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  awsRegionOf,
  decodeAwsBody,
  failedStatus,
  parseAwsEvents,
  parseStatuspage,
  providerOfId,
  rollup,
} from "./_lib/providers.ts";
import { behavior } from "./is_it_us.ts";

const AT = "2026-10-28T19:30:00.000Z";
const fixture = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);
const json = async (name: string) =>
  JSON.parse(await Deno.readTextFile(fixture(name)));
const aws = async (regions: string[] = []) =>
  parseAwsEvents(
    JSON.parse(decodeAwsBody(await Deno.readFile(fixture("aws_currentevents.utf16be.json")))),
    AT,
    regions,
  );

Deno.test("an all-clear Statuspage has no incidents", async () => {
  const s = parseStatuspage("github", await json("github_summary.json"), AT);
  assertEquals(s.ok, true);
  assertEquals(s.indicator, "none");
  assertEquals(s.incidents, []);
  assertEquals(s.description, "All Systems Operational");
});

Deno.test("Statuspage incidents are normalized, maintenance is not an incident", async () => {
  const s = parseStatuspage("cloudflare", await json("cloudflare_summary.json"), AT);
  assertEquals(s.indicator, "major");
  assertEquals(s.incidents.length, 1);
  const [i] = s.incidents;
  assertEquals(i.id, "cloudflare:snth5ero95rz");
  assertEquals(i.title, "Network Performance Issues in Ashburn, IAD");
  assertEquals(i.status, "monitoring");
  assertEquals(i.impact, "minor");
  assertEquals(i.components, ["Ashburn, United States - (IAD)"]);
  assertStringIncludes(i.latestUpdate, "monitor");
});

Deno.test("AWS feed decodes from UTF-16 with or without a BOM", async () => {
  const bytes = await Deno.readFile(fixture("aws_currentevents.utf16be.json"));
  assertEquals(bytes[0], 0xfe);
  const withBom = decodeAwsBody(bytes);
  const noBom = decodeAwsBody(bytes.subarray(2), "application/json;charset=utf-16");
  assertEquals(withBom, noBom);
  assert(withBom.startsWith("["));
  assertEquals(decodeAwsBody(new TextEncoder().encode("[]")), "[]");
});

Deno.test("AWS events map status 3 to critical and keep the latest update", async () => {
  const s = await aws();
  assertEquals(s.incidents.length, 2);
  assertEquals(s.indicator, "critical");
  const [uae] = s.incidents;
  assertEquals(uae.title, "Multiple services (UAE): Region Availability");
  assertEquals(uae.components, ["me-central-1"]);
  assertEquals(uae.startedAt, "2026-03-01T12:51:25.000Z");
  assert(uae.latestUpdate.length <= 500);
  assert(uae.latestUpdate.endsWith("…"));
});

Deno.test("AWS region filter drops events elsewhere", async () => {
  const s = await aws(["us-east-1", "global"]);
  assertEquals(s.incidents, []);
  assertEquals(s.indicator, "none");
  assertEquals((await aws(["ME-CENTRAL-1"])).incidents.length, 1);
  assertEquals(awsRegionOf("arn:aws:health:global::event/X"), "global");
  assertEquals(awsRegionOf("arn:aws:health:::event/X"), "global");
});

Deno.test("malformed bodies throw so the provider is reported unreachable", () => {
  let threw = 0;
  try { parseStatuspage("github", { status: {} }, AT); } catch { threw++; }
  try { parseAwsEvents({}, AT); } catch { threw++; }
  assertEquals(threw, 2);
});

Deno.test("first check alerts on everything open; the next only on what is new", async () => {
  const gh = parseStatuspage("github", await json("github_summary.json"), AT);
  const cf = parseStatuspage("cloudflare", await json("cloudflare_summary.json"), AT);
  const a = await aws();

  const first = rollup([gh, cf, a], null, AT);
  assertEquals(first.firstCheck, true);
  assertEquals(first.openIncidentCount, 3);
  assertEquals(first.newIncidentCount, 3);
  assertEquals(first.alertPriority, 5);
  assertStringIncludes(first.alertTitle, "Cloudflare, AWS (3 new)");
  assertStringIncludes(first.alertMessage, "https://www.cloudflarestatus.com/incidents/snth5ero95rz");

  const second = rollup([gh, cf, a], first, AT);
  assertEquals(second.firstCheck, false);
  assertEquals(second.newIncidentCount, 0);
  assertEquals(second.alertTitle, "");
  assertEquals(second.alertMessage, "");
});

Deno.test("a resolved incident is reported, and a fresh one alone sets priority", async () => {
  const cf = parseStatuspage("cloudflare", await json("cloudflare_summary.json"), AT);
  const prev = rollup([cf], null, AT);
  const now = {
    ...cf,
    incidents: [{ ...cf.incidents[0], id: "cloudflare:other", impact: "major" as const }],
  };
  const next = rollup([now], prev, AT);
  assertEquals(next.resolvedIncidentIds, ["cloudflare:snth5ero95rz"]);
  assertEquals(next.newIncidents.map((i) => i.id), ["cloudflare:other"]);
  assertEquals(next.alertPriority, 4);
});

Deno.test("a provider that blips does not re-alert when it comes back", async () => {
  const cf = parseStatuspage("cloudflare", await json("cloudflare_summary.json"), AT);
  const first = rollup([cf], null, AT);
  const blip = rollup([failedStatus("cloudflare", "timeout", AT)], first, AT);
  assertEquals(blip.failedProviders, ["cloudflare"]);
  assertEquals(blip.resolvedIncidentIds, []);
  assert(blip.seenIncidentIds.includes("cloudflare:snth5ero95rz"));
  const back = rollup([cf], blip, AT);
  assertEquals(back.newIncidentCount, 0);
});

Deno.test("a provider down for two checks running still does not re-alert", async () => {
  const cf = parseStatuspage("cloudflare", await json("cloudflare_summary.json"), AT);
  const a = await aws();
  const down = (p: "cloudflare" | "aws") => failedStatus(p, "timeout", AT);
  let s = rollup([cf, a], null, AT);
  s = rollup([down("cloudflare"), down("aws")], s, AT);
  s = rollup([down("cloudflare"), down("aws")], s, AT);
  assertEquals(s.seenIncidentIds.length, 3);
  const back = rollup([cf, a], s, AT);
  assertEquals(back.newIncidentCount, 0);
});

Deno.test("incident ids map back to their provider", () => {
  assertEquals(providerOfId("github:abc"), "github");
  assertEquals(providerOfId("cloudflare:snth5ero95rz"), "cloudflare");
  assertEquals(providerOfId("arn:aws:health:me-central-1::event/X"), "aws");
  assertEquals(providerOfId("aws:ec2:1772369485"), "aws");
  assertEquals(providerOfId("nonsense"), null);
});

// --- the method itself, with fetch stubbed ---------------------------------

type Written = { spec: string; name: string; data: Record<string, unknown> };

async function runCheck(
  respond: (url: string) => Response | Promise<Response>,
  previous: Record<string, unknown> | null = null,
  written: Written[] = [],
) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(respond(String(input instanceof Request ? input.url : input)))) as typeof fetch;
  const noop = () => {};
  try {
    const out = await behavior.methods.check.execute({}, {
      globalArgs: { providers: ["github", "cloudflare", "aws"], awsRegions: [], timeoutSeconds: 5, userAgent: "test" },
      signal: undefined,
      logger: { info: noop, warning: noop, debug: noop },
      readResource: () => Promise.resolve(previous),
      writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    });
    return { out, written };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const live = async (url: string) => {
  if (url.includes("githubstatus")) return Response.json(await json("github_summary.json"));
  if (url.includes("cloudflarestatus")) return Response.json(await json("cloudflare_summary.json"));
  return new Response(await Deno.readFile(fixture("aws_currentevents.utf16be.json")), {
    headers: { "content-type": "application/json;charset=utf-16" },
  });
};

Deno.test("check reads all three pages, AWS's UTF-16 included", async () => {
  const { out, written } = await runCheck(live);
  assertEquals(written.map((w) => w.name), ["provider-github", "provider-cloudflare", "provider-aws", "summary"]);
  assertEquals(out.dataHandles.length, 4);
  const summary = written[3].data as { openIncidentCount: number; newIncidentCount: number };
  assertEquals(summary.openIncidentCount, 3);
  assertEquals(summary.newIncidentCount, 3);
});

Deno.test("check reports one unreachable page and keeps the rest", async () => {
  const { written } = await runCheck((url) =>
    url.includes("githubstatus") ? new Response("down", { status: 503 }) : live(url)
  );
  const gh = written.find((w) => w.name === "provider-github")!.data;
  assertEquals(gh.ok, false);
  assertEquals(gh.error, "HTTP 503");
  const summary = written.find((w) => w.name === "summary")!.data;
  assertEquals(summary.failedProviders, ["github"]);
});

Deno.test("check treats a garbled body as unreachable, not as all clear", async () => {
  const { written } = await runCheck((url) =>
    url.includes("cloudflarestatus") ? new Response("<html>maintenance</html>") : live(url)
  );
  const cf = written.find((w) => w.name === "provider-cloudflare")!.data;
  assertEquals(cf.ok, false);
});

Deno.test("check throws and writes nothing when every page is unreachable", async () => {
  const written: Written[] = [];
  await assertRejects(
    () => runCheck(() => new Response("down", { status: 503 }), null, written),
    Error,
    "github: HTTP 503",
  );
  await assertRejects(
    () => runCheck(() => Promise.reject(new TypeError("dns failure")), null, written),
    Error,
    "dns failure",
  );
  assertEquals(written.length, 0);
});

Deno.test("check compares against the previous summary", async () => {
  const first = await runCheck(live);
  const prev = first.written.find((w) => w.name === "summary")!.data;
  const { written } = await runCheck(live, prev);
  assertEquals((written.find((w) => w.name === "summary")!.data).newIncidentCount, 0);
});
