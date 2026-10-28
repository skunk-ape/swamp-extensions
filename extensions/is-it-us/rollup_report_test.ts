/**
 * The rollup page, from summaries built out of real status responses, and the
 * report's handling of a failed run and a missing summary.
 *
 * Run with: ~/.swamp/deno/deno test --allow-read
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { failedStatus, parseStatuspage, rollup } from "./_lib/providers.ts";
import { render, report } from "./rollup_report.ts";

const AT = "2026-10-28T19:30:00.000Z";
const json = async (name: string) =>
  JSON.parse(
    await Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url)),
  );

const ctx = (over: Record<string, unknown>) => ({
  scope: "method" as const,
  modelType: "@skunk-ape/is-it-us",
  modelId: "m1",
  methodName: "check",
  executionStatus: "succeeded" as const,
  dataHandles: [] as Array<{ name: string; version?: number; specName?: string }>,
  dataRepository: { getContent: () => Promise.resolve(null) },
  ...over,
});

Deno.test("the page leads with a verdict and marks new incidents", async () => {
  const gh = parseStatuspage("github", await json("github_summary.json"), AT);
  const cf = parseStatuspage("cloudflare", await json("cloudflare_summary.json"), AT);
  const md = render(rollup([gh, cf, failedStatus("aws", "HTTP 503", AT)], null, AT));
  assertStringIncludes(md, "Maybe not us: 1 open incident upstream, 1 new since the last check.");
  assertStringIncludes(md, "| GitHub | operational — All Systems Operational | 0 |");
  assertStringIncludes(md, "| AWS | ⚠️ unreachable | ? |");
  assertStringIncludes(md, "| 🆕 Network Performance Issues in Ashburn, IAD | monitoring | minor |");
  assertStringIncludes(md, "Unreachable this check: aws.");
});

Deno.test("the page says so plainly when nothing is open", async () => {
  const gh = parseStatuspage("github", await json("github_summary.json"), AT);
  const md = render(rollup([gh], null, AT));
  assertStringIncludes(md, "Probably us: every provider reports no open incidents.");
});

Deno.test("execute reads the summary the run wrote", async () => {
  const cf = parseStatuspage("cloudflare", await json("cloudflare_summary.json"), AT);
  const summary = rollup([cf], null, AT);
  const out = await report.execute(ctx({
    dataHandles: [{ name: "provider-cloudflare", specName: "provider" }, { name: "summary", specName: "summary", version: 2 }],
    dataRepository: {
      getContent: (_t: string, _m: string, name: string, version?: number) =>
        Promise.resolve(
          name === "summary" && version === 2
            ? new TextEncoder().encode(JSON.stringify(summary))
            : null,
        ),
    },
  }));
  assertEquals(out.json.ok, true);
  assertEquals(out.json.newIncidentCount, 1);
  assertStringIncludes(out.markdown, "## Cloudflare");
});

Deno.test("execute reports a failed check instead of an all-clear", async () => {
  const out = await report.execute(ctx({
    executionStatus: "failed",
    errorMessage: "No status page could be read: github: HTTP 503",
  }));
  assertEquals(out.json.ok, false);
  assertStringIncludes(out.markdown, "The check failed: No status page could be read");
});

Deno.test("execute says when no summary was written", async () => {
  const out = await report.execute(ctx({}));
  assertEquals(out.json.ok, false);
  assertStringIncludes(out.markdown, "No summary was written by this run.");
});
