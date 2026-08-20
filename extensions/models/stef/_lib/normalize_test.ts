import { assertEquals } from "jsr:@std/assert@1";
import { normalize } from "./normalize.ts";
import { lint } from "./lint.ts";

const MECHANICAL = ["emphasis", "latin-abbrev", "contraction"];

Deno.test("normalize: no-op on text the linter already accepts", () => {
  const clean = "The worker retries the job. It writes one record.";
  const { text, fixes } = normalize(clean);
  assertEquals(text, clean);
  assertEquals(fixes.length, 0);
});

Deno.test("normalize: moves sentence-final punctuation outside a leading term", () => {
  assertEquals(
    normalize("**Search before you build.** Then run it.").text,
    "**Search before you build**. Then run it.",
  );
});

Deno.test("normalize: drops emphasis that cannot become a leading term", () => {
  assertEquals(
    normalize("**Extension npm deps are bundled, not tracked.** More.").text,
    "Extension npm deps are bundled, not tracked. More.",
  );
  assertEquals(
    normalize("Text with **bold in the middle** of it.").text,
    "Text with bold in the middle of it.",
  );
});

Deno.test("normalize: never edits inside inline code or fences", () => {
  const code = "Use `**Term.**` and `__init__` here.";
  assertEquals(normalize(code).text, code);
  const fence = ["```", "**Term.** and don't and e.g.", "```"].join("\n");
  assertEquals(normalize(fence).text, fence);
});

Deno.test("normalize: never edits headings, quotes, tables, or shell lines", () => {
  for (
    const line of [
      "# **Term.** don't",
      "> **Term.** don't",
      "| **Term.** | don't |",
      "$ echo don't",
    ]
  ) {
    assertEquals(normalize(line).text, line, line);
  }
});

Deno.test("normalize: expands irregular contractions correctly", () => {
  assertEquals(
    normalize("It won't work and can't run.").text,
    "It will not work and cannot run.",
  );
  assertEquals(normalize("Don't do that.").text, "Do not do that.");
  assertEquals(
    normalize("They've gone and we'll see and you're here.").text,
    "They have gone and we will see and you are here.",
  );
});

Deno.test("normalize: leaves the ambiguous 'd contraction alone", () => {
  // 'd is *would* or *had* — only context decides, so the model gets it.
  assertEquals(normalize("I'd rather not.").text, "I'd rather not.");
});

Deno.test("normalize: replaces Latin abbreviations, including quoted ones", () => {
  assertEquals(
    normalize("Use a cache, e.g. Redis.").text,
    "Use a cache, for example Redis.",
  );
  // The linter matches `e.g` without its final period when another follows, so
  // a faithful fix leaves that period in place. Cosmetic, and the finding clears.
  assertEquals(
    normalize('Write "e.g." plainly.').text,
    'Write "for example." plainly.',
  );
});

Deno.test("normalize: clears every mechanical category it claims", () => {
  const draft = [
    "**Search before you build.** It's utilizing e.g. a cache.",
    "",
    "**A leading term well over the five word limit.** More text here.",
  ].join("\n");
  const after = lint(normalize(draft).text);
  for (const check of MECHANICAL) {
    assertEquals(after.filter((f) => f.check === check).length, 0, check);
  }
});

Deno.test("normalize: un-masks sentence boundaries hidden by `**Term.**`", () => {
  // `.**` puts a `*` between the period and the space, so the splitter never
  // broke there and a label plus its body counted as one long sentence.
  const draft = "**Extend, don't be clever.** " + "word ".repeat(24).trim() +
    ".";
  assertEquals(
    lint(draft).filter((f) => f.check === "long-sentence").length,
    1,
  );
  assertEquals(
    lint(normalize(draft).text).filter((f) => f.check === "long-sentence")
      .length,
    0,
  );
});
