import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  addUsage,
  askArgv,
  askCommandOptions,
  parseAskEnvelope,
  zeroUsage,
} from "./ask.ts";

// --- ask argv ---------------------------------------------------------------
//
// The classifier's model is a cost and a capability decision the operator
// makes, so the argv it spawns is visible: an empty model passes no --model
// flag, which is how the session inherits the caller's Claude Code default.

Deno.test("an empty model inherits the caller's Claude Code default", () => {
  const argv = askArgv({ model: "", docsMode: "none" }, "system text");
  assert(!argv.includes("--model"));
  assertEquals(argv[0], "-p");
  assert(argv.includes("system text"));
});

Deno.test("a chosen model is pinned with --model", () => {
  const argv = askArgv({ model: "claude-sonnet-5", docsMode: "none" }, "s");
  assertEquals(argv[argv.indexOf("--model") + 1], "claude-sonnet-5");
});

Deno.test("docs mode decides the tool grant", () => {
  const web = askArgv({ model: "", docsMode: "web" }, "s");
  const none = askArgv({ model: "", docsMode: "none" }, "s");
  assert(web.includes("--allowedTools"));
  assert(none.includes("--disallowedTools"));
});

Deno.test("every ask requests the JSON envelope, whatever else is set", () => {
  for (const model of ["", "claude-haiku-4-5-20251001"]) {
    for (const docsMode of ["none", "web"] as const) {
      const argv = askArgv({ model, docsMode }, "s");
      assertEquals(argv[argv.indexOf("--output-format") + 1], "json");
    }
  }
});

// ---------------------------------------------------------------------------
// parseAskEnvelope
//
// The one place that interprets what a model session returned. It is pure so
// these run without spawning anything.

function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"commands":[]}',
    total_cost_usd: 0.0217566,
    usage: {
      input_tokens: 10,
      output_tokens: 114,
      cache_read_input_tokens: 12206,
      cache_creation_input_tokens: 9506,
    },
    modelUsage: { "claude-haiku-4-5-20251001": {} },
    ...over,
  });
}

Deno.test("a successful envelope yields the reply text and its cost", () => {
  const { text, usage } = parseAskEnvelope(envelope());
  assertEquals(text, '{"commands":[]}');
  assertEquals(usage.input, 10);
  assertEquals(usage.output, 114);
  assertEquals(usage.cacheRead, 12206);
  assertEquals(usage.cacheCreation, 9506);
  assertEquals(usage.costUsd, 0.0217566);
  assertEquals(usage.models, ["claude-haiku-4-5-20251001"]);
});

Deno.test("the reply text is trimmed, since the parser is fed it directly", () => {
  const { text } = parseAskEnvelope(envelope({ result: "  {}  \n" }));
  assertEquals(text, "{}");
});

Deno.test("output that is not JSON is refused, never treated as the answer", () => {
  // The failure this guards: a CLI that stops emitting an envelope would
  // otherwise have its raw stdout parsed as a classification.
  assertThrows(
    () => parseAskEnvelope("here is your answer"),
    Error,
    "did not return a JSON envelope",
  );
});

Deno.test("a JSON value that is not an object is refused", () => {
  assertThrows(() => parseAskEnvelope("[1,2,3]"), Error, "not an object");
});

Deno.test("an envelope reporting failure throws with the reason", () => {
  assertThrows(
    () =>
      parseAskEnvelope(
        envelope({ is_error: true, result: "credit balance too low" }),
      ),
    Error,
    "credit balance too low",
  );
});

Deno.test("a non-success subtype is a failure even without is_error", () => {
  assertThrows(
    () => parseAskEnvelope(envelope({ subtype: "error_max_turns" })),
    Error,
    "error_max_turns",
  );
});

Deno.test("an envelope with no result text is refused", () => {
  assertThrows(() => parseAskEnvelope(envelope({ result: "   " })), Error);
});

Deno.test("missing usage counts as zero rather than throwing", () => {
  // Usage is for reporting, not for deciding anything, so its absence must not
  // cost a classification that otherwise succeeded.
  const { text, usage } = parseAskEnvelope(
    envelope({ usage: undefined, total_cost_usd: undefined }),
  );
  assertEquals(text, '{"commands":[]}');
  assertEquals(usage.input, 0);
  assertEquals(usage.costUsd, 0);
});

Deno.test("a missing modelUsage leaves the model list empty, not wrong", () => {
  const { usage } = parseAskEnvelope(envelope({ modelUsage: undefined }));
  assertEquals(usage.models, []);
});

Deno.test("usage sums across calls and keeps each model once", () => {
  const a = parseAskEnvelope(envelope()).usage;
  const b = parseAskEnvelope(
    envelope({ modelUsage: { "claude-sonnet-5": {} } }),
  ).usage;
  const total = addUsage(addUsage(zeroUsage(), a), b);
  assertEquals(total.input, 20);
  assertEquals(total.cacheCreation, 19012);
  assertEquals(total.models, [
    "claude-haiku-4-5-20251001",
    "claude-sonnet-5",
  ]);
});

// --- the spawn's environment and working directory --------------------------
//
// Two claims about a classify run that changes routing or working directory,
// both worth asserting because getting either wrong is silent. An override
// must reach the child and nothing else — putting ANTHROPIC_BASE_URL in the
// host's environment would move the caller's own Claude Code session onto the
// proxy — and the child must not run somewhere that makes it read a CLAUDE.md.

Deno.test("an override is handed to the child and the host is untouched", () => {
  const before = Deno.env.get("ANTHROPIC_BASE_URL");
  const { env } = askCommandOptions(
    {
      model: "",
      docsMode: "none",
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000" },
    },
    "s",
  );
  assertEquals(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4000");
  assertEquals(Deno.env.get("ANTHROPIC_BASE_URL"), before);
});

Deno.test("the override object is a copy, so the caller's map cannot be edited", () => {
  const mine = { ANTHROPIC_AUTH_TOKEN: "t" };
  const { env } = askCommandOptions(
    { model: "", docsMode: "none", env: mine },
    "s",
  );
  env.ANTHROPIC_AUTH_TOKEN = "changed";
  assertEquals(mine.ANTHROPIC_AUTH_TOKEN, "t");
});

Deno.test("no override means an empty map, which Deno merges as no change", () => {
  const { env } = askCommandOptions({ model: "", docsMode: "none" }, "s");
  assertEquals(env, {});
});

Deno.test("a working directory is passed through when one is set", () => {
  const { cwd } = askCommandOptions(
    { model: "", docsMode: "none", cwd: "/tmp/fka-work" },
    "s",
  );
  assertEquals(cwd, "/tmp/fka-work");
});

Deno.test("an empty working directory is omitted rather than passed as ''", () => {
  const opts = askCommandOptions({ model: "", docsMode: "none", cwd: "" }, "s");
  assert(!("cwd" in opts));
});
