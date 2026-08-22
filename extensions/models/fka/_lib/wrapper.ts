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

import type { Review, Tier } from "./review.ts";
import {
  baseName,
  TIER_MEANING,
  tierRank,
  TIERS,
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
  const argv = Deno.args;
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
  tier: Tier,
  validateSource: string,
  denoPath: string,
): string {
  const policy = toPolicy(review, tier);
  const name = wrapperName(review.cli, tier);
  const shebang = launcher(denoPath, policy);

  const banner = [
    `// ${name} — generated by @skunk-ape/fka. Do not edit.`,
    "//",
    `// Runs ${policy.binary}`,
    review.binaryVersion
      ? `// Tool version at generate time: ${review.binaryVersion}`
      : "",
    `// Tier: ${tier} — ${TIER_MEANING[tier]}`,
    review.generatedAt ? `// Generated: ${review.generatedAt}` : "",
    "//",
    "// Every argument is re-parsed against the table below and anything the",
    "// table does not name is refused. Edits here are lost on the next run of",
    "// the fka workflow; change the review file and regenerate instead.",
  ].filter(Boolean).join("\n");

  const hint = `const REFUSAL_HINT = ${
    JSON.stringify(refusalHint(review, tier))
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
function refusalHint(review: Review, tier: Tier): string {
  const higher = review.emit.filter((t) => tierRank(t) > tierRank(tier));
  if (higher.length === 0) {
    return `No higher tier is available for ${
      baseName(review.cli)
    }. If this command should be permitted, edit the fka review file and regenerate.`;
  }
  const names = higher.map((t) => wrapperName(review.cli, t)).join(" or ");
  return `Try ${names} — those prompt before running. If the command should be permitted unattended, edit the fka review file and regenerate.`;
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
  const allow: string[] = [];
  const ask: string[] = [];

  for (const tier of TIERS) {
    if (!review.emit.includes(tier)) continue;
    const rule = `Bash(${wrapperName(review.cli, tier)}:*)`;
    if (tier === "read-safe") allow.push(rule);
    else ask.push(rule);
  }

  const body = {
    permissions: {
      allow,
      ask,
      deny: [`Bash(${cli}:*)`],
    },
  };

  const notes = [
    `// fka — permission rules for ${cli}`,
    "//",
    "// Merge these into .claude/settings.json. Rules are prefix matches on the",
    "// command line, which is why the tier leads the name: a deny on the raw",
    `// tool cannot swallow "${wrapperName(review.cli, "read-safe")}".`,
    "//",
    "// The deny rule steers the agent to the wrappers. It is a nudge and",
    "// not a sandbox: an absolute path is not matched, because",
    `// ${review.binary} does not begin with "${cli}". Treat that as the known`,
    "// limit of the mechanism rather than a hole to plug here.",
  ].join("\n");

  return `${notes}\n${JSON.stringify(body, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The skill snippet
// ---------------------------------------------------------------------------

/** The instructions an agent needs to actually reach for the wrappers. */
export function renderSkill(review: Review, binDir: string): string {
  const cli = baseName(review.cli);
  const emitted = TIERS.filter((t) => review.emit.includes(t));

  const rows = emitted.map((t) =>
    `| \`${wrapperName(review.cli, t)}\` | ${t} | ${TIER_MEANING[t]} |`
  ).join("\n");

  const examples = sampleCommands(review, emitted);

  return `## Running ${cli}

Do not run \`${cli}\` directly. Use the wrapper for the smallest tier that does
the job. Each wrapper takes exactly the arguments \`${cli}\` takes.

| Wrapper | Tier | What it permits |
| --- | --- | --- |
${rows}

\`\`\`bash
${examples}
\`\`\`

The wrappers live in \`${binDir}\`. Put that on \`PATH\`, or call them by path.

**Reach for \`${wrapperName(review.cli, "read-safe")}\` first.** It is the only
one allowed to run without asking, so anything it can answer costs no
interruption. The others prompt every time by design — that is what they are
for, not a misconfiguration to work around.

A refusal exits ${REFUSED_EXIT} and prints the reason and the token at fault. It
means the argument is outside the tier, not that the command failed. Two honest
responses: rerun on the next tier up, or tell the user the tier table needs an
edit. Do not route around a refusal by calling \`${cli}\` directly or by its
absolute path.

${helpNote(review)}
To ask whether a command would be permitted without running it:

\`\`\`bash
FKA_CHECK=1 ${
    wrapperName(review.cli, "read-safe")
  } <args>   # prints the verdict, execs nothing
\`\`\`
`;
}

/**
 * Say that help is always available, since the tier table alone implies it is
 * not.
 *
 * Worth spelling out: an agent that reads "safe-gh covers read-safe commands"
 * reasonably concludes it cannot ask about the others, and then either guesses
 * at their arguments or escalates a tier to read a help page.
 */
function helpNote(review: Review): string {
  if (review.helpOptions.length === 0) return "";
  const cli = baseName(review.cli);
  const safe = wrapperName(review.cli, "read-safe");
  const flag = review.helpOptions.includes("--help")
    ? "--help"
    : review.helpOptions[0];
  // The most dangerous command in the table makes the point best: if help
  // reaches that one, the reader stops wondering which ones it reaches.
  const above = review.commands
    .filter((c) => c.path.length > 0 && c.tier !== "read-safe")
    .sort((a, b) => tierRank(b.tier) - tierRank(a.tier))[0];
  const example = above
    ? `${safe} ${above.path.join(" ")} ${flag}`
    : `${safe} ${flag}`;

  return `
**Help always works, at every tier.** Asking ${cli} to describe itself changes
nothing, so ${flag} reaches every command — including the ones this wrapper
will not run.

\`\`\`bash
${example}
\`\`\`

The path opens for the question and nothing else: drop the ${flag} and the same
command is refused again. Read the help here rather than escalating a tier to
find out what a command takes.
`;
}

/** A couple of real commands from the table, so the examples are never invented. */
function sampleCommands(review: Review, emitted: Tier[]): string {
  const lines: string[] = [];
  for (const tier of emitted) {
    const cmd = review.commands.find((c) =>
      c.tier === tier && c.path.length > 0
    );
    if (!cmd) continue;
    lines.push(`${wrapperName(review.cli, tier)} ${cmd.path.join(" ")}`);
  }
  if (lines.length === 0) {
    lines.push(`${wrapperName(review.cli, "read-safe")} --help`);
  }
  return lines.join("\n");
}
