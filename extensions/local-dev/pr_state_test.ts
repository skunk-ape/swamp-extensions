/**
 * The promise of two types: the same PR on either forge gives the same shape and
 * the same counts. And the parts they share: names, counting and links.
 *
 * Run with: ~/.swamp/deno/deno test
 */
import { assertEquals } from "jsr:@std/assert@1.0.19";
import { forgejoReader } from "./forgejo.ts";
import { readGithub } from "./github.ts";
import type { FetchLike, HttpOptions } from "./_lib/http.ts";
import {
  absoluteLink,
  buildPrState,
  parsePrRef,
  parsePrRefs,
  summarizeChecks,
} from "./_lib/pr_state.ts";

const json = (v: unknown) => new Response(JSON.stringify(v));
const opts = (fetchImpl: FetchLike): HttpOptions => ({
  userAgent: "test",
  token: "t",
  fetchImpl,
  sleep: () => Promise.resolve(),
});

const github: FetchLike = () =>
  Promise.resolve(json({
    data: {
      p0: {
        pullRequest: {
          number: 1,
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc",
          updatedAt: "2026-11-06T12:00:00Z",
          mergeCommit: null,
          commits: {
            nodes: [{
              commit: {
                oid: "abc",
                statusCheckRollup: {
                  contexts: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "build",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                        detailsUrl: "https://ci.example/build",
                      },
                      {
                        __typename: "CheckRun",
                        name: "test",
                        status: "COMPLETED",
                        conclusion: "FAILURE",
                        detailsUrl: "https://ci.example/test",
                      },
                      {
                        __typename: "CheckRun",
                        name: "lint",
                        status: "IN_PROGRESS",
                        conclusion: null,
                        detailsUrl: null,
                      },
                      {
                        __typename: "CheckRun",
                        name: "docs",
                        status: "COMPLETED",
                        conclusion: "SKIPPED",
                        detailsUrl: null,
                      },
                    ],
                  },
                },
              },
            }],
          },
        },
      },
    },
  }));

const forgejo: FetchLike = (input) => {
  if (String(input).includes("/pulls/")) {
    return Promise.resolve(json({
      number: 1,
      html_url: "https://forge.example/o/r/pulls/1",
      state: "open",
      draft: false,
      merged: false,
      mergeable: true,
      head: { sha: "abc" },
      merge_commit_sha: null,
      updated_at: "2026-11-06T12:00:00Z",
    }));
  }
  return Promise.resolve(json({
    total_count: 4,
    statuses: [
      { context: "build", status: "success", target_url: "/ci/build" },
      { context: "test", status: "failure", target_url: "https://ci.example/test" },
      { context: "lint", status: "pending", target_url: "" },
      { context: "docs", status: "skipped", target_url: "" },
    ],
  }));
};

Deno.test("both forges write the same shape and the same counts for the same PR", async () => {
  const onGithub = await buildPrState(["o/r#1"], readGithub, opts(github));
  const onForgejo = await buildPrState(
    ["o/r#1"],
    forgejoReader("https://forge.example"),
    opts(forgejo),
  );
  const { url: _a, ...a } = onGithub.prs[0];
  const { url: _b, ...b } = onForgejo.prs[0];
  assertEquals(a, b);
  assertEquals(Object.keys(onGithub.prs[0]), Object.keys(onForgejo.prs[0]));
  assertEquals(Object.keys(onGithub), ["prs", "failures", "complete"]);
  assertEquals(Object.keys(onForgejo), ["prs", "failures", "complete"]);
  assertEquals(a.checks.total, 4);
  assertEquals(a.checks.state, "failing");
});

Deno.test("a PR name parses into its parts", () => {
  assertEquals(parsePrRef("swamp-club/swamp.x_y#3638"), {
    key: "swamp-club/swamp.x_y#3638",
    owner: "swamp-club",
    name: "swamp.x_y",
    repo: "swamp-club/swamp.x_y",
    number: 3638,
  });
  assertEquals(parsePrRef("o/r#99999999999"), null);
  assertEquals(parsePrRef("./r#1"), null);
  assertEquals(parsePrRef("o/r?x=1#1"), null);
  assertEquals(parsePrRef("o/r#01"), null);
});

Deno.test("a name given twice is read once", () => {
  assertEquals(parsePrRefs(["o/r#1", "o/r#2", "o/r#1"]).map((r) => r.number), [1, 2]);
});

Deno.test("failing outranks pending, and pending outranks passing", () => {
  const c = (bucket: "passed" | "failed" | "pending" | "skipped") => ({
    bucket,
    name: bucket,
    conclusion: bucket,
    url: null,
  });
  assertEquals(summarizeChecks([]).state, "none");
  assertEquals(summarizeChecks([c("passed"), c("skipped")]).state, "passing");
  assertEquals(summarizeChecks([c("skipped")]).state, "passing");
  assertEquals(summarizeChecks([c("passed"), c("pending")]).state, "pending");
  assertEquals(summarizeChecks([c("pending"), c("failed")]).state, "failing");
});

Deno.test("only http and https links survive", () => {
  assertEquals(absoluteLink("/a", "https://f.example"), "https://f.example/a");
  assertEquals(absoluteLink("http://x.example/a", "https://f.example"), "http://x.example/a");
  assertEquals(absoluteLink("data:text/html,x", "https://f.example"), null);
  assertEquals(absoluteLink(null, "https://f.example"), null);
});
