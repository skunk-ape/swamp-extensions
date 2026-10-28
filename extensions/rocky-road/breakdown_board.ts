/**
 * Breakdown board for the Rocky Road factory.
 *
 * Joins the agreed chunk list (`breakdown`) with what has actually happened
 * to each chunk (`progress`) and renders the result as a board: a table, a
 * dependency graph, and the set of chunks that were added after the initial
 * decomposition.
 *
 * `status` answers "what stage is this work item in". `summary` answers "what
 * has happened so far". Neither answers "where are the chunks", which is the
 * question a human actually asks mid-run. This report answers that one.
 *
 * Pure projection — no LLM, no model state touched. The same run data always
 * renders the same board.
 *
 * @module
 */

const FACTORY_TYPE = "@swamp/software-factory";

/** Structural slice of swamp's MethodReportContext. */
interface ReportContext {
  scope: string;
  modelType: unknown;
  modelId: string;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  methodArgs: Record<string, unknown>;
  definition?: { name?: string };
  dataRepository: {
    getContent(
      type: unknown,
      modelId: string,
      dataName: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
}

interface Chunk {
  id: string;
  description?: string;
  files?: string[];
  dependsOn?: string[];
  sizeEstimate?: string;
  origin?: string;
  parentChunk?: string;
  addedReason?: string;
}

interface ChunkProgress {
  id: string;
  status: "pending" | "in_progress" | "done" | "dropped";
  reviewRounds?: number;
  actualChanges?: string;
  droppedReason?: string;
  note?: string;
}

/** Derived board state for one chunk — richer than the recorded status. */
type BoardState =
  | "done"
  | "in_progress"
  | "dropped"
  | "ready"
  | "blocked"
  | "not_started";

interface Row {
  chunk: Chunk;
  state: BoardState;
  reviewRounds: number;
  blockedBy: string[];
  /** In the wave under review right now. */
  inWave: boolean;
  note?: string;
}

/**
 * Mirror of the engine's work-item slug. Duplicated rather than imported:
 * this report must not reach into another extension's internals, and the
 * rule (sanitize, FNV-1a suffix when lossy) is stable.
 *
 * @param workItem The raw work-item identifier as passed to the factory.
 * @returns The sanitized slug used to namespace this work item's data
 * (`artifact-<slug>-breakdown`, `artifact-<slug>-progress`, `state-<slug>`).
 */
function workItemSlug(workItem: string): string {
  const sanitized = workItem
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48);
  if (sanitized === workItem) return workItem;
  let hash = 0x811c9dc5;
  for (let i = 0; i < workItem.length; i++) {
    hash ^= workItem.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return sanitized.length > 0
    ? `${sanitized}-${hash.toString(16).padStart(8, "0")}`
    : hash.toString(16).padStart(8, "0");
}

interface Envelope {
  payload?: Record<string, unknown>;
  stageId?: string;
  cycle?: number;
  recordedAt?: string;
}

/**
 * Fetch and parse one named data item from the model's data repository.
 *
 * @param context The report's method context, used for its `dataRepository`,
 * `modelType`, and `modelId`.
 * @param dataName The data item's name (e.g. `artifact-<slug>-breakdown`).
 * @returns The parsed envelope, or `null` if the data does not exist or does
 * not parse as JSON. Never throws.
 */
async function readEnvelope(
  context: ReportContext,
  dataName: string,
): Promise<Envelope | null> {
  try {
    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      dataName,
    );
    if (!raw) return null;
    return JSON.parse(new TextDecoder().decode(raw)) as Envelope;
  } catch {
    return null;
  }
}

const STATE_LABEL: Record<BoardState, string> = {
  done: "done",
  in_progress: "in progress",
  dropped: "dropped",
  ready: "ready",
  blocked: "blocked",
  not_started: "not started",
};

const STATE_MARK: Record<BoardState, string> = {
  done: "x",
  in_progress: ">",
  dropped: "-",
  ready: " ",
  blocked: ".",
  not_started: " ",
};

/**
 * The chunk ids under review right now. `currentChunks` is a wave of chunks
 * worked in parallel; `currentChunk` is the single-chunk form earlier runs
 * recorded, kept readable rather than rendered as an empty wave.
 *
 * @param payload The progress envelope's payload, if any.
 * @returns The ids of the chunks in the current wave, or an empty array if
 * neither `currentChunks` nor `currentChunk` is present.
 */
function readWave(payload: Record<string, unknown> | undefined): string[] {
  const many = payload?.currentChunks;
  if (Array.isArray(many)) return many.filter((id) => typeof id === "string");
  const one = payload?.currentChunk;
  return typeof one === "string" && one.length > 0 ? [one] : [];
}

/**
 * Derive board state. A recorded status wins where it is decisive; `pending`
 * is refined into ready/blocked by resolving dependsOn against what is done.
 *
 * @param chunks The agreed chunk breakdown, in breakdown order.
 * @param progress Per-chunk progress records, keyed by chunk id.
 * @param wave The chunk ids in the wave currently under review.
 * @returns One row per chunk, in the same order as `chunks`, each with a
 * derived {@link BoardState}, resolved blockers, and review-round count.
 */
function deriveRows(
  chunks: Chunk[],
  progress: ChunkProgress[],
  wave: string[],
): Row[] {
  const byId = new Map(progress.map((p) => [p.id, p]));
  const done = new Set(
    progress.filter((p) => p.status === "done" || p.status === "dropped").map(
      (p) => p.id,
    ),
  );

  return chunks.map((chunk) => {
    const p = byId.get(chunk.id);
    const reviewRounds = p?.reviewRounds ?? 0;
    const deps = chunk.dependsOn ?? [];
    const blockedBy = deps.filter((d) => !done.has(d));

    let state: BoardState;
    if (!p) {
      state = "not_started";
    } else if (p.status === "done" || p.status === "dropped") {
      state = p.status;
    } else if (p.status === "in_progress") {
      state = "in_progress";
    } else {
      state = blockedBy.length > 0 ? "blocked" : "ready";
    }
    if (state === "not_started" && blockedBy.length > 0) state = "blocked";

    return {
      chunk,
      state,
      reviewRounds,
      blockedBy,
      inWave: wave.includes(chunk.id),
      note: p?.droppedReason ?? p?.note,
    };
  });
}

/**
 * Render the chunk board as a Markdown table, one row per chunk.
 *
 * @param rows The derived board rows, in display order.
 * @returns The table as a Markdown string (header, separator, and one line
 * per row) — no leading or trailing blank lines.
 */
function renderTable(rows: Row[]): string {
  const lines = [
    "| | Chunk | State | Rounds | Depends on | Description |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    const deps = (r.chunk.dependsOn ?? []).length > 0
      ? (r.chunk.dependsOn ?? [])
        .map((d) => r.blockedBy.includes(d) ? `**${d}**` : d)
        .join(", ")
      : "—";
    // Only surface the counter once it means something; a bolded value is
    // the chunk at its rework ceiling.
    const rounds = r.reviewRounds === 0
      ? "—"
      : r.reviewRounds >= 3
      ? `**${r.reviewRounds}**`
      : String(r.reviewRounds);
    const desc = r.chunk.description ?? "";
    const added = r.chunk.origin && r.chunk.origin !== "initial"
      ? ` _(${r.chunk.origin})_`
      : "";
    // A wave is several chunks under one review. Bolding its members says
    // which chunks that review covers, which the state column cannot.
    const id = r.inWave ? `**${r.chunk.id}**` : r.chunk.id;
    lines.push(
      `| \`${STATE_MARK[r.state]}\` | ${id} | ${
        STATE_LABEL[r.state]
      } | ${rounds} | ${deps} | ${desc}${added} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Render the chunk dependency graph as a Mermaid flowchart, colored by
 * board state.
 *
 * @param rows The derived board rows; each becomes a node, and each
 * `dependsOn` edge becomes an arrow into the dependent chunk.
 * @returns A fenced ```mermaid code block, ready to embed in Markdown.
 */
function renderMermaid(rows: Row[]): string {
  const lines = ["```mermaid", "flowchart LR"];
  for (const r of rows) {
    const label = `${r.chunk.id}<br/>${STATE_LABEL[r.state]}`;
    lines.push(`  ${r.chunk.id}["${label}"]:::${r.state}`);
  }
  for (const r of rows) {
    for (const dep of r.chunk.dependsOn ?? []) {
      lines.push(`  ${dep} --> ${r.chunk.id}`);
    }
  }
  lines.push(
    "  classDef done fill:#d7ebd7,stroke:#4a7a4a,color:#14321a",
    "  classDef in_progress fill:#fde8c8,stroke:#a2621b,color:#3a2408",
    "  classDef ready fill:#e8eef7,stroke:#4a6a9a,color:#12243a",
    "  classDef blocked fill:#eeeeee,stroke:#999999,color:#333333",
    "  classDef dropped fill:#f3d9d4,stroke:#97392c,color:#3a120c",
    "  classDef not_started fill:#f7f7f5,stroke:#bbbbbb,color:#444444",
    "```",
  );
  return lines.join("\n");
}

/**
 * The `@skunk-ape/rocky-road/breakdown-board` report.
 *
 * Registers as a method-scoped report on the `@swamp/software-factory`
 * model. On each qualifying method run it joins the recorded chunk
 * breakdown with recorded per-chunk progress and renders both a Markdown
 * table and a Mermaid dependency graph — see the module doc above for why.
 *
 * All properties are plain data except `execute`, which does the actual
 * projection; see its own doc comment for its early-return behavior.
 */
export const report = {
  name: "@skunk-ape/rocky-road/breakdown-board",
  description:
    "Chunk board for a Rocky Road work item — the agreed breakdown joined with actual per-chunk progress, as a table and a dependency graph",
  scope: "method",
  labels: ["rocky-road", "software-factory", "board"],
  /**
   * Build the breakdown board for one method run.
   *
   * Renders nothing (empty markdown and json) when: the run's model type
   * isn't `@swamp/software-factory`; the method args have no `workItem`
   * (the fleet-wide `status` call); or no breakdown envelope has been
   * recorded for that work item (not a Rocky Road run). When the method
   * itself failed, renders a short "not rendered" placeholder instead of a
   * board, since chunk/progress data from a failed run isn't trustworthy.
   *
   * @param context The method report context: model identity, execution
   * status/error, method args, and the data repository used to read the
   * breakdown, progress, and state envelopes.
   * @returns `markdown` — the rendered board (or `""` when not applicable);
   * `json` — the same data in structured form (or `{}` when not applicable).
   */
  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (String(context.modelType) !== FACTORY_TYPE) {
      return { markdown: "", json: {} };
    }
    const workItem = context.methodArgs.workItem;
    if (typeof workItem !== "string" || workItem.length === 0) {
      // The fleet overview (`status` with no workItem) has no single board.
      return { markdown: "", json: {} };
    }

    const slug = workItemSlug(workItem);
    const breakdownEnv = await readEnvelope(
      context,
      `artifact-${slug}-breakdown`,
    );
    // Not a Rocky Road run — this factory has no breakdown. Stay silent
    // rather than persisting an empty board on every other factory's runs.
    if (!breakdownEnv) return { markdown: "", json: {} };

    if (context.executionStatus !== "succeeded") {
      const error = context.errorMessage ?? "unknown error";
      return {
        markdown:
          `# Breakdown board — ${workItem}\n\n_Not rendered: ${error}_\n`,
        json: { workItem, error },
      };
    }

    const progressEnv = await readEnvelope(
      context,
      `artifact-${slug}-progress`,
    );
    const stateEnv = await readEnvelope(context, `state-${slug}`);

    const chunks = (breakdownEnv.payload?.chunks ?? []) as Chunk[];
    const progress = (progressEnv?.payload?.chunks ?? []) as ChunkProgress[];
    const wave = readWave(progressEnv?.payload);

    const rows = deriveRows(chunks, progress, wave);
    const count = (s: BoardState) => rows.filter((r) => r.state === s).length;

    const tally = (
      [
        ["done", count("done")],
        ["in progress", count("in_progress")],
        ["ready", count("ready")],
        ["blocked", count("blocked")],
        ["not started", count("not_started")],
        ["dropped", count("dropped")],
      ] as const
    ).filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}`).join(" · ");

    const stage = (stateEnv?.payload?.stageId ?? stateEnv?.stageId) as
      | string
      | undefined;

    const header = [
      `# Breakdown board — ${workItem}`,
      "",
      [
        stage ? `**Stage:** ${stage}` : null,
        wave.length > 0
          ? `**${wave.length === 1 ? "Current chunk" : "Wave"}:** ${
            wave.join(", ")
          }`
          : null,
        breakdownEnv.recordedAt
          ? `**Breakdown recorded:** ${breakdownEnv.recordedAt}`
          : null,
      ].filter(Boolean).join(" · "),
      "",
      `**${rows.length} chunks** — ${tally || "nothing recorded yet"}`,
    ].join("\n");

    const added = rows.filter((r) =>
      r.chunk.origin && r.chunk.origin !== "initial"
    );
    const addedSection = added.length === 0 ? "" : [
      "",
      "## Added after the initial breakdown",
      "",
      ...added.map((r) =>
        `- **${r.chunk.id}** (${r.chunk.origin}${
          r.chunk.parentChunk ? ` of ${r.chunk.parentChunk}` : ""
        }) — ${r.chunk.addedReason ?? "no reason recorded"}`
      ),
    ].join("\n");

    const stalled = rows.filter((r) => r.reviewRounds >= 3);
    const stalledSection = stalled.length === 0 ? "" : [
      "",
      "## Needs a human",
      "",
      ...stalled.map((r) =>
        `- **${r.chunk.id}** has failed review ${r.reviewRounds} times — escalate to re-slice, force_rework to grant a round, or adapt to drop it.`
      ),
    ].join("\n");

    const markdown = [
      header,
      "",
      renderTable(rows),
      "",
      renderMermaid(rows),
      addedSection,
      stalledSection,
      "",
    ].join("\n");

    return {
      markdown,
      json: {
        workItem,
        stage,
        currentChunks: wave,
        total: rows.length,
        counts: {
          done: count("done"),
          inProgress: count("in_progress"),
          ready: count("ready"),
          blocked: count("blocked"),
          notStarted: count("not_started"),
          dropped: count("dropped"),
        },
        chunks: rows.map((r) => ({
          id: r.chunk.id,
          state: r.state,
          reviewRounds: r.reviewRounds,
          inWave: r.inWave,
          blockedBy: r.blockedBy,
          dependsOn: r.chunk.dependsOn ?? [],
          origin: r.chunk.origin ?? "initial",
          description: r.chunk.description ?? "",
          note: r.note,
        })),
      },
    };
  },
};
