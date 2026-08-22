import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { classifyAll, extractJson, systemPrompt } from "./classify.ts";
import type { Ask } from "./classify.ts";
import type { CrawlNode } from "./help.ts";

function node(path: string[], options: string[] = [], ok = true): CrawlNode {
  return {
    path,
    ok,
    error: ok ? "" : "help produced no output",
    helpText: "",
    helpFlagUsed: "--help",
    parsed: {
      usage: "",
      subcommands: [],
      options: options.map((name) => ({
        names: [name],
        arity: 0 as const,
        valueHint: "",
        summary: "",
        source: name,
      })),
    },
  };
}

const GLOBALS = JSON.stringify({ globalOptions: {}, envScrub: ["DEMO_PAGER"] });

const PLAN = JSON.stringify({
  wrappers: [{
    segment: "safe",
    name: "demo",
    admits: { maxTier: "read-safe" },
  }],
});

/**
 * Answer globals, then each batch in order, then the alias plan.
 *
 * The plan is asked last, so a caller that scripts N batch answers gets its
 * plan reply without counting calls.
 */
function scripted(batches: string[]): Ask {
  let seen = 0;
  return (_system, _prompt) => {
    const reply = seen === 0
      ? GLOBALS
      : seen <= batches.length
      ? batches[seen - 1]
      : PLAN;
    seen++;
    return Promise.resolve(reply);
  };
}

// --- reading the reply ---------------------------------------------------

Deno.test("a bare JSON object is read", () => {
  assertEquals(extractJson(`{"a":1}`), { a: 1 });
});

Deno.test("a fenced object is read, since models add fences whatever the prompt says", () => {
  assertEquals(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assertEquals(
    extractJson('Here you go:\n```\n{"a":2}\n```\nHope that helps.'),
    { a: 2 },
  );
});

Deno.test("prose around the object does not stop it being read", () => {
  assertEquals(extractJson('Sure! {"a":3} — let me know.'), { a: 3 });
});

Deno.test("a reply with no object is an error, not an empty table", () => {
  assertThrows(
    () => extractJson("I could not classify these."),
    Error,
    "no JSON object",
  );
});

// --- the system prompt ---------------------------------------------------

Deno.test("the injection warning appears only when the classifier can reach the network", () => {
  assertStringIncludes(systemPrompt("web"), "trying to attack");
  assert(!systemPrompt("none").includes("trying to attack"));
  assertStringIncludes(systemPrompt("none"), "no tools");
});

Deno.test("both prompts forbid inventing commands and guessing arity", () => {
  for (const mode of ["none", "web"] as const) {
    assertStringIncludes(systemPrompt(mode), "Never invent a command");
    assertStringIncludes(systemPrompt(mode), "sure of its arity");
  }
});

// --- driving the batches -------------------------------------------------

const nodes = [node([]), node(["list"]), node(["delete"])];

Deno.test("a classified command carries its tier and reasoning through", async () => {
  const result = await classifyAll({
    cli: "demo",
    nodes,
    batchSize: 10,
    docsMode: "none",
    helpFlag: "--help",
    ask: scripted([
      JSON.stringify({
        commands: [
          { path: [], tier: "read-safe", why: "prints help" },
          { path: ["list"], tier: "read-safe", why: "reads only" },
          { path: ["delete"], tier: "modify", why: "removes a thing" },
        ],
      }),
    ]),
  });

  assertEquals(result.commands.length, 3);
  assertEquals(
    result.commands.find((c) => c.path[0] === "delete")?.tier,
    "modify",
  );
  assertEquals(result.envScrub, ["DEMO_PAGER"]);
  assertEquals(result.notes, []);
});

Deno.test("a command the classifier skipped is noted, and gets no entry", async () => {
  const result = await classifyAll({
    cli: "demo",
    nodes,
    batchSize: 10,
    docsMode: "none",
    helpFlag: "--help",
    ask: scripted([
      JSON.stringify({
        commands: [{ path: ["list"], tier: "read-safe", why: "reads" }],
      }),
    ]),
  });

  assertEquals(result.commands.map((c) => c.path.join(" ")), ["list"]);
  // Silence would be fail-closed but invisible, and an operator who cannot see
  // what was skipped cannot tell a careful table from an incomplete one.
  assert(
    result.notes.some((n) => n.includes("delete") && n.includes("skipped")),
  );
});

Deno.test("a command from outside the batch is discarded and noted", async () => {
  const result = await classifyAll({
    cli: "demo",
    nodes: [node([]), node(["list"])],
    batchSize: 10,
    docsMode: "none",
    helpFlag: "--help",
    ask: scripted([
      JSON.stringify({
        commands: [
          { path: [], tier: "read-safe", why: "help" },
          { path: ["list"], tier: "read-safe", why: "reads" },
          { path: ["nuke"], tier: "read-safe", why: "invented" },
        ],
      }),
    ]),
  });

  assert(!result.commands.some((c) => c.path[0] === "nuke"));
  assert(result.notes.some((n) => n.includes("nuke")));
});

Deno.test("a batch that never returns usable JSON costs its batch, not the run", async () => {
  let call = 0;
  const ask: Ask = () => {
    call++;
    if (call === 1) return Promise.resolve(GLOBALS);
    if (call <= 3) return Promise.resolve("I refuse to answer in JSON.");
    return Promise.resolve(
      JSON.stringify({
        commands: [{ path: ["delete"], tier: "modify", why: "writes" }],
      }),
    );
  };

  const result = await classifyAll({
    cli: "demo",
    nodes: [node([]), node(["list"]), node(["delete"])],
    batchSize: 2,
    docsMode: "none",
    helpFlag: "--help",
    ask,
  });

  // The first batch burned both its attempts; the second still produced a table.
  assertEquals(result.commands.map((c) => c.path.join(" ")), ["delete"]);
  assert(result.notes.some((n) => n.includes("batch failed")));
});

Deno.test("a malformed reply is retried once with the parse error quoted back", async () => {
  const prompts: string[] = [];
  let call = 0;
  const ask: Ask = (_system, prompt) => {
    prompts.push(prompt);
    call++;
    if (call === 1) return Promise.resolve(GLOBALS);
    if (call === 2) return Promise.resolve(`{"commands":[{"path":["list"]}]}`);
    return Promise.resolve(
      JSON.stringify({
        commands: [{ path: ["list"], tier: "read-safe", why: "reads" }],
      }),
    );
  };

  const result = await classifyAll({
    cli: "demo",
    nodes: [node([]), node(["list"])],
    batchSize: 10,
    docsMode: "none",
    helpFlag: "--help",
    ask,
  });

  assertEquals(result.commands.map((c) => c.path.join(" ")), ["list"]);
  assertStringIncludes(prompts[2], "could not be used");
});

Deno.test("a command whose help failed is noted and never classified", async () => {
  const result = await classifyAll({
    cli: "demo",
    nodes: [node([]), node(["broken"], [], false)],
    batchSize: 10,
    docsMode: "none",
    helpFlag: "--help",
    ask: scripted([JSON.stringify({ commands: [] })]),
  });
  assert(
    result.notes.some((n) => n.includes("no help for") && n.includes("broken")),
  );
});

Deno.test("the batch size is honoured, so a large tool is asked in pieces", async () => {
  const asked: string[] = [];
  const ask: Ask = (_system, prompt) => {
    asked.push(prompt);
    return Promise.resolve(asked.length === 1 ? GLOBALS : `{"commands":[]}`);
  };

  await classifyAll({
    cli: "demo",
    nodes: [node([]), node(["a"]), node(["b"]), node(["c"]), node(["d"])],
    batchSize: 2,
    docsMode: "none",
    helpFlag: "--help",
    ask,
  });

  // One globals call, ceil(5 / 2) batches, then one for the alias plan.
  assertEquals(asked.length, 1 + 3 + 1);
  assertStringIncludes(asked[1], "Classify each of the following 2 command(s)");
});

Deno.test("progress is reported against the number of commands, not batches", async () => {
  const seen: number[] = [];
  await classifyAll({
    cli: "demo",
    nodes: [node([]), node(["a"]), node(["b"])],
    batchSize: 2,
    docsMode: "none",
    helpFlag: "--help",
    ask: scripted([`{"commands":[]}`, `{"commands":[]}`]),
    onProgress: (done) => seen.push(done),
  });
  assertEquals(seen, [2, 3]);
});

Deno.test("no root help means no global options, and the run says so", async () => {
  const result = await classifyAll({
    cli: "demo",
    nodes: [node(["list"])],
    batchSize: 10,
    docsMode: "none",
    helpFlag: "--help",
    ask: () =>
      Promise.resolve(
        JSON.stringify({
          commands: [{ path: ["list"], tier: "read-safe", why: "reads" }],
        }),
      ),
  });
  assertEquals(result.globalOptions, {});
  assert(result.notes.some((n) => n.includes("no usable help at the root")));
});

// --- the alias plan ------------------------------------------------------

Deno.test("the proposed plan is carried through", async () => {
  const result = await classifyAll({
    cli: "demo",
    nodes: [node([]), node(["list"])],
    batchSize: 10,
    docsMode: "none",
    helpFlag: "--help",
    ask: scripted([
      JSON.stringify({
        commands: [
          { path: [], tier: "read-safe", why: "help" },
          { path: ["list"], tier: "read-safe", why: "reads" },
        ],
      }),
    ]),
  });
  assertEquals(result.wrappers.map((s) => s.segment), ["safe"]);
  assertEquals(result.wrappers[0].name, "demo");
});

Deno.test("a plan the classifier could not produce falls back to the default", async () => {
  let call = 0;
  const ask: Ask = () => {
    call++;
    if (call === 1) return Promise.resolve(GLOBALS);
    if (call === 2) {
      return Promise.resolve(
        JSON.stringify({
          commands: [{ path: ["list"], tier: "read-safe", why: "reads" }],
        }),
      );
    }
    return Promise.resolve("no plan from me");
  };

  const result = await classifyAll({
    cli: "demo",
    nodes: [node([]), node(["list"])],
    batchSize: 10,
    docsMode: "none",
    helpFlag: "--help",
    ask,
  });

  // Falling back beats shipping nothing: a review file with no aliases is a
  // run that produced no wrappers, which is not fail-closed, just useless.
  assertEquals(result.wrappers.map((s) => s.segment), [
    "help",
    "safe",
    "private",
    "write",
  ]);
  assert(result.notes.some((n) => n.includes("alias planning failed")));
});

Deno.test("an empty plan falls back too, and says so", async () => {
  const result = await classifyAll({
    cli: "demo",
    nodes: [node([]), node(["list"])],
    batchSize: 10,
    docsMode: "none",
    helpFlag: "--help",
    ask: (_s, prompt) =>
      Promise.resolve(
        prompt.includes("Classify each")
          ? JSON.stringify({
            commands: [{ path: ["list"], tier: "read-safe", why: "reads" }],
          })
          : prompt.includes("root help page")
          ? GLOBALS
          : JSON.stringify({ wrappers: [] }),
      ),
  });
  assert(result.wrappers.length > 0);
  assert(result.notes.some((n) => n.includes("proposed no aliases")));
});

Deno.test("the plan prompt shows the shape of the table, not the whole table", async () => {
  const prompts: string[] = [];
  await classifyAll({
    cli: "demo",
    nodes: [node([]), node(["list"]), node(["delete"])],
    batchSize: 10,
    docsMode: "none",
    helpFlag: "-h",
    ask: (_s, prompt) => {
      prompts.push(prompt);
      return Promise.resolve(
        prompts.length === 1 ? GLOBALS : prompts.length === 2
          ? JSON.stringify({
            commands: [
              { path: ["list"], tier: "read-safe", why: "reads" },
              { path: ["delete"], tier: "modify", why: "writes" },
            ],
          })
          : PLAN,
      );
    },
  });

  const plan = prompts[prompts.length - 1];
  assertStringIncludes(plan, "read-safe: 1");
  assertStringIncludes(plan, "modify: 1");
  assertStringIncludes(plan, "answers help with: -h");
  // Guidelines, not rules: the classifier is told what an alias is for.
  assertStringIncludes(plan, "Pinning beats permitting");
});

Deno.test("an ask that throws surfaces rather than producing a silent empty table", async () => {
  await assertRejects(
    () =>
      classifyAll({
        cli: "demo",
        nodes: [node([])],
        batchSize: 10,
        docsMode: "none",
        helpFlag: "--help",
        ask: () => Promise.reject(new Error("claude exited 1")),
      }),
    Error,
    "claude exited 1",
  );
});
