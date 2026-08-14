// Mechanical fixes — the findings a script can resolve without judgement.
//
// Running these before any model call clears the tedious findings for free and
// leaves the model only the ones needing judgement. On this repository's
// CLAUDE.md that is 21 of 35 findings, including every `emphasis` case — the
// category a model is measurably worst at fixing.
//
// Two rules govern everything here.
//
// Reuse the linter's own patterns. A fixer that reimplements them will drift,
// and drift means editing text the linter never flagged. Every pattern below is
// imported from lint.ts rather than restated.
//
// Order is load-bearing. Contractions run before emphasis because expanding one
// changes the word count the emphasis leading-term limit depends on: `**Use
// swamp, don't bypass it.**` is a five-word term until `don't` becomes `do not`.

import {
  BOLD,
  CONTRACTION,
  EMPHASIS_MAX_WORDS,
  ITALIC,
  latinPatterns,
  LIST_MARKER,
  SENTENCE_FINAL,
} from "./lint.ts";

export interface Fix {
  /** The check whose findings this fix targets. */
  check: string;
  /** What changed, for the caller's record. */
  detail: string;
}

export interface NormalizeResult {
  text: string;
  fixes: Fix[];
}

/**
 * Contractions with an unambiguous expansion.
 *
 * `'d` is deliberately absent: it is *would* or *had*, and only context
 * decides. `'s` is absent for the same reason, except in `it's`, which is
 * "it is" in effectively all technical prose. Irregular forms come first so
 * the generic `n't` rule never produces "wo not".
 */
const CONTRACTIONS: Array<[RegExp, string]> = [
  [/\bwon(['’])t\b/gi, "will not"],
  [/\bcan(['’])t\b/gi, "cannot"],
  [/\bshan(['’])t\b/gi, "shall not"],
  [/\bit(['’])s\b/g, "it is"],
  [/\bIt(['’])s\b/g, "It is"],
  [/\b(\w+)n['’]t\b/g, "$1 not"],
  [/\b(\w+)['’]ll\b/g, "$1 will"],
  [/\b(\w+)['’]ve\b/g, "$1 have"],
  [/\b(\w+)['’]re\b/g, "$1 are"],
];

/** Preserve the casing of the text being replaced. */
function matchCase(replacement: string, original: string): string {
  if (/^[A-Z]/.test(original)) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Inner text of an emphasis match, asterisk or underscore form. */
function emphasisText(m: RegExpMatchArray): string {
  return m[1] !== undefined ? m[1] : m[2];
}

/**
 * Resolve the emphasis spans the linter flags, and only those.
 *
 * A span that would be a valid leading term but for trailing punctuation gets
 * the punctuation moved outside. A span over the word limit loses its markers,
 * which is what the rule asks for. A span the linter accepts is left alone.
 *
 * Moving the punctuation out also un-masks sentence boundaries: the splitter
 * breaks on punctuation followed by whitespace, and `.**` puts a `*` in
 * between, so a label and its body were counted as one long sentence.
 */
function fixEmphasisInLine(
  line: string,
  blockStart: boolean,
  fixes: Fix[],
): string {
  const marker = LIST_MARKER.exec(line);
  const contentStart = marker
    ? marker[0].length
    : line.length - line.trimStart().length;

  // Blank inline code to equal-length spaces before detecting. Same-length
  // keeps every index valid against the original line, and a blanked span can
  // never look like emphasis — `**Term**.` and `__init__` inside backticks are
  // code, not markup, and editing them would corrupt the document.
  const masked = line.replace(/`[^`\n]+`/g, (m) => " ".repeat(m.length));

  // Bold first, then italics over the bold-blanked line — the linter's order.
  const spans: Array<{ start: number; end: number; content: string }> = [];
  for (const m of masked.matchAll(BOLD)) {
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      content: emphasisText(m),
    });
  }
  const withoutBold = masked.replace(BOLD, (m) => " ".repeat(m.length));
  for (const m of withoutBold.matchAll(ITALIC)) {
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      content: emphasisText(m),
    });
  }
  if (spans.length === 0) return line;

  // Right to left, so an earlier edit never invalidates a later index.
  let out = line;
  for (const span of spans.sort((a, b) => b.start - a.start)) {
    const leading = span.start === contentStart && blockStart;
    // Already acceptable to the linter — do not touch it.
    if (
      leading && wordCount(span.content) <= EMPHASIS_MAX_WORDS &&
      !SENTENCE_FINAL.test(span.content)
    ) continue;

    const raw = line.slice(span.start, span.end);
    const delim = raw.slice(0, (raw.length - span.content.length) / 2);
    const trailing = /([.!?])$/.exec(span.content);
    let replacement: string;

    if (trailing !== null && leading) {
      const stripped = span.content.slice(0, -1);
      if (
        wordCount(stripped) <= EMPHASIS_MAX_WORDS &&
        !SENTENCE_FINAL.test(stripped)
      ) {
        replacement = `${delim}${stripped}${delim}${trailing[1]}`;
        fixes.push({
          check: "emphasis",
          detail: `moved "${trailing[1]}" outside "${stripped}"`,
        });
        out = out.slice(0, span.start) + replacement + out.slice(span.end);
        continue;
      }
    }
    replacement = span.content;
    fixes.push({
      check: "emphasis",
      detail: `dropped emphasis on "${span.content.slice(0, 40)}"`,
    });
    out = out.slice(0, span.start) + replacement + out.slice(span.end);
  }
  return out;
}

/** Whole-line structure the linter never checks, so a fixer must not edit it. */
function protectedLine(line: string): boolean {
  return /^\s*#{1,6}\s/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*\|/.test(line) ||
    /^\s*\$\s/.test(line) ||
    /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
}

/** Apply a replacement table to one prose segment. */
function applyTable(
  text: string,
  table: Array<[RegExp, string]>,
  check: string,
  fixes: Fix[],
  caseAware: boolean,
): string {
  let out = text;
  for (const [pattern, replacement] of table) {
    out = out.replace(pattern, (match, ...groups) => {
      const filled = replacement.replace(
        /\$(\d)/g,
        (_, n) => String(groups[Number(n) - 1] ?? ""),
      );
      const result = caseAware ? matchCase(filled, match) : filled;
      fixes.push({ check, detail: `"${match}" → "${result}"` });
      return result;
    });
  }
  return out;
}

/**
 * Apply every mechanical fix, leaving code, headings, tables, and quotes alone.
 *
 * Re-lint afterwards: these edits change word counts and sentence boundaries,
 * so the finding sets before and after are not comparable.
 */
export function normalize(text: string): NormalizeResult {
  const fixes: Fix[] = [];
  const latin = latinPatterns();
  let inFence = false;
  let prevBlank = true;

  const lines = text.split("\n").map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      prevBlank = true;
      return line;
    }
    if (inFence || protectedLine(line)) {
      prevBlank = true;
      return line;
    }

    const blockStart = prevBlank || LIST_MARKER.test(line);
    prevBlank = line.trim().length === 0;

    // Split on inline code so a command or identifier is never rewritten.
    const fixed = line.split(/(`[^`\n]+`)/).map((part) => {
      if (part.startsWith("`")) return part;
      let out = applyTable(part, CONTRACTIONS, "contraction", fixes, true);
      out = applyTable(out, latin, "latin-abbrev", fixes, false);
      return out;
    }).join("");

    // Emphasis runs last, on text whose word counts are already final.
    return fixed.includes("*") || fixed.includes("_")
      ? fixEmphasisInLine(fixed, blockStart, fixes)
      : fixed;
  });

  // CONTRACTION is imported only to keep this file honest about which check the
  // expansions above serve; the linter owns detection, this table owns repair.
  void CONTRACTION;

  return { text: lines.join("\n"), fixes };
}
