// @skunk-ape/stef — Simple Technical English Flavored.
//
// A deterministic Simple English linter, plus two ways to drive a rewrite loop
// against it. The linter is always the oracle; only the writer changes.
//
//   tool-call mode  `rewrite` runs the whole loop inside one method by spawning
//                   `claude -p`. One command, and it runs on whatever credential
//                   Claude Code already holds — no vault entry needed.
//
//   referee mode    `start` and `record` hold state and enforce the gates while
//                   the calling agent does the writing. No credential at all —
//                   the same shape @swamp/software-factory uses, where the
//                   engine never executes anything and only refuses to advance.
//
// Findings use the `kind: findings` contract @swamp/software-factory's
// findings-clear gate consumes, so a scripted rule and a judgement-based
// reviewer merge behind one gate.

import { z } from "npm:zod@4";
import { type Check, CHECKS, type Finding, LIMITS, lint } from "./_lib/lint.ts";
import { generate } from "./_lib/generate.ts";
import { type Fix, normalize } from "./_lib/normalize.ts";

const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
type Severity = z.infer<typeof SeveritySchema>;

/** Strict — the software-factory findings artifact rejects extra keys. */
const FindingSchema = z.strictObject({
  id: z.string().min(1),
  severity: SeveritySchema,
  description: z.string().min(1),
  category: z.string().optional(),
  resolved: z.boolean().optional(),
  resolutionNote: z.string().optional(),
});
type ContractFinding = z.infer<typeof FindingSchema>;

/** Every check blocks by default: the skill says fix every finding. */
const DEFAULT_SEVERITIES = Object.fromEntries(
  CHECKS.map((c) => [c, "high"] as const),
) as Record<Check, Severity>;

/** The reason-checked half: what the linter cannot decide. */
const DEFAULT_GUIDANCE =
  `- Active voice. Name the actor. Write "the worker retries the job", not "the job is retried".
- Verbs, not noun forms. Write "compress the file", not "perform compression of the file".
- One word, one meaning. Pick one of delete/remove/drop and hold it across the document.
- One topic per paragraph, about six sentences at most, one new fact per sentence.
- Put the main point first. Give facts in the order the reader needs them.
- Keep the grammar. Short does not mean clipped — keep articles and the word "that".
- Keep a noun cluster to three words. Break a longer one with a preposition.
- No phrasal verbs. "go down" becomes "decrease"; "set up" becomes "install".
- One part of speech per word. "check that X" becomes "make sure that X".
- American spelling.
- State uncertainty in plain words. A ban on "may" is not a ban on doubt: write
  "this can evict the cache" for capability, or "I am not sure whether this
  evicts the cache" for real doubt.`;

const GlobalArgsSchema = z.object({
  /** Sentence limit preset: procedural is 20 words, descriptive is 25. */
  textType: z.enum(["procedural", "descriptive"]).default("descriptive"),
  /** Override the sentence word limit from textType. */
  maxWords: z.number().int().positive().optional(),
  /** Per-check severity. Anything in `blocking` must be fixed. */
  severities: z.record(z.enum(CHECKS), SeveritySchema).default(
    DEFAULT_SEVERITIES,
  ),
  /** Severities that block. */
  blocking: z.array(SeveritySchema).min(1).default(["critical", "high"]),
  /** Rework attempts before the loop gives up and returns its best effort. */
  maxAttempts: z.number().int().min(1).max(10).default(3),
  /**
   * Apply mechanical fixes before `rewrite` and `start` do anything else.
   * On this repository's CLAUDE.md that clears 21 of 35 findings for free.
   */
  normalizeFirst: z.boolean().default(true),
  /** Reason-checked guidance appended to the rewrite system prompt. */
  guidance: z.string().default(DEFAULT_GUIDANCE),
  /** Anti-patterns as wrong/right pairs, steering the model off known habits. */
  antiPatterns: z.array(
    z.strictObject({
      name: z.string().min(1),
      wrong: z.string().min(1),
      right: z.string().min(1),
    }),
  ).default([]),

  // --- tool-call mode only -------------------------------------------------
  model: z.string().default("claude-opus-5"),
  /** Path or command name for the Claude Code binary. */
  claudePath: z.string().default("claude"),
  /** Hard ceiling for a single generation. */
  wallTimeoutMs: z.number().int().positive().default(300_000),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const FindingsSchema = z.object({
  source: z.string(),
  textType: z.string(),
  maxWords: z.number(),
  clean: z.boolean(),
  blockingCount: z.number(),
  findings: z.array(FindingSchema),
});

const RewriteSchema = z.object({
  source: z.string(),
  attempts: z.number(),
  clean: z.boolean(),
  text: z.string(),
  blockingCount: z.number(),
  findings: z.array(FindingSchema),
});

const FixSchema = z.object({ check: z.string(), detail: z.string() });

const NormalizedSchema = z.object({
  source: z.string(),
  fixCount: z.number(),
  clean: z.boolean(),
  blockingCount: z.number(),
  text: z.string(),
  fixes: z.array(FixSchema),
  findings: z.array(FindingSchema),
});

/** Referee-mode state. The driver reads this to learn what to do next. */
const SessionSchema = z.object({
  session: z.string(),
  source: z.string(),
  textType: z.string(),
  maxWords: z.number(),
  phase: z.enum(["reworking", "clean", "exhausted"]),
  attempt: z.number(),
  maxAttempts: z.number(),
  nextAction: z.string(),
  clean: z.boolean(),
  blockingCount: z.number(),
  text: z.string(),
  findings: z.array(FindingSchema),
});
type Session = z.infer<typeof SessionSchema>;

// ---------------------------------------------------------------------------
// Linting glue
// ---------------------------------------------------------------------------

function toContract(
  f: Finding,
  severities: Record<Check, Severity>,
): ContractFinding {
  return {
    id: `STE-${f.check}-L${f.line}`,
    severity: severities[f.check] ?? "high",
    category: f.check,
    description: `line ${f.line}: ${f.message}`,
  };
}

function countBlocking(
  findings: ContractFinding[],
  blocking: Severity[],
): number {
  const set = new Set<string>(blocking);
  return findings.filter((f) => f.resolved !== true && set.has(f.severity))
    .length;
}

interface LintResult {
  findings: ContractFinding[];
  blockingCount: number;
  limit: number;
  textType: "procedural" | "descriptive";
}

/** Lint once, prefixed with a recon entry so a clean pass states what ran. */
function runLint(
  text: string,
  g: GlobalArgs,
  overrides: { textType?: "procedural" | "descriptive"; maxWords?: number },
): LintResult {
  const textType = overrides.textType ?? g.textType;
  const limit = overrides.maxWords ?? g.maxWords ?? LIMITS[textType];
  const raw = lint(text, { maxWords: limit, textType });
  const findings = raw.map((f) => toContract(f, g.severities));

  findings.unshift({
    id: "STE-0",
    severity: "low",
    category: "recon",
    description:
      `Ran ${CHECKS.length} Simple English checks as ${textType} text ` +
      `(sentence limit ${limit} words); ${raw.length} finding(s).`,
    resolved: true,
  });

  return {
    findings,
    blockingCount: countBlocking(findings, g.blocking),
    limit,
    textType,
  };
}

// ---------------------------------------------------------------------------
// Prompting — shared by both modes
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  `You rewrite drafts into Simple English, the ASD-STE100 Simplified Technical English style.

A deterministic linter checks eleven mechanical rules and reports what it finds.
Fix every finding it reports, exactly as reported.

You are also responsible for the rules no linter can judge:

{{GUIDANCE}}

Hard constraints:
- Keep every technical fact, number, identifier, command, flag, file path, and
  code span exactly as written. Never edit inside a code block or inline code.
- Never add information that is not in the source. Never drop information.
- Leave headings, tables, URLs, and blockquotes alone — the linter skips them.

Return only the rewritten text. No preamble, no commentary, no code fences.`;

function buildSystemPrompt(g: GlobalArgs): string {
  let prompt = SYSTEM_PROMPT.replace("{{GUIDANCE}}", g.guidance);
  if (g.antiPatterns.length > 0) {
    const examples = g.antiPatterns
      .map((a) => `### ${a.name}\nWrong: ${a.wrong}\nRight: ${a.right}`)
      .join("\n\n");
    prompt += `\n\nAvoid these known habits:\n\n${examples}`;
  }
  return prompt;
}

/** Findings minus the recon entry, as a prompt-ready list. */
function findingList(findings: ContractFinding[]): string {
  return findings.filter((f) => f.category !== "recon")
    .map((f) => `- ${f.description}`)
    .join("\n");
}

function buildPrompt(
  text: string,
  findings: ContractFinding[],
  attempt: number,
): string {
  if (attempt <= 1) {
    return `Rewrite the following draft into Simple English.\n\n---\n${text}\n---`;
  }
  return `Your rewrite still fails the linter. Fix every finding below without ` +
    `changing the meaning.\n\nLINTER FINDINGS:\n${findingList(findings)}\n\n` +
    `DRAFT TO FIX:\n---\n${text}\n---`;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

async function readSource(
  args: { text?: string; path?: string },
): Promise<{ text: string; source: string }> {
  if (args.text !== undefined && args.path !== undefined) {
    throw new Error("Pass either text or path, not both.");
  }
  if (args.path !== undefined) {
    return { text: await Deno.readTextFile(args.path), source: args.path };
  }
  if (args.text !== undefined) return { text: args.text, source: "<inline>" };
  throw new Error("One of text or path is required.");
}

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;
type ReadResource = (
  instanceName: string,
  version?: number,
) => Promise<Record<string, unknown> | null>;

const InputSchema = z.object({
  text: z.string().optional(),
  path: z.string().optional(),
  textType: z.enum(["procedural", "descriptive"]).optional(),
  maxWords: z.number().int().positive().optional(),
});
type Input = z.infer<typeof InputSchema>;

/** Build the packet a referee-mode driver reads to learn what to do next. */
function sessionPacket(
  base: Omit<Session, "phase" | "nextAction">,
  attempt: number,
  maxAttempts: number,
): Session {
  const phase: Session["phase"] = base.blockingCount === 0
    ? "clean"
    : attempt >= maxAttempts
    ? "exhausted"
    : "reworking";

  const nextAction = phase === "clean"
    ? "Done. The draft passes every blocking check. Use the `text` field."
    : phase === "exhausted"
    ? `Stop. ${attempt} of ${maxAttempts} attempts used and ${base.blockingCount} ` +
      `blocking finding(s) remain. Raise maxAttempts or fix them by hand.`
    : `Rewrite the \`text\` field to fix the ${base.blockingCount} blocking finding(s), ` +
      `then submit it with: swamp model method run <model> record ` +
      `--input session=${base.session} --input text="<your rewrite>". ` +
      `Attempt ${attempt + 1} of ${maxAttempts}.`;

  return { ...base, phase, attempt, maxAttempts, nextAction };
}

export const model = {
  type: "@skunk-ape/stef",
  version: "2026.08.14.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    "findings": {
      description:
        "Simple English lint findings, in the software-factory findings contract.",
      schema: FindingsSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    "rewrite": {
      description:
        "Tool-call mode: the rewritten draft and any findings that survived.",
      schema: RewriteSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    "normalized": {
      description:
        "Mechanically fixed text, the fixes applied, and what still needs judgement.",
      schema: NormalizedSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    "session": {
      description:
        "Referee mode: rewrite-loop state and the next action for the driver.",
      schema: SessionSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
  },
  methods: {
    // --- shared ------------------------------------------------------------
    lint: {
      description:
        "Lint a draft against the eleven mechanical Simple English checks and emit kind: findings. Deterministic — no model call, no credential.",
      arguments: InputSchema,
      execute: async (
        args: Input,
        ctx: { globalArgs: GlobalArgs; writeResource: WriteResource },
      ) => {
        const { text, source } = await readSource(args);
        const result = runLint(text, ctx.globalArgs, args);

        const handle = await ctx.writeResource("findings", "findings-latest", {
          source,
          textType: result.textType,
          maxWords: result.limit,
          clean: result.blockingCount === 0,
          blockingCount: result.blockingCount,
          findings: result.findings,
        });
        return { dataHandles: [handle] };
      },
    },

    normalize: {
      description:
        "Apply the mechanical fixes a script can make without judgement — emphasis punctuation, Latin abbreviations, and unambiguous contractions — then re-lint. Deterministic, no model call, no credential.",
      arguments: InputSchema,
      execute: async (
        args: Input,
        ctx: { globalArgs: GlobalArgs; writeResource: WriteResource },
      ) => {
        const { text, source } = await readSource(args);
        const { text: fixed, fixes } = normalize(text);
        const result = runLint(fixed, ctx.globalArgs, args);

        const handle = await ctx.writeResource(
          "normalized",
          "normalized-latest",
          {
            source,
            fixCount: fixes.length,
            clean: result.blockingCount === 0,
            blockingCount: result.blockingCount,
            text: fixed,
            fixes,
            findings: result.findings,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // --- tool-call mode ----------------------------------------------------
    rewrite: {
      description:
        "Tool-call mode: rewrite a draft and re-lint after each attempt, feeding findings back into the next prompt. Runs the whole loop in one command by spawning `claude -p`.",
      arguments: InputSchema.extend({
        maxAttempts: z.number().int().min(1).max(10).optional(),
      }),
      execute: async (
        args: Input & { maxAttempts?: number },
        ctx: {
          globalArgs: GlobalArgs;
          signal: AbortSignal;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
          writeResource: WriteResource;
        },
      ) => {
        const { text: original, source } = await readSource(args);
        const g = ctx.globalArgs;
        const cap = args.maxAttempts ?? g.maxAttempts;
        const system = buildSystemPrompt(g);

        let current = original;
        let mechanical: Fix[] = [];
        if (g.normalizeFirst) {
          const n = normalize(current);
          current = n.text;
          mechanical = n.fixes;
          ctx.logger.info(
            "Mechanical pass fixed {count} finding(s) before any model call",
            {
              count: mechanical.length,
            },
          );
        }
        let state = runLint(current, g, args);
        let attempts = 0;

        while (state.blockingCount > 0 && attempts < cap) {
          attempts++;
          ctx.logger.info(
            "Simple English attempt {attempt}/{cap}: {blocking} blocking finding(s)",
            { attempt: attempts, cap, blocking: state.blockingCount },
          );

          current = await generate({
            claudePath: g.claudePath,
            model: g.model,
            wallTimeoutMs: g.wallTimeoutMs,
            system,
            prompt: buildPrompt(current, state.findings, attempts),
            signal: ctx.signal,
          });
          state = runLint(current, g, args);
        }

        const handle = await ctx.writeResource("rewrite", "rewrite-latest", {
          source,
          attempts,
          clean: state.blockingCount === 0,
          text: current,
          blockingCount: state.blockingCount,
          findings: state.findings,
        });
        return { dataHandles: [handle] };
      },
    },

    // --- referee mode ------------------------------------------------------
    start: {
      description:
        "Referee mode: open a rewrite session. Lints the draft and records what the driving agent must fix. Executes nothing — no model call, no credential.",
      arguments: InputSchema.extend({
        session: z.string().min(1).default("default"),
        maxAttempts: z.number().int().min(1).max(10).optional(),
      }),
      execute: async (
        args: Input & { session: string; maxAttempts?: number },
        ctx: { globalArgs: GlobalArgs; writeResource: WriteResource },
      ) => {
        const { text: raw, source } = await readSource(args);
        const g = ctx.globalArgs;
        const text = g.normalizeFirst ? normalize(raw).text : raw;
        const result = runLint(text, g, args);

        const packet = sessionPacket(
          {
            session: args.session,
            source,
            textType: result.textType,
            maxWords: result.limit,
            clean: result.blockingCount === 0,
            blockingCount: result.blockingCount,
            text,
            findings: result.findings,
            attempt: 0,
            maxAttempts: 0,
          },
          0,
          args.maxAttempts ?? g.maxAttempts,
        );

        const handle = await ctx.writeResource(
          "session",
          `session-${args.session}`,
          packet,
        );
        return { dataHandles: [handle] };
      },
    },

    record: {
      description:
        "Referee mode: submit the driving agent's rewrite. Re-lints it, counts the attempt against the cap, and refuses once the session is clean or exhausted.",
      arguments: z.object({
        session: z.string().min(1).default("default"),
        text: z.string().min(1),
      }),
      execute: async (
        args: { session: string; text: string },
        ctx: {
          globalArgs: GlobalArgs;
          readResource: ReadResource;
          writeResource: WriteResource;
        },
      ) => {
        const g = ctx.globalArgs;
        const name = `session-${args.session}`;
        const prior = await ctx.readResource(name) as Session | null;
        if (prior === null) {
          throw new Error(`No session "${args.session}" — run start first.`);
        }

        // The gate. The engine cannot make the agent write, but it can refuse
        // to accept another attempt.
        if (prior.phase === "clean") {
          throw new Error(
            `Session "${args.session}" is already clean — nothing to rework.`,
          );
        }
        if (prior.phase === "exhausted") {
          throw new Error(
            `Session "${args.session}" is exhausted at ${prior.attempt}/${prior.maxAttempts} ` +
              `attempts. Raise maxAttempts and run start again to reopen it.`,
          );
        }

        const overrides = {
          textType: prior.textType as "procedural" | "descriptive",
          maxWords: prior.maxWords,
        };
        const result = runLint(args.text, g, overrides);

        const packet = sessionPacket(
          {
            session: prior.session,
            source: prior.source,
            textType: result.textType,
            maxWords: result.limit,
            clean: result.blockingCount === 0,
            blockingCount: result.blockingCount,
            text: args.text,
            findings: result.findings,
            attempt: 0,
            maxAttempts: 0,
          },
          prior.attempt + 1,
          prior.maxAttempts,
        );

        const handle = await ctx.writeResource("session", name, packet);
        return { dataHandles: [handle] };
      },
    },
  },
};
