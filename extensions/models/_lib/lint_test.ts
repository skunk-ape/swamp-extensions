import { assertEquals } from "jsr:@std/assert@1";
import { type Check, lint, splitSentences, stripNonProse } from "./lint.ts";

/** Check names fired by linting `text`, sorted. */
function checks(text: string, opts?: { maxWords?: number }): Check[] {
  return lint(text, opts).map((f) => f.check).sort();
}

Deno.test("lint: clean prose produces no findings", () => {
  assertEquals(lint("The worker retries the job. It writes one record."), []);
});

Deno.test("lint: each mechanical check fires on its own trigger", () => {
  const cases: Array<[Check, string]> = [
    ["banned-modal", "You should restart the node."],
    ["contraction", "It's not ready yet."],
    ["perfect-tense", "The migration has completed now."],
    ["ing-clause", "Set the flag, allowing growth."],
    ["semicolon", "One thing; another thing."],
    ["latin-abbrev", "Use a cache, e.g. Redis."],
    ["slop-word", "Simply use the tool."],
    ["trailing-condition", "Restart the node if it stalls."],
    ["emphasis", "Text with **bold in the middle** of it."],
  ];
  for (const [check, text] of cases) {
    const fired = checks(text);
    assertEquals(fired.includes(check), true, `${check} did not fire on: ${text}`);
  }
});

Deno.test("lint: sentence limit follows the text type", () => {
  const sentence = "word ".repeat(22).trim() + ".";
  assertEquals(lint(sentence, { textType: "descriptive" }).length, 0);
  assertEquals(lint(sentence, { textType: "procedural" })[0].check, "long-sentence");
});

Deno.test("lint: a leading condition is not a trailing condition", () => {
  assertEquals(checks("If it stalls, restart the node.").includes("trailing-condition"), false);
  assertEquals(checks("Restart the node if it stalls.").includes("trailing-condition"), true);
});

Deno.test("lint: synonym rotation fires only across a set", () => {
  assertEquals(checks("We check the value. We verify the other.").includes("synonym-rotation"), true);
  assertEquals(checks("We check the value. We check the other.").includes("synonym-rotation"), false);
});

Deno.test("lint: a short leading definition term keeps its emphasis", () => {
  assertEquals(lint("**Leading term** carries the rule."), []);
  assertEquals(lint("- **List term** carries the rule."), []);
  assertEquals(checks("**A leading term well over the five word limit** fires."), ["emphasis"]);
  assertEquals(checks("**Ends with punctuation.** fires."), ["emphasis"]);
});

Deno.test("lint: a single underscore inside a word is not italics", () => {
  assertEquals(lint("The max_delay value stays quiet."), []);
});

// Known false positive, inherited from the Python original and kept for
// fidelity: a bare dunder name reads as bold, because `__init__` satisfies the
// same delimiter rules as `__bold__`. Verified identical against
// simple_english_lint.py. Wrap dunders in backticks to silence it.
Deno.test("lint: a bare dunder name reads as bold (upstream false positive)", () => {
  assertEquals(checks("The __init__ method runs first."), ["emphasis"]);
  assertEquals(lint("The `__init__` method runs first."), []);
});

Deno.test("lint: a row of asterisks is a thematic break, not emphasis", () => {
  assertEquals(lint("Text here.\n\n* * *\n\nMore text here."), []);
});

Deno.test("stripNonProse: non-prose structure is blanked but line numbers hold", () => {
  const text = [
    "# Heading with should",
    "> Quote with should",
    "| table | should |",
    "$ echo should",
    "```",
    "code with should",
    "```",
    "Real prose with should.",
  ].join("\n");
  assertEquals(lint(text).length, 1);
  assertEquals(lint(text)[0].line, 8);
  assertEquals(stripNonProse(text).split("\n").length, 8);
});

Deno.test("stripNonProse: inline code and URLs become placeholders", () => {
  assertEquals(lint("Run `it's a should` and see https://x.com/should now."), []);
});

Deno.test("splitSentences: decimals do not split, list items do", () => {
  assertEquals(splitSentences("The value is 3.5 volts here.").length, 1);
  assertEquals(splitSentences("- first item here\n- second item here").length, 2);
});
