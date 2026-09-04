/**
 * Tallying: turn Claude Code agent transcripts into a corpus of shell
 * invocations, deterministically and without running or classifying anything.
 *
 * ## Why this is conservative rather than clever
 *
 * A transcript's `Bash` tool_use records the exact string handed to a shell,
 * which means it can be a pipeline, a chain of `&&`, a heredoc, or a script
 * with command substitution in it. Naive line-scanning over fourteen days of
 * this project's own transcripts produced 29,166 lines, of which only 4,336
 * were real invocations — the rest was heredoc and script *body*, read as if
 * each line were a command in its own right.
 *
 * So extraction takes the **leading command** of the string and nothing past
 * it, and it takes that command only when it can be tokenised with
 * confidence. A body containing command substitution (`$(...)`, backticks) or
 * a heredoc marker (`<<`) is refused outright rather than guessed at, because
 * a wrong guess here is the same failure class as a wrong option arity in
 * `discover`: it invents an invocation nobody typed. Refusals are counted and
 * reported, never silently dropped — a corpus that looks complete because its
 * gaps were swept under the rug is worse than one that admits them.
 *
 * **Known bias, not fixed here:** taking only the leading command of a
 * compound line (`git status && npm test`, `git log | cat`) means a command
 * that only ever appears after a separator is invisible to the tally, and a
 * refused-outright compound line (`git status && git push`) is scored as
 * though only its leading half were ever run. Measured on this project's own
 * corpus, 74% of distinct invocations (1140 total) contain an unquoted
 * separator or newline, so the *ranking* under-represents anything that
 * mostly runs second in a chain, and {@link falseRefusals} is biased
 * optimistic in the same way: a compound line no wrapper could run at all
 * still records as its (wrapper-admitted) leading command. This is the
 * decision the issue's plan made on purpose — see `DESIGN.md` and the
 * `nextAction` strings in `fka.ts`'s `tally` and `score` methods, which state
 * it explicitly rather than leave it to be discovered by someone reading a
 * queue that looks more complete than it is.
 *
 * ## What a corpus does and does not know
 *
 * Transcripts record every command the agent ran; they do not record which of
 * those prompted a person first, so a call approved at a prompt and one
 * allowed outright are indistinguishable here. What they do record verbatim
 * is an explicit denial, tallied separately as the small, high-signal case
 * `DESIGN.md` calls out.
 *
 * ## The transcript format is not a stable contract
 *
 * Every shape check below is a best-effort read of Claude Code's on-disk
 * JSONL, not a documented API. A line that does not parse as JSON, or an
 * envelope that does not resemble a message record, is skipped and counted —
 * never thrown on skipped silently, and never assumed to mean the corpus is
 * complete.
 *
 * ## How the subcommand path is decided (shape only, provisional by design)
 *
 * `tally` reads what was literally typed rather than crawling a tree, so the
 * set of invocations is already bounded by real usage — a combinatorial depth
 * cap on top of that was solving a problem this module does not have, and it
 * mis-drew the line: `swamp model method run` is four subcommands deep, and
 * `git show 91a0e05` is one subcommand plus a hash. A fixed cap could only
 * ever be wrong about one of those.
 *
 * The path assigned to each invocation is a SHAPE-only read of its argv —
 * see {@link looksLikeArgument} and {@link shapeCandidate}: a token
 * containing `/`, `.`, `:`, `@`, internal whitespace (only ever produced by
 * a quoted or backslash-escaped word — see {@link shellWords}), or that
 * looks like a hex hash, or that starts with `-` or `>`, is an argument and
 * ends the path; every other token, once the path has started, extends it.
 * This alone disposes of `show 91a0e05`, `ls-remote https://...`, `fetch .`,
 * any redirection token that survives {@link leadingSegment}, and — the
 * whitespace test — a quoted argument that would otherwise land verbatim in
 * the path (see the security note below). It cannot see an argument-shaped
 * IDENTIFIER: `ext-factory` (a model name), `proposal-git` (a data name)
 * look exactly like ordinary subcommand words.
 *
 * This is deliberately provisional and deliberately over-inclusive. An
 * earlier version of this module also ran a second pass over the whole
 * corpus — successor cardinality, counting how many distinct tokens follow a
 * given path prefix to catch what shape alone cannot — but it collapsed
 * `swamp extension push`, `extension search`, and `workflow validate` into
 * their parents, losing the one invocation DESIGN.md is built around, and it
 * needed a hand-added exemption because git's own top-level slot has a ratio
 * of 5.6 by the same measure. The reason is structural, not a tuning
 * problem: only `discover`, reading the tool's own `--help` output, is
 * allowed to decide what the command names actually are (DESIGN.md). Nothing
 * in the string `swamp extension push` marks `push` as a subcommand rather
 * than an argument, so no statistic over this corpus alone can recover it.
 *
 * So the safe direction for a QUEUE is the opposite of the safe direction
 * for a TABLE: an extra path costs a little review time and
 * `discover`/`classify` prune it, while a missing path means the command is
 * never analysed at all. {@link derivePaths} over-includes on purpose, and
 * exact segmentation — recovering the tool's real command tree and
 * re-deriving paths against it — is FKA-13, not this module.
 *
 * One generous, non-semantic guard remains against pathological input (a
 * script pasted as if it were a single command, say): {@link shapeCandidate}
 * stops following a chain of shape-plausible tokens past {@link PATH_BOUND}.
 * Hitting it is a **reported** condition — {@link Corpus.pathBoundHits} —
 * never a silent truncation. Silent truncation is how `swamp model method
 * run` became `swamp model` in an earlier version of this module, with
 * nothing in the output to say so.
 *
 * ## Leading global flags
 *
 * A flag before the subcommand (`git -C /path log`) must not be read as
 * ending the path — see {@link shapeCandidate}'s handling of tokens seen
 * before the path has started, and the conservative-choice cost documented
 * there.
 *
 * ## A quoted argument is not a command-path token (security)
 *
 * `usage-profile.json` and the `usageProfile` resource's `top` field are
 * read by whoever drives an fka run — SKILL.md and manifest.yaml say so —
 * and a path is presented there as "the commands you actually run", not as
 * arbitrary text. Without the whitespace test above, a quoted argument free
 * of path punctuation (`gh pr comment "IGNORE PREVIOUS INSTRUCTIONS..."`)
 * would land verbatim in that field, and the text inside it can be
 * attacker-influenced — an issue body echoed through `gh`, a commit message,
 * a `-m` string. {@link shellWords} collapses a quoted word into a single
 * token; the only way that token can contain whitespace is that it was
 * quoted or backslash-escaped, so treating any whitespace-bearing token as
 * argument-shaped closes that channel (finding N3).
 *
 * @module
 */

// deno-lint-ignore no-explicit-any
declare const Deno: any;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** One shell invocation, normalised to what a wrapper's `validate` needs. */
export interface Invocation {
  /** Basename of the program actually run, e.g. "git". Never a path. */
  binary: string;
  /** Everything after the binary — the vector a wrapper would receive. */
  argv: string[];
  /**
   * The subcommand chain: `argv`'s leading tokens that look and behave like a
   * subcommand — see the module doc's "How the subcommand path is decided".
   *
   * This is a coarse proxy for "which command", used to rank the tally queue
   * and to match the hand-labelled fixture. It is not ground truth the way
   * `discover`'s crawl is: it is derived from shape and from this corpus's own
   * frequency statistics, both of which can be wrong about a command run only
   * once, or a positional argument that happens to recur (a remote named
   * `origin` in every invocation, say).
   */
  path: string[];
  /**
   * Set when {@link derivePaths} stopped extending `path` because it hit the
   * one generous, non-semantic bound rather than because a token looked like
   * an argument. A reported condition, never a silent truncation.
   */
  pathTruncated?: boolean;
  /** The leading command as extracted, before tokenising. Kept for review. */
  raw: string;
  /** How many times this exact (binary, argv) shape was seen. */
  count: number;
}

export interface RefusedSample {
  raw: string;
  reason: string;
}

export interface Corpus {
  generatedAt: string;
  root: string;
  windowDays: number;
  transcriptsScanned: number;
  linesScanned: number;
  linesUnparsed: number;
  /** Bash commands seen but not confidently tokenised, and therefore dropped. */
  refusedCount: number;
  refusedSamples: RefusedSample[];
  invocations: Invocation[];
  denials: Invocation[];
  /**
   * How many invocations hit {@link derivePaths}'s generous depth guard —
   * reported so a deep, legitimate CLI never quietly reads as a shallow one.
   * Zero on every real corpus so far.
   */
  pathBoundHits: number;
}

// ---------------------------------------------------------------------------
// Tokenising the leading command
// ---------------------------------------------------------------------------

export type TokenizeResult =
  | { ok: true; binary: string; argv: string[] }
  | { ok: false; reason: string };

const DISQUALIFYING = [
  { pattern: "$(", reason: "command substitution ($(...))" },
  { pattern: "`", reason: "command substitution (backticks)" },
  { pattern: "<<", reason: "a heredoc" },
] as const;

/**
 * Find the leading command: everything before the first unquoted `;`, `&`,
 * `|`, newline, or redirection. A single `&` covers both `&` and `&&`; a
 * single `|` covers both `|` and `||` — the distinction does not matter here,
 * since only the text before the separator is kept either way.
 *
 * `>` and `<` end the leading command too — `swamp data get foo > out.json`
 * is one invocation followed by a redirection, not an invocation whose
 * positional argument is `out.json`. An `fd` number or `&` immediately before
 * the redirect (`2>`, `&>`, `1>&2`) belongs to the redirection, not to the
 * command, so it is trimmed along with it.
 */
function leadingSegment(body: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      // Any backslash inside double quotes escapes the following character
      // for the purpose of finding the real closing quote — `body[i - 1] !==
      // "\\"` mis-reads an escaped backslash (`\\"`) as escaping the quote
      // that follows it, staying inside the string past its real end.
      // Consuming the escaped character, the way `shellWords` already does
      // below, is the fix; treating every backslash as an escape here is a
      // safe superset of bash's own narrower rule (only `"`, `\`, `$`, and
      // backtick are actually escapable in a double-quoted string) — it can
      // only ever consume one extra ordinary character, never mis-identify a
      // real closing quote as escaped.
      if (c === "\\" && i + 1 < body.length) {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n") {
      return body.slice(0, i);
    }
    if (c === ">" || c === "<") {
      let end = i;
      while (end > 0 && /[0-9&]/.test(body[end - 1])) end--;
      return body.slice(0, end);
    }
  }
  return body;
}

/** Shell-word split respecting quotes. `null` on an unterminated quote. */
function shellWords(s: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else cur += c;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
        cur += s[++i];
      } else cur += c;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      has = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      has = true;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur !== "") tokens.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (inSingle || inDouble) return null;
  if (has || cur !== "") tokens.push(cur);
  return tokens;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Strip leading `VAR=value` tokens and bare `env` tokens, in either order and
 * any number of times — `env FOO=1 git status` and `FOO=1 env git status`
 * both mean the same thing to a shell, but a version of this that only
 * checked for `env` at position 0 missed the second form and returned `env`
 * itself as the binary.
 *
 * Deliberately not attempted here: `env`'s own flags (`env -i`, `env -u
 * NAME`). `env`'s flag grammar is a small parser of its own — some flags take
 * a value, some do not — and guessing at it is the kind of guess this module
 * exists to avoid. `tokenize` refuses rather than mis-attribute the binary
 * when a flag-shaped token is left after this strip.
 */
function stripPrefix(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === "env" || ASSIGNMENT.test(tokens[i])) {
      i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

function basename(token: string): string {
  const parts = token.split("/");
  return parts[parts.length - 1] || token;
}

/**
 * Tokenise one Bash tool_use command into a normalised invocation, or refuse.
 *
 * Only the leading command is examined — see the module doc for why. A body
 * containing command substitution or a heredoc marker anywhere is refused
 * wholesale: even when those constructs sit past the leading command, their
 * presence means the string was a script rather than a single invocation, and
 * treating the first word of a script as "the command" is exactly the kind of
 * guess this module exists to avoid.
 *
 * This does not decide the subcommand path — see {@link derivePaths}. Doing
 * that here would mean deciding "is this a subcommand or an argument" one
 * invocation at a time, with no view of how often the token recurs across the
 * corpus, which is exactly the signal that question needs.
 */
export function tokenize(body: string): TokenizeResult {
  const trimmed = body.trim();
  if (trimmed === "") return { ok: false, reason: "empty command" };

  for (const { pattern, reason } of DISQUALIFYING) {
    if (trimmed.includes(pattern)) {
      return { ok: false, reason: `contains ${reason}` };
    }
  }

  const segment = leadingSegment(trimmed).trim();
  if (segment === "") return { ok: false, reason: "empty leading command" };

  const words = shellWords(segment);
  if (words === null) {
    return { ok: false, reason: "unterminated quote" };
  }

  const rest = stripPrefix(words);
  if (rest.length === 0) {
    return {
      ok: false,
      reason: "only environment assignments, no command",
    };
  }

  const [first, ...argv] = rest;
  if (first.includes("=")) {
    return { ok: false, reason: "could not isolate the binary" };
  }
  if (first.startsWith("-")) {
    // Left over after stripping `env`/assignments, this is an `env` flag
    // (`env -i git status`) this module does not parse — see stripPrefix.
    // Reporting it as the binary would be wrong silently; refusing is the
    // same posture as an unrecognised option arity elsewhere in this file.
    return {
      ok: false,
      reason: "could not isolate the binary from env's own flags",
    };
  }
  const binary = basename(first);
  if (binary === "") return { ok: false, reason: "empty binary name" };

  return { ok: true, binary, argv };
}

// ---------------------------------------------------------------------------
// Deciding the subcommand path: shape only — see the module doc
// ---------------------------------------------------------------------------

/**
 * A hex string long enough to plausibly be a commit-ish hash and not an
 * ordinary word. Git abbreviates to 7 by default; allow up to a full sha256.
 */
const HEX_HASH = /^[0-9a-f]{7,64}$/i;

/**
 * A token shaped like an argument rather than a subcommand — see the module
 * doc. The whitespace test (finding N3) is load-bearing for security, not
 * just shape: {@link shellWords} collapses a quoted or backslash-escaped
 * word into one token, so the only way a token can contain whitespace at
 * all is that it was quoted — an ordinary unquoted argument never does.
 * Reading such a token as a path element would let arbitrary quoted text
 * (an issue body echoed through \`gh\`, a commit message, a \`-m\` string) land
 * verbatim in \`usage-profile.json\`'s \`commands\` and the \`usageProfile\`
 * resource's \`top\` field, both of which SKILL.md and manifest.yaml tell a
 * driving agent to read as "the commands you actually run".
 */
function looksLikeArgument(token: string): boolean {
  if (token.startsWith("-") || token.startsWith(">")) return true;
  if (/[/.:@]/.test(token)) return true;
  if (/\s/.test(token)) return true;
  if (HEX_HASH.test(token)) return true;
  return false;
}

/**
 * How deep {@link shapeCandidate} will follow a chain of shape-plausible
 * subcommand tokens before giving up and reporting the invocation as having
 * hit the bound. Generous on purpose — this is not a semantic claim about how
 * deep a real command tree goes, only a backstop against a body that
 * tokenised as a single "command" it should not have (a script pasted as if
 * it were one invocation).
 */
const PATH_BOUND = 8;

/**
 * Tokenise one invocation's argv into a maximal, shape-only path. This is
 * the ONLY pass now — see the module doc for why a successor-cardinality
 * second pass was tried and removed — so it is deliberately permissive: an
 * argument-shaped IDENTIFIER like \`ext-factory\` is NOT excluded here, only a
 * token that could never be a subcommand at all (a flag, a path, a hash, a
 * quoted string, a redirection remnant).
 *
 * Leading global flags — anything shape-rejected before the path has
 * started — are SKIPPED rather than treated as ending the path: \`git -C
 * /path log\` must reach \`log\`, not stop dead at \`-C\`. Once the path has
 * started, the same shape check ends it exactly as before: an option after
 * the subcommand (\`log --oneline\`) is not folded into the chain.
 *
 * The conservative choice, and what it costs: arity is not knowable here —
 * \`discover\` has not run — so a leading flag that takes no value
 * (\`--no-pager\`) is skipped exactly like one that does (\`-C <path>\`), one
 * token at a time, never two. That is correct for \`-C /path log\` (the flag
 * and its value are each shape-rejected in turn, so both are skipped and
 * \`log\` is reached) and correct for \`--no-pager log\` (the flag is
 * shape-rejected and skipped, \`log\` is shape-plausible and starts the path).
 * What it cannot get right is a flag whose value is itself shape-plausible
 * (\`-b mybranch log\`, say): \`mybranch\` looks exactly like a subcommand, so it
 * is read as starting the path instead of being skipped as the flag's value.
 * This layer does not try to tell those apart, and no later pass does either
 * now — see the module doc: exact segmentation is FKA-13's, not this
 * module's, and the over-inclusion this costs is the deliberate, documented
 * trade until then.
 */
function shapeCandidate(
  argv: readonly string[],
): { tokens: string[]; truncated: boolean } {
  const tokens: string[] = [];
  let started = false;
  for (let i = 0; i < argv.length; i++) {
    if (tokens.length >= PATH_BOUND) return { tokens, truncated: true };
    const token = argv[i];
    if (looksLikeArgument(token)) {
      if (started) break;
      continue; // a leading global flag (or its value) — skip, don't end the path
    }
    started = true;
    tokens.push(token);
  }
  return { tokens, truncated: false };
}

/**
 * Assign \`path\` (and \`pathTruncated\`) to every invocation. \`pathTruncated\`
 * reports only {@link shapeCandidate} hitting {@link PATH_BOUND} — the
 * generous, non-semantic guard against pathological input — never a silent
 * truncation.
 */
export function derivePaths<
  T extends { binary: string; argv: string[] },
>(
  targets: readonly T[],
): {
  results: (T & { path: string[]; pathTruncated?: boolean })[];
  pathBoundHits: number;
} {
  let pathBoundHits = 0;
  const results = targets.map((t) => {
    const { tokens, truncated: shapeTruncated } = shapeCandidate(t.argv);
    // PROVISIONAL by construction — see the module doc. Segmenting argv into
    // a command path needs the tool's real command tree, and only \`discover\`
    // has it, so shape is all that is applied here and the exact
    // segmentation happens after \`discover\` (FKA-13).
    const path = tokens;
    if (shapeTruncated) pathBoundHits++;
    return shapeTruncated
      ? { ...t, path, pathTruncated: true }
      : { ...t, path };
  });
  return { results, pathBoundHits };
}

// ---------------------------------------------------------------------------
// Reading transcripts
// ---------------------------------------------------------------------------

interface ContentBlock {
  type?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  input?: { command?: unknown };
  content?: unknown;
  text?: string;
}

interface TranscriptRecord {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

function blocksOf(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((
        b,
      ) => (b && typeof b === "object" && "text" in b
        ? String((b as { text?: unknown }).text ?? "")
        : "")
      )
      .join(" ");
  }
  return "";
}

/**
 * Heuristic marker for an explicit permission denial in a tool_result.
 *
 * Not a documented field — Claude Code does not publish a stable schema for
 * this, so the match is on the phrasing its own rejection UI is currently
 * known to use ("The user doesn't want to proceed with this tool use." /
 * "...doesn't want to take this action right now."). Anchored to the FULL
 * sentence and to the WHOLE trimmed block content, not a fragment inside a
 * longer body — a prior version matched just "doesn't want to
 * (?:proceed|take this action)" anywhere in the text, which is also
 * ordinary English: "the reviewer doesn't want to proceed with this
 * change" is not a Claude Code denial, and this very docstring, quoted back
 * by a failing command that echoes this source file, contains the literal
 * fragment too (finding F14). Requiring the complete known sentence, and
 * requiring it be the entire content rather than embedded in surrounding
 * text, does not eliminate self-reference outright — a command whose ENTIRE
 * output happens to be exactly one of these sentences would still match —
 * but it removes the far more common case of the phrase appearing inside a
 * longer message, planted or not.
 *
 * Narrower still would be a token only Claude Code emits and nothing else
 * ever would; no such token is available, so this is the closest available
 * approximation. Impact of a miss in either direction is bounded: a false
 * positive drops one invocation from `falseRefusals`' consideration (an
 * under-count, not an over-grant), and a false negative counts an ordinary
 * failure as an ordinary invocation (today's default anyway).
 */
const DENIAL_MARKER =
  /^\s*(?:the\s+)?user\s+doesn'?t\s+want\s+to\s+(?:proceed\s+with\s+this\s+tool\s+use|take\s+this\s+action(?:\s+right\s+now)?)\.?\s*$/i;

function isDenial(block: ContentBlock): boolean {
  if (block.is_error !== true) return false;
  return DENIAL_MARKER.test(textOf(block.content));
}

export interface ExtractResult {
  invocations: {
    binary: string;
    argv: string[];
    raw: string;
  }[];
  denials: { binary: string; argv: string[]; raw: string }[];
  refused: RefusedSample[];
  linesScanned: number;
  linesUnparsed: number;
}

/**
 * Walk one transcript's lines in order, pairing each Bash `tool_use` with its
 * `tool_result` to decide whether it was denied.
 *
 * A `tool_use` with no matching `tool_result` by end of file — a transcript
 * truncated mid-run — is counted as an ordinary invocation. That is a
 * judgement call, not a fact recorded anywhere: the alternative, dropping it,
 * would silently undercount the single most recently run command in every
 * live session.
 */
export function extractFromTranscript(
  lines: readonly string[],
  windowStart: Date | null,
): ExtractResult {
  const pending = new Map<
    string,
    { binary: string; argv: string[]; raw: string } | null
  >();
  const invocations: ExtractResult["invocations"] = [];
  const denials: ExtractResult["denials"] = [];
  const refused: RefusedSample[] = [];
  let linesUnparsed = 0;
  let linesScanned = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;
    linesScanned++;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line);
    } catch {
      linesUnparsed++;
      continue;
    }
    if (record === null || typeof record !== "object") {
      linesUnparsed++;
      continue;
    }

    if (windowStart && record.timestamp) {
      const t = new Date(record.timestamp);
      if (!isNaN(t.getTime()) && t < windowStart) continue;
    }

    const role = record.message?.role ?? record.type;
    const blocks = blocksOf(record.message?.content);

    if (role === "assistant") {
      for (const block of blocks) {
        if (block.type !== "tool_use" || block.name !== "Bash") continue;
        const command = block.input?.command;
        if (typeof command !== "string" || !block.id) continue;
        const result = tokenize(command);
        if (!result.ok) {
          refused.push({ raw: command, reason: result.reason });
          pending.set(block.id, null);
          continue;
        }
        pending.set(block.id, { ...result, raw: command });
      }
      continue;
    }

    if (role === "user") {
      for (const block of blocks) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        if (!pending.has(block.tool_use_id)) continue;
        const inv = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        if (!inv) continue; // was refused at tokenise time
        if (isDenial(block)) denials.push(inv);
        else invocations.push(inv);
      }
      continue;
    }
  }

  // Anything never matched to a result: assume it ran.
  for (const inv of pending.values()) {
    if (inv) invocations.push(inv);
  }

  return { invocations, denials, refused, linesScanned, linesUnparsed };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** An invocation before its subcommand path has been decided. */
type UnpathedInvocation = {
  binary: string;
  argv: string[];
  raw: string;
  count: number;
};

function dedupe(
  raw: readonly {
    binary: string;
    argv: string[];
    raw: string;
  }[],
): UnpathedInvocation[] {
  const byKey = new Map<string, UnpathedInvocation>();
  for (const r of raw) {
    const key = `${r.binary} ${JSON.stringify(r.argv)}`;
    const existing = byKey.get(key);
    if (existing) existing.count++;
    else byKey.set(key, { ...r, count: 1 });
  }
  return [...byKey.values()].sort((a, b) =>
    b.count - a.count || a.raw.localeCompare(b.raw)
  );
}

/** One tool's ranked queue: distinct subcommand paths, most-used first. */
export interface UsageEntry {
  path: string[];
  count: number;
}

/** Roll a corpus's invocations up by (binary, path), for the tally queue. */
export function rankByTool(
  invocations: readonly Invocation[],
): Map<string, UsageEntry[]> {
  const byTool = new Map<string, Map<string, UsageEntry>>();
  for (const inv of invocations) {
    let paths = byTool.get(inv.binary);
    if (!paths) byTool.set(inv.binary, paths = new Map());
    const key = inv.path.join(" ");
    const entry = paths.get(key);
    if (entry) entry.count += inv.count;
    else paths.set(key, { path: inv.path, count: inv.count });
  }
  const result = new Map<string, UsageEntry[]>();
  for (const [tool, paths] of byTool) {
    result.set(
      tool,
      [...paths.values()].sort((a, b) =>
        b.count - a.count || a.path.join(" ").localeCompare(b.path.join(" "))
      ),
    );
  }
  return result;
}

/** Ranked denials for one tool, same shape as {@link rankByTool}. */
export function rankDenials(
  denials: readonly Invocation[],
  tool: string,
): UsageEntry[] {
  const paths = new Map<string, UsageEntry>();
  for (const inv of denials) {
    if (inv.binary !== tool) continue;
    const key = inv.path.join(" ");
    const entry = paths.get(key);
    if (entry) entry.count += inv.count;
    else paths.set(key, { path: inv.path, count: inv.count });
  }
  return [...paths.values()].sort((a, b) =>
    b.count - a.count || a.path.join(" ").localeCompare(b.path.join(" "))
  );
}

// ---------------------------------------------------------------------------
// Reading the corpus from disk
// ---------------------------------------------------------------------------

/**
 * `~/.claude/projects/<repoDir slugged>` — Claude Code's own convention for
 * where a project's transcripts live. Not documented, matched against what is
 * on disk; if it does not exist, callers are expected to pass an explicit
 * root rather than have this guess further.
 *
 * Claude Code slugs a project path by replacing **every** character that is
 * not a letter or digit with `-`, not only `/`. A worktree path routinely
 * carries other punctuation — a dot, an `@`, a second `-` already in the
 * branch name — and replacing `/` alone produces a slug that does not exist
 * on disk, so `tally` throws in the working mode this repository actually
 * uses. Matching the real convention is the fix; widening `root` is a
 * workaround for operators who hit this before it was fixed, not the answer.
 */
export function defaultTranscriptRoot(home: string, repoDir: string): string {
  return `${home}/.claude/projects/${repoDir.replace(/[^a-zA-Z0-9]/g, "-")}`;
}

/**
 * `Deno.readDir`'s iteration order is unspecified — it follows the
 * filesystem, not an alphabetical guarantee — so callers that want a stable
 * result must sort. Returned sorted for exactly that reason: `buildCorpus`'s
 * determinism claim depends on reading the same files in the same order every
 * time, not merely on reading the same *set* of files.
 */
async function walkJsonl(dir: string): Promise<string[]> {
  const found: string[] = [];
  let entries: AsyncIterable<
    { name: string; isFile: boolean; isDirectory: boolean }
  >;
  try {
    entries = Deno.readDir(dir);
  } catch {
    return found;
  }
  try {
    for await (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        found.push(...await walkJsonl(path));
      } else if (entry.isFile && entry.name.endsWith(".jsonl")) {
        found.push(path);
      }
    }
  } catch {
    // Directory disappeared mid-walk, or was never there.
  }
  return found.sort();
}

/**
 * Build a corpus by reading every `.jsonl` transcript under `root`.
 *
 * Deterministic given an unchanged set of files: two runs over the same
 * corpus produce byte-identical output, because extraction has no clock in it
 * beyond the window cutoff computed once at the start.
 */
export async function buildCorpus(
  root: string,
  windowDays: number,
  now: Date = new Date(),
): Promise<Corpus> {
  const files = await walkJsonl(root);
  const windowStart = windowDays > 0
    ? new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)
    : null;

  const allInvocations: ExtractResult["invocations"] = [];
  const allDenials: ExtractResult["denials"] = [];
  const refused: RefusedSample[] = [];
  let linesScanned = 0;
  let linesUnparsed = 0;

  for (const file of files) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    const result = extractFromTranscript(text.split("\n"), windowStart);
    allInvocations.push(...result.invocations);
    allDenials.push(...result.denials);
    refused.push(...result.refused);
    linesScanned += result.linesScanned;
    linesUnparsed += result.linesUnparsed;
  }

  const invocations = dedupe(allInvocations);
  const denials = dedupe(allDenials);
  // Frequency statistics come from ordinary invocations only, and are shared
  // with denials: denials are too sparse on their own to say what recurs, but
  // they use the same binaries' vocabulary.
  const invocationPaths = derivePaths(invocations);
  const denialPaths = derivePaths(denials);

  return {
    generatedAt: now.toISOString(),
    root,
    windowDays,
    transcriptsScanned: files.length,
    linesScanned,
    linesUnparsed,
    refusedCount: refused.length,
    refusedSamples: refused.slice(0, 50),
    invocations: invocationPaths.results,
    denials: denialPaths.results,
    pathBoundHits: invocationPaths.pathBoundHits + denialPaths.pathBoundHits,
  };
}
