/**
 * Rendering the three artifacts: wrapper scripts, the permission snippet, and
 * the skill snippet.
 *
 * All three come out of one approved {@link Review}. They are three views of a
 * single fact — which commands run at which tier — and generating them apart is
 * how they drift into a permission rule naming a wrapper nobody built.
 *
 * Wrapper naming, including why the tier leads the name, lives in
 * `review.ts` alongside the tier definitions themselves.
 */

import type { Review, WrapperSpec } from "./review.ts";
import {
  baseName,
  SEGMENT_BUCKET,
  SEGMENT_MEANING,
  SEGMENTS,
  tierRank,
  toPolicy,
  wrapperName,
} from "./review.ts";
import type { Policy } from "./validate.ts";

/** Exit code for a refusal. 126 is "found but not executable" — never the tool's own. */
export const REFUSED_EXIT = 126;

/**
 * Deno flags the wrapper runs itself under.
 *
 * `--allow-run` names the one absolute binary, which is a real boundary: a
 * wrapper that is somehow talked into spawning cannot spawn anything else.
 *
 * `--allow-env` is deliberately not narrowed to a variable list. It would look
 * tighter and buy nothing — the child inherits the whole environment either
 * way, so restricting which names the wrapper itself may read protects nothing,
 * and for a tool like git the list runs past fifty variables. Scrubbing is the
 * control here; this permission only decides whether scrubbing is possible.
 *
 * Nothing else is granted. The script has no imports, reads no files, and opens
 * no sockets, so it needs no network, no `--allow-read`, and no lockfile.
 */
export function denoFlags(policy: Policy): string[] {
  return [
    "run",
    "--quiet",
    "--no-config",
    "--no-lock",
    "--ext=ts",
    "--allow-env",
    `--allow-run=${policy.binary}`,
  ];
}

/** Quote one token for `/bin/sh`, so a path with a space survives the launcher. */
function shellQuote(token: string): string {
  return `'${token.replaceAll("'", `'\\''`)}'`;
}

/**
 * The two lines that make one file both a shell script and a Deno module.
 *
 * `#!/usr/bin/env -S deno run …` would be the obvious way to launch this, and
 * it does not survive contact with reality: a shebang line is capped at 127
 * bytes on Linux, and the absolute paths alone can pass that — a nix store path
 * for the wrapped binary is 60 characters before anything else. The cap applies
 * to the shebang, not to the file, so the launcher moves to line two.
 *
 * Line 2 reads as a no-op followed by `exec` to `/bin/sh` (`:` is the null
 * command and `//` is just an argument to it), and as a string literal followed
 * by a line comment to TypeScript. `exec` replaces the shell, so no extra
 * process survives, and Deno strips line 1 the way it strips any shebang.
 */
function launcher(denoPath: string, policy: Policy): string {
  const words = [denoPath, ...denoFlags(policy)].map(shellQuote).join(" ");
  return `#!/bin/sh\n":" //; exec ${words} "$0" "$@"`;
}

const RUNTIME = `
// --- the wrapper itself ----------------------------------------------------

/**
 * Run the argument vector if the policy permits it.
 *
 * FKA_CHECK=1 makes this a pure decision procedure: it prints the verdict
 * and stops without executing anything, which is the only reason \`verify\` can
 * exercise a whole policy without side effects.
 */
async function main(): Promise<number> {
  // Whatever this wrapper pins is folded in before anything is judged, so the
  // vector that gets checked is the vector that runs.
  const argv = effectiveArgv(POLICY, Deno.args);
  const verdict = validate(POLICY, argv);

  if (Deno.env.get("FKA_CHECK") === "1") {
    console.log(explain(POLICY, verdict));
    return verdict.ok ? 0 : 1;
  }

  if (!verdict.ok) {
    console.error(explain(POLICY, verdict));
    console.error(REFUSAL_HINT);
    return REFUSED_EXIT;
  }

  // Scrubbing happens after the verdict so a refusal never has a side effect.
  // The child inherits this process's environment, so deleting here is what
  // keeps a hook variable from reaching the tool.
  for (const name of POLICY.env.scrub) {
    try {
      Deno.env.delete(name);
    } catch {
      // Not granted, so it was never readable by the child either.
    }
  }
  // Deno refuses to spawn under the wrapper's scoped --allow-run if the child
  // would inherit a dynamic-linker variable — anything LD_* or DYLD_* — and a
  // caller's shell routinely has them, which used to surface as a raw
  // NotCapable crash instead of the tool running. Those variables preload
  // libraries and redirect loader search paths: they are the injection
  // surface the scrub exists for, so dropping them unconditionally is both
  // the fix and the posture. A table's scrub list adds tool-specific names
  // on top; it can never bring these back.
  for (const name of Object.keys(Deno.env.toObject())) {
    if (/^(?:LD|DYLD)_/.test(name)) {
      try {
        Deno.env.delete(name);
      } catch {
        // Not granted, so it was never readable by the child either.
      }
    }
  }
  for (const [name, value] of Object.entries(POLICY.env.set)) {
    Deno.env.set(name, value);
  }

  const child = new Deno.Command(POLICY.binary, {
    args: [...argv],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  const status = await child.status;
  // A killed child has no exit code. Report it the way a shell does, so a
  // caller sees the same number it would have seen without the wrapper.
  if (status.code === 0 && status.signal) return 128 + signalNumber(status.signal);
  return status.code;
}

/** Signal names to numbers, for the 128+n convention. Anything unknown is 1. */
function signalNumber(signal: string): number {
  const known: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
  };
  return known[signal] ?? 1;
}

Deno.exit(await main());
`;

/**
 * Render one tier's wrapper.
 *
 * `validateSource` is the text of `_lib/validate.ts`, read from disk at
 * generate time and pasted in unchanged. The parser guarding an `allow` rule is
 * then literally the module the test suite exercises rather than a second
 * implementation of it, and only the policy data differs between wrappers.
 */
export function renderWrapper(
  review: Review,
  spec: WrapperSpec,
  validateSource: string,
  denoPath: string,
): string {
  const policy = toPolicy(review, spec);
  const pinned = [...spec.prepend, "…", ...spec.append].join(" ");
  const shebang = launcher(denoPath, policy);

  const banner = [
    `// ${policy.name} — generated by @skunk-ape/fka. Do not edit.`,
    "//",
    `// Runs ${policy.binary}`,
    review.binaryVersion
      ? `// Tool version at generate time: ${review.binaryVersion}`
      : "",
    `// Segment: ${spec.segment} — ${SEGMENT_MEANING[spec.segment]}`,
    spec.purpose ? `// Purpose: ${spec.purpose}` : "",
    spec.prepend.length || spec.append.length
      ? `// Pins: ${baseName(review.cli)} ${pinned}`
      : "",
    spec.accepts === "path-only"
      ? "// Accepts a command path and nothing else: no options, no positionals."
      : "",
    review.generatedAt ? `// Generated: ${review.generatedAt}` : "",
    "//",
    "// Every argument is re-parsed against the table below and anything the",
    "// table does not name is refused. Edits here are lost on the next run of",
    "// the fka workflow; change the review file and regenerate instead.",
  ].filter(Boolean).join("\n");

  const hint = `const REFUSAL_HINT = ${
    JSON.stringify(refusalHint(review, spec))
  };`;

  return [
    shebang,
    banner,
    "",
    validateSource.trimEnd(),
    "",
    `const REFUSED_EXIT = ${REFUSED_EXIT};`,
    hint,
    "",
    `const POLICY: Policy = ${JSON.stringify(policy, null, 2)};`,
    RUNTIME,
  ].join("\n");
}

/** Tell the caller where to go next, rather than leaving them to guess. */
function refusalHint(review: Review, spec: WrapperSpec): string {
  const rank = SEGMENTS.indexOf(spec.segment);
  // Only aliases for the same tool are worth suggesting, and only ones that
  // reach further than this one. Pointing at another tool's wrapper would be
  // noise, and pointing at a narrower one would be advice that cannot work.
  const wider = review.wrappers
    .filter((s) => s.name === spec.name && SEGMENTS.indexOf(s.segment) > rank)
    .map((s) => wrapperName(review.prefix, s.segment, s.name));

  if (wider.length === 0) {
    return `No wider alias exists for ${
      baseName(review.cli)
    }. If this command should be permitted, edit the fka review file and regenerate.`;
  }
  return `Try ${
    wider.join(" or ")
  } — those prompt before running. If the command should be permitted unattended, edit the fka review file and regenerate.`;
}

// ---------------------------------------------------------------------------
// The permission snippet
// ---------------------------------------------------------------------------

/**
 * The settings fragment, as JSON with a leading comment block.
 *
 * Deliberately a fragment and not a file. Nothing in this model writes
 * `settings.json`: the thing that proposes a permission policy must not also be
 * able to put it into force, so the last step is a person pasting this in.
 */
export function renderSettings(review: Review): string {
  const cli = baseName(review.cli);
  const buckets: Record<"allow" | "ask", string[]> = { allow: [], ask: [] };

  // One rule per segment, not per wrapper. `Bash(fka-safe:*)` matches every
  // safe alias of every tool ever wrapped, which is the point of the shared
  // prefix: wrap another tool tomorrow and this file does not change.
  for (const segment of SEGMENTS) {
    if (!review.wrappers.some((s) => s.segment === segment)) continue;
    buckets[SEGMENT_BUCKET[segment]].push(
      `Bash(${review.prefix}-${segment}:*)`,
    );
  }

  const notes = [
    `// fka — permission rules covering ${cli}`,
    "//",
    "// Merge these into .claude/settings.json. They are keyed on the segment,",
    "// not on the tool, so wrapping another CLI later needs no new rule — its",
    `// aliases are already named ${review.prefix}-safe-*, ${review.prefix}-write-*, and so on.`,
    "//",
    "// The corollary is worth saying plainly: once these are in place, running",
    "// the fka workflow on a new tool makes that tool's safe commands runnable",
    "// with nobody watching. The review gate is what stands in between.",
    "//",
    `// ${review.prefix}-help-* is the narrowest useful grant on its own — the`,
    "// agent reads any command's documentation and runs none of them — and a",
    "// reasonable place to stop if you want to go slowly.",
    "//",
    "// No rule denies the raw tool. Denying it would be harsher than the",
    "// default without being safer: unlisted commands already prompt, so you",
    "// keep the option of approving one, and an absolute path was never",
    `// matched by "${cli}" anyway.`,
  ].join("\n");

  return `${notes}\n${JSON.stringify({ permissions: buckets }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The skill snippet
// ---------------------------------------------------------------------------

/** The instructions an agent needs to actually reach for the aliases. */
export function renderSkill(review: Review, binDir: string): string {
  const cli = baseName(review.cli);
  const ordered = [...review.wrappers].sort((a, b) =>
    SEGMENTS.indexOf(a.segment) - SEGMENTS.indexOf(b.segment)
  );

  const rows = ordered.map((s) => {
    const name = wrapperName(review.prefix, s.segment, s.name);
    const runs = SEGMENT_BUCKET[s.segment] === "allow"
      ? "runs unattended"
      : "prompts every time";
    return `| \`${name}\` | ${runs} | ${
      s.purpose || SEGMENT_MEANING[s.segment]
    } |`;
  }).join("\n");

  const help = ordered.find((s) => s.segment === "help");
  const safe = ordered.find((s) => s.segment === "safe");

  return `## Running ${cli}

Do not run \`${cli}\` directly. Use the alias that does the job with the least
reach. Each one takes the arguments \`${cli}\` takes, minus whatever it pins.

| Alias | When you run it | What it is for |
| --- | --- | --- |
${rows}

${examples(review, ordered)}

The aliases live in \`${binDir}\`. Put that on \`PATH\`, or call them by path.
${helpNote(review, help)}
**Reach for the narrowest one that works.** The aliases that run unattended
cost no interruption, so anything they can answer is free. The others prompt
every time by design — that is what they are for, not a misconfiguration to
work around.

A refusal exits ${REFUSED_EXIT} and prints the reason and the token at fault. It
means the argument is outside that alias, not that the command failed. Two
honest responses: rerun on a wider alias, or tell the user the table needs an
edit. Do not route around a refusal by calling \`${cli}\` directly or by its
absolute path.

To ask whether a command would be permitted without running it:

\`\`\`bash
FKA_CHECK=1 ${
    safe ? wrapperName(review.prefix, safe.segment, safe.name) : cli
  } <args>   # prints the verdict, execs nothing
\`\`\`
`;
}

/**
 * Say what the help alias reaches, because the table implies less than the
 * truth.
 *
 * An agent reading "safe commands only" reasonably concludes it cannot ask
 * about the others, and then either guesses at arguments or escalates to read a
 * help page. The help alias covers every command precisely because asking is
 * not doing, and that inversion — wider in coverage, narrower in power — is
 * worth one sentence rather than a surprise.
 */
function helpNote(review: Review, help: WrapperSpec | undefined): string {
  if (!help) return "";
  const name = wrapperName(review.prefix, help.segment, help.name);
  const above = review.commands
    .filter((c) => c.path.length > 0 && c.tier !== "read-safe")
    .sort((a, b) => tierRank(b.tier) - tierRank(a.tier))[0];
  const example = above ? `${name} ${above.path.join(" ")}` : name;

  return `
**\`${name}\` reaches every command, including ones nothing else will run.**
Reading what a command does is not doing it, so ask here rather than escalating
a tier to find out what a command takes.

\`\`\`bash
${example}
\`\`\`

It accepts a command path and nothing else — no options, no arguments. The help
flag is not yours to pass; the alias adds it.
`;
}

/**
 * Examples drawn from the table, so nothing here is a command that does not
 * exist.
 *
 * Each alias gets the most dangerous command it admits, which is the one that
 * distinguishes it. Aliases are cumulative downward, so showing the first
 * command in the policy would illustrate `fka-write-gh` with `gh pr list` —
 * true, and useless for telling it apart from the safe alias.
 */
function examples(review: Review, ordered: WrapperSpec[]): string {
  const lines: string[] = [];
  for (const spec of ordered) {
    const admitted = new Set(
      toPolicy(review, spec).commands.map((c) => c.path.join(" ")),
    );
    const cmd = review.commands
      .filter((c) => c.path.length > 0 && admitted.has(c.path.join(" ")))
      .sort((a, b) => tierRank(b.tier) - tierRank(a.tier))[0];
    if (!cmd) continue;
    const name = wrapperName(review.prefix, spec.segment, spec.name);
    // The pinned prefix is the alias's own, so it must not be typed again.
    const pinnedDepth = spec.prepend.filter((t) => !t.startsWith("-")).length;
    const typed = cmd.path.slice(pinnedDepth);
    lines.push(`${name}${typed.length ? " " + typed.join(" ") : ""}`);
  }
  if (lines.length === 0) return "";
  return "```bash\n" + lines.join("\n") + "\n```";
}
