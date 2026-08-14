// @skunk-ape/stef — Simple Technical English Flavored.
//
// Two methods over one idea: a deterministic linter decides what a script can
// decide, and an LLM reworks the draft until the linter is clean or the attempt
// budget runs out. The split is the design — the linter is the oracle, the model
// is the writer, and neither grades its own work.
//
// Findings use the `kind: findings` contract @swamp/software-factory's
// findings-clear gate consumes, so a scripted rule and a judgement-based
// reviewer merge behind one gate.

import { z } from "npm:zod@4";
import Anthropic from "npm:@anthropic-ai/sdk@0.117.1";
import { CHECKS, type Check, type Finding, lint, LIMITS } from "./_lib/lint.ts";

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

/**
 * Every check blocks by default: the skill says fix every finding. Lower one to
 * `low` to record it without blocking a rewrite.
 */
const DEFAULT_SEVERITIES = Object.fromEntries(
  CHECKS.map((c) => [c, "high"] as const),
) as Record<Check, Severity>;

/** The reason-checked half: what the linter cannot decide. */
const DEFAULT_GUIDANCE = `- Active voice. Name the actor. Write "the worker retries the job", not "the job is retried".
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
  severities: z.record(z.enum(CHECKS), SeveritySchema).default(DEFAULT_SEVERITIES),
  /** Severities that block. */
  blocking: z.array(SeveritySchema).min(1).default(["critical", "high"]),
  /** Rework attempts before `rewrite` returns its best effort. */
  maxAttempts: z.number().int().min(1).max(10).default(3),
  /**
   * Reason-checked guidance appended to the rewrite system prompt — the rules
   * no script can judge (active voice, noun clusters, phrasal verbs, ordering).
   * Defaults to the Simple English skill's own list.
   */
  guidance: z.string().default(DEFAULT_GUIDANCE),
  /** Anti-patterns as wrong/right pairs, steering the model off known habits. */
  antiPatterns: z.array(
    z.strictObject({
      name: z.string().min(1),
      wrong: z.string().min(1),
      right: z.string().min(1),
    }),
  ).default([]),
  model: z.string().default("claude-opus-5"),
  /** Point this at a vault expression, never a literal. */
  apiKey: z.string().default("").meta({ sensitive: true }),
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

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You rewrite drafts into Simple English, the ASD-STE100 Simplified Technical English style.

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

function buildPrompt(text: string, findings: ContractFinding[], attempt: number): string {
  if (attempt === 1) {
    return `Rewrite the following draft into Simple English.\n\n---\n${text}\n---`;
  }
  const list = findings.map((f) => `- ${f.description}`).join("\n");
  return `Your rewrite still fails the linter. Fix every finding below without ` +
    `changing the meaning.\n\nLINTER FINDINGS:\n${list}\n\nDRAFT TO FIX:\n---\n${text}\n---`;
}

// ---------------------------------------------------------------------------
// Glue
// ---------------------------------------------------------------------------

/** Map a linter finding onto the software-factory findings contract. */
function toContract(f: Finding, severities: Record<Check, Severity>): ContractFinding {
  return {
    id: `STE-${f.check}-L${f.line}`,
    severity: severities[f.check] ?? "high",
    category: f.check,
    description: `line ${f.line}: ${f.message}`,
  };
}

function countBlocking(findings: ContractFinding[], blocking: Severity[]): number {
  const set = new Set<string>(blocking);
  return findings.filter((f) => f.resolved !== true && set.has(f.severity)).length;
}

/** Lint once and return contract findings, prefixed with a recon entry. */
function runLint(
  text: string,
  g: GlobalArgs,
  overrides: { textType?: "procedural" | "descriptive"; maxWords?: number },
): { findings: ContractFinding[]; blockingCount: number; limit: number } {
  const textType = overrides.textType ?? g.textType;
  const limit = overrides.maxWords ?? g.maxWords ?? LIMITS[textType];
  const raw = lint(text, { maxWords: limit, textType });
  const findings = raw.map((f) => toContract(f, g.severities));

  // Recon entry first, so a clean pass states what ran instead of returning [].
  findings.unshift({
    id: "STE-0",
    severity: "low",
    category: "recon",
    description:
      `Ran ${CHECKS.length} Simple English checks as ${textType} text ` +
      `(sentence limit ${limit} words); ${raw.length} finding(s).`,
    resolved: true,
  });

  return { findings, blockingCount: countBlocking(findings, g.blocking), limit };
}

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

const InputSchema = z.object({
  text: z.string().optional(),
  path: z.string().optional(),
  textType: z.enum(["procedural", "descriptive"]).optional(),
  maxWords: z.number().int().positive().optional(),
});
type Input = z.infer<typeof InputSchema>;

export const model = {
  type: "@skunk-ape/stef",
  version: "2026.08.14.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "findings": {
      description: "Simple English lint findings, in the software-factory findings contract.",
      schema: FindingsSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    "rewrite": {
      description: "The rewritten draft plus the findings that survived the loop.",
      schema: RewriteSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: {
    lint: {
      description:
        "Lint a draft against the eleven mechanical Simple English checks and emit kind: findings. Deterministic — no model call, no API key needed.",
      arguments: InputSchema,
      execute: async (
        args: Input,
        ctx: { globalArgs: GlobalArgs; writeResource: WriteResource },
      ) => {
        const { text, source } = await readSource(args);
        const { findings, blockingCount, limit } = runLint(text, ctx.globalArgs, args);

        const handle = await ctx.writeResource("findings", "findings-latest", {
          source,
          textType: args.textType ?? ctx.globalArgs.textType,
          maxWords: limit,
          clean: blockingCount === 0,
          blockingCount,
          findings,
        });
        return { dataHandles: [handle] };
      },
    },

    rewrite: {
      description:
        "Rewrite a draft into Simple English, re-linting after each attempt and feeding the findings back into the next prompt. Stops when the lint is clean or maxAttempts is reached.",
      arguments: InputSchema.extend({
        maxAttempts: z.number().int().min(1).max(10).optional(),
      }),
      execute: async (
        args: Input & { maxAttempts?: number },
        ctx: {
          globalArgs: GlobalArgs;
          signal: AbortSignal;
          logger: { info: (msg: string, props?: Record<string, unknown>) => void };
          writeResource: WriteResource;
        },
      ) => {
        const { text: original, source } = await readSource(args);
        const g = ctx.globalArgs;
        const limit = args.maxAttempts ?? g.maxAttempts;

        if (g.apiKey === "") {
          throw new Error(
            "apiKey is empty — set it to a vault expression before running rewrite.",
          );
        }

        const client = new Anthropic({ apiKey: g.apiKey });
        const system = buildSystemPrompt(g);
        let current = original;
        let state = runLint(current, g, args);
        let attempts = 0;

        while (state.blockingCount > 0 && attempts < limit) {
          attempts++;
          ctx.logger.info(
            "Simple English attempt {attempt} of {limit}: {blocking} blocking finding(s)",
            { attempt: attempts, limit, blocking: state.blockingCount },
          );

          const message = await client.messages.create({
            model: g.model,
            max_tokens: 16000,
            system,
            messages: [{
              role: "user",
              content: buildPrompt(current, state.findings.slice(1), attempts),
            }],
          }, { signal: ctx.signal });

          if (message.stop_reason === "refusal") {
            throw new Error(`Rewrite refused on attempt ${attempts}.`);
          }

          const rewritten = message.content
            .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();

          if (rewritten === "") {
            throw new Error(`Model returned no text on attempt ${attempts}.`);
          }

          current = rewritten;
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
  },
};
