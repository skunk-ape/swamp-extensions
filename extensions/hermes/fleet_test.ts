import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { egressShape, report, verdict } from "./fleet.ts";

Deno.test("egress shape sorts the widest first by wording", () => {
  assertEquals(egressShape(true, ["*"]), "any host");
  assertEquals(egressShape(false, ["a", "b", "c", "d"]), "4 hosts");
  assertEquals(egressShape(false, ["a"]), "1 host");
  assertEquals(egressShape(undefined, undefined), "unknown");
});

const base = { slug: "demo", displayName: "Demo", failedSteps: [] as string[] };

// The order matters: broken beats unproven beats fine.
Deno.test("verdict reports the most serious thing first", () => {
  assertEquals(verdict({ ...base }), "ok");

  assertStringIncludes(
    verdict({ ...base, failedSteps: ["verify"] }),
    "audit incomplete",
  );

  assertStringIncludes(
    verdict({
      ...base,
      status: {
        healthy: false,
        problems: ["sh.demo.gateway is not loaded"],
        services: [],
        ports: [],
      },
    }),
    "not loaded",
  );

  assertStringIncludes(
    verdict({
      ...base,
      status: { healthy: true, problems: [], services: [], ports: [] },
      verification: {
        clean: false,
        pass: 3,
        fail: 1,
        vacuous: 0,
        checks: [{
          label: "~/.ssh is unreadable",
          outcome: "FAIL",
          detail: "READ SUCCEEDED",
        }],
      },
    }),
    "~/.ssh is unreadable",
  );

  assertStringIncludes(
    verdict({
      ...base,
      status: { healthy: true, problems: [], services: [], ports: [] },
      verification: { clean: true, pass: 3, fail: 0, vacuous: 0, checks: [] },
      rendered: {
        clean: false,
        changedCount: 2,
        egress: ["*"],
        egressUnrestricted: true,
        extraFilesystemGrants: [],
        openPorts: [],
        mcps: [],
      },
    }),
    "2 generated file(s) drifted",
  );
});

Deno.test("a run with no bot steps says so rather than rendering an empty table", async () => {
  const r = await report.execute({
    scope: "workflow",
    workflowName: "bot-audit",
    workflowRunId: "x",
    workflowStatus: "succeeded",
    stepExecutions: [],
    dataRepository: { getContent: () => Promise.resolve(null) },
    logger: { info: () => {} },
  });
  assertStringIncludes(r.markdown, "nothing to report");
  assertEquals(r.json.bots, []);
});

Deno.test("a bot is reported even when its audit step failed", async () => {
  const r = await report.execute({
    scope: "workflow",
    workflowName: "bot-audit",
    workflowRunId: "x",
    workflowStatus: "failed",
    stepExecutions: [{
      jobName: "audit",
      stepName: "verify-demo",
      modelName: "demo",
      modelType: "@skunk-ape/hermes/bot",
      modelId: "id",
      methodName: "verify",
      status: "failed",
      dataHandles: [],
      globalArgs: { slug: "demo", displayName: "Demo" },
    }],
    dataRepository: { getContent: () => Promise.resolve(null) },
    logger: { info: () => {} },
  });
  assertStringIncludes(r.markdown, "demo");
  assertStringIncludes(r.markdown, "audit incomplete");
  assertEquals((r.json.bots as unknown[]).length, 1);
});

Deno.test("vacuous checks get their own section, not silence", async () => {
  const content = new TextEncoder().encode(JSON.stringify({
    clean: true,
    pass: 2,
    fail: 0,
    vacuous: 1,
    checks: [{
      label: "~/.aws is unreadable",
      outcome: "VACUOUS",
      detail: "does not exist on this host",
    }],
  }));
  const r = await report.execute({
    scope: "workflow",
    workflowName: "bot-audit",
    workflowRunId: "x",
    workflowStatus: "succeeded",
    stepExecutions: [{
      jobName: "audit",
      stepName: "verify-demo",
      modelName: "demo",
      modelType: "@skunk-ape/hermes/bot",
      modelId: "id",
      methodName: "verify",
      status: "succeeded",
      dataHandles: [{ name: "verification-demo", specName: "verification" }],
      globalArgs: { slug: "demo", displayName: "Demo" },
    }],
    dataRepository: { getContent: () => Promise.resolve(content) },
    logger: { info: () => {} },
  });
  assertStringIncludes(r.markdown, "Proved nothing");
  assertStringIncludes(r.markdown, "~/.aws is unreadable");
  assertEquals((r.json.vacuous as unknown[]).length, 1);
});
