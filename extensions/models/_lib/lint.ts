// Simple English linter — a TypeScript port of simple_english_lint.py.
//
// The rule set is ASD-STE100 Simplified Technical English, adopted as-is. These
// are the eleven mechanical checks a script can decide. Everything a script
// cannot judge — active voice, nominalisation, jargon, paragraph shape, overall
// clarity — is left to the reason-checked guidance in the skill prose.
//
// Ported to TypeScript from the MIT-licensed simple_english_lint.py by AminBlg;
// see LICENSE at the repository root for the original copyright and terms.
// Behavior matches the original check-for-check and line-for-line.

/** Word limits per text type. Procedural is instructions; descriptive is prose. */
export const LIMITS = { procedural: 20, descriptive: 25 } as const;
export type TextType = keyof typeof LIMITS;
export const DEFAULT_TYPE: TextType = "descriptive";

/** A leading definition term keeps its emphasis up to this many words. */
const EMPHASIS_MAX_WORDS = 5;

/** Longest sentence preview echoed back in a finding. */
const PREVIEW_CHARS = 60;

const LATIN_ABBREVS: Array<[string, string]> = [
  ["e.g.", "for example"],
  ["i.e.", "that is"],
  ["etc.", "and so on"],
];

/** Synonym sets: using more than one term from a set in one document is flagged. */
const ROTATION_SETS: Array<[string, RegExp]> = [
  ["check", /\b(check|verify|confirm|validate|ensure)\w*\b/gi],
  ["config", /\b(config|configuration|settings)\b/gi],
];

// --- Preprocessing patterns -------------------------------------------------

const SENTENCE_BOUNDARY = /(?<=[.!?:])\s+|\n[ \t]*\n|\n(?=[ \t]*(?:[-*+]|\d+[.)])[ \t])/g;
const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^\s*#{1,6}\s/;
const BLOCKQUOTE = /^\s*>/;
const TABLE_ROW = /^\s*\|/;
const SHELL_PROMPT = /^\s*\$\s/;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const INLINE_CODE = /`[^`\n]+`/g;
const URL = /https?:\/\/\S+/g;

// --- Check patterns ---------------------------------------------------------

const CONTRACTION = /\b\w+(?:n['’]t|['’]ll|['’]re|['’]ve|['’]d)\b|\bit['’]s\b|\byou['’]re\b/gi;
const BANNED_MODAL = /\b(?:should|would|may|might|could)\b/gi;
const PERFECT = /\b(?:has|have|had)\s+been\b|\b(?:has|have)\s+\w+ed\b/gi;
const ING_CLAUSE =
  /,\s*(?:mak|allow|enabl|ensur|highlight|creat|provid|offer|help|reduc|improv|lead|caus|result)ing\b/gi;
const SEMICOLON = /;/g;
const SLOP =
  /\b(?:simply|seamlessly|effortlessly|robust|leverag\w*|utiliz\w*|comprehensive|powerful|blazingly|streamlin\w*|facilitat\w*|performant|plethora|myriad|delve|crucial|pivotal)\b/gi;
const TRAILING_COND = /\w[^.!?\n]{3,}\s(?:if|when)\b\s/i;
const STARTS_CONDITION = /^(?:if|when)\b/i;
const BOLD = /\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g;
const ITALIC =
  /(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])/g;
const SENTENCE_FINAL = /[.!?]/;

/** The eleven check names, in the order the linter reports them. */
export const CHECKS = [
  "long-sentence",
  "contraction",
  "banned-modal",
  "perfect-tense",
  "ing-clause",
  "semicolon",
  "latin-abbrev",
  "slop-word",
  "trailing-condition",
  "synonym-rotation",
  "emphasis",
] as const;
export type Check = typeof CHECKS[number];

export interface Finding {
  line: number;
  check: Check;
  message: string;
}

// --- Helpers ----------------------------------------------------------------

/** 1-based line number of the character at `index`. */
function lineOf(text: string, index: number): number {
  let count = 0;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") count++;
  }
  return count + 1;
}

/** Python's str.split() — split on any whitespace run, dropping empties. */
function words(s: string): string[] {
  return s.split(/\s+/).filter((w) => w.length > 0);
}

/** Collapse whitespace and truncate a sentence for a one-line report. */
function preview(sentence: string): string {
  const collapsed = words(sentence).join(" ");
  if (collapsed.length <= PREVIEW_CHARS) return collapsed;
  return collapsed.slice(0, PREVIEW_CHARS - 1).replace(/\s+$/, "") + "…";
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove everything that is not prose the author wrote, keeping line numbers.
 *
 * Whole-line structure becomes an empty line; inline code and URLs become
 * placeholder words. No newline is added or removed, so a reported line number
 * still points at the original text.
 */
export function stripNonProse(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    if (
      inFence ||
      HEADING.test(raw) ||
      BLOCKQUOTE.test(raw) ||
      TABLE_ROW.test(raw) ||
      SHELL_PROMPT.test(raw) ||
      THEMATIC_BREAK.test(raw)
    ) {
      out.push("");
      continue;
    }
    // List markers stay as a sentence-split signal; splitSentences strips them
    // before it counts words.
    out.push(raw.replace(INLINE_CODE, " CODESPAN ").replace(URL, " URL "));
  }
  return out.join("\n");
}

/** Split into [startOffset, sentence] pairs, keeping only real sentences. */
export function splitSentences(text: string): Array<[number, string]> {
  const sentences: Array<[number, string]> = [];
  let start = 0;
  for (const boundary of text.matchAll(SENTENCE_BOUNDARY)) {
    const segment = text.slice(start, boundary.index).replace(LIST_MARKER, "");
    if (words(segment).length >= 2) sentences.push([start, segment]);
    start = boundary.index + boundary[0].length;
  }
  const tail = text.slice(start).replace(LIST_MARKER, "");
  if (words(tail).length >= 2) sentences.push([start, tail]);
  return sentences;
}

/** Emit one finding per match, labelled `check`. */
function findAll(
  text: string,
  pattern: RegExp,
  check: Check,
  message: (found: string) => string,
): Finding[] {
  const findings: Finding[] = [];
  for (const match of text.matchAll(pattern)) {
    const found = words(match[0]).join(" ");
    findings.push({ line: lineOf(text, match.index), check, message: message(found) });
  }
  return findings;
}

// --- Checks -----------------------------------------------------------------

export function findLongSentences(text: string, maxWords: number): Finding[] {
  const findings: Finding[] = [];
  for (const [start, sentence] of splitSentences(text)) {
    const count = words(sentence).length;
    if (count > maxWords) {
      findings.push({
        line: lineOf(text, start),
        check: "long-sentence",
        message: `${count} words (limit ${maxWords}) — split it: "${preview(sentence)}"`,
      });
    }
  }
  return findings;
}

export function findContractions(text: string): Finding[] {
  return findAll(text, CONTRACTION, "contraction", (f) => `"${f}" — spell it out`);
}

export function findBannedModals(text: string): Finding[] {
  return findAll(
    text,
    BANNED_MODAL,
    "banned-modal",
    (f) => `"${f}" — use "can" or state the uncertainty`,
  );
}

export function findPerfectTense(text: string): Finding[] {
  return findAll(
    text,
    PERFECT,
    "perfect-tense",
    (f) => `"${f}" — use the simple past or present`,
  );
}

export function findIngClauses(text: string): Finding[] {
  return findAll(
    text,
    ING_CLAUSE,
    "ing-clause",
    (f) => `"${f}…" — make it a separate sentence`,
  );
}

export function findSemicolons(text: string): Finding[] {
  return findAll(text, SEMICOLON, "semicolon", () => "semicolon — use two sentences");
}

export function findSlopWords(text: string): Finding[] {
  return findAll(text, SLOP, "slop-word", (f) => `"${f}" — cut it or use a plain word`);
}

export function findLatinAbbrevs(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [abbrev, plain] of LATIN_ABBREVS) {
    const pattern = new RegExp(
      `\\b${escapeRegExp(abbrev.replace(/\.+$/, ""))}\\.?(?=[\\s,.;:)]|$)`,
      "gi",
    );
    for (const match of text.matchAll(pattern)) {
      const found = words(match[0]).join(" ");
      findings.push({
        line: lineOf(text, match.index),
        check: "latin-abbrev",
        message: `"${found}" → "${plain}"`,
      });
    }
  }
  return findings;
}

export function findTrailingConditions(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [start, sentence] of splitSentences(text)) {
    const stripped = sentence.trim();
    if (STARTS_CONDITION.test(stripped)) continue;
    if (TRAILING_COND.test(stripped)) {
      findings.push({
        line: lineOf(text, start),
        check: "trailing-condition",
        message: 'condition trails the main clause — put the "if"/"when" first',
      });
    }
  }
  return findings;
}

/** Inner text of an emphasis match, asterisk or underscore form. */
function emphasisText(match: RegExpExecArray | RegExpMatchArray): string {
  return match[1] !== undefined ? match[1] : match[2];
}

export function findEmphasis(text: string, maxWords = EMPHASIS_MAX_WORDS): Finding[] {
  const findings: Finding[] = [];
  let prevBlank = true;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = LIST_MARKER.exec(line);
    const contentStart = marker ? marker[0].length : line.length - line.trimStart().length;
    const blockStart = prevBlank || marker !== null;

    const spans: Array<[number, string]> = [];
    for (const match of line.matchAll(BOLD)) spans.push([match.index, emphasisText(match)]);
    const withoutBold = line.replace(BOLD, (m) => " ".repeat(m.length));
    for (const match of withoutBold.matchAll(ITALIC)) {
      spans.push([match.index, emphasisText(match)]);
    }
    spans.sort((a, b) => a[0] - b[0]);

    for (const [startCol, content] of spans) {
      const leading = startCol === contentStart && blockStart;
      const count = words(content).length;
      if (leading && count <= maxWords && !SENTENCE_FINAL.test(content)) continue;
      let reason: string;
      if (!leading) {
        reason = "not at the start of its paragraph or list item";
      } else if (count > maxWords) {
        reason = `${count} words, over the ${maxWords}-word limit for a leading term`;
      } else {
        reason = "carries sentence-final punctuation";
      }
      findings.push({
        line: i + 1,
        check: "emphasis",
        message: `"${preview(content)}" — ${reason}; drop the bold or italics`,
      });
    }
    prevBlank = line.trim().length === 0;
  }
  return findings;
}

export function findSynonymRotation(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [, pattern] of ROTATION_SETS) {
    const firstSeen = new Map<string, number>();
    for (const match of text.matchAll(pattern)) {
      const stem = match[1].toLowerCase().replace(/s+$/, "");
      if (!firstSeen.has(stem)) firstSeen.set(stem, match.index);
    }
    const stems = [...firstSeen.keys()];
    if (stems.length > 1) {
      const base = stems[0];
      for (const stem of stems.slice(1)) {
        findings.push({
          line: lineOf(text, firstSeen.get(stem)!),
          check: "synonym-rotation",
          message: `"${stem}" and "${base}" are used for one idea — pick one term`,
        });
      }
    }
  }
  return findings;
}

/** Run every check over `text` and return findings sorted by (line, check). */
export function lint(
  text: string,
  options: { maxWords?: number; textType?: TextType } = {},
): Finding[] {
  const limit = options.maxWords ?? LIMITS[options.textType ?? DEFAULT_TYPE];
  const prose = stripNonProse(text);
  const findings = [
    ...findLongSentences(prose, limit),
    ...findContractions(prose),
    ...findBannedModals(prose),
    ...findPerfectTense(prose),
    ...findIngClauses(prose),
    ...findSemicolons(prose),
    ...findLatinAbbrevs(prose),
    ...findSlopWords(prose),
    ...findTrailingConditions(prose),
    ...findSynonymRotation(prose),
    ...findEmphasis(prose),
  ];
  return findings.sort((a, b) =>
    a.line !== b.line ? a.line - b.line : a.check < b.check ? -1 : a.check > b.check ? 1 : 0
  );
}

/** Format a finding the way the Python CLI prints it. */
export function formatFinding(f: Finding): string {
  return `${f.line}: ${f.check}: ${f.message}`;
}
