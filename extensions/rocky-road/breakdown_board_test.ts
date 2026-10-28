// Board-surface tests for the breakdown board report.
//
// Colocated per swamp convention: the loader excludes `_test.ts` files from
// discovery, and the archive is built only from typed manifest entries plus
// `additionalFiles`, so this file is never bundled or shipped. It documents
// the board's contract for maintainers of this repo, not for anyone pulling
// the `@skunk-ape/rocky-road` extension.
//
// `report.execute` is the only export. Its internals (`Chunk`, `deriveRows`,
// `readWave`, ...) are not exported, so every case here drives behavior
// through a constructed `ReportContext`-shaped mock rather than importing
// internals directly.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./breakdown_board.ts";

const FACTORY_TYPE = "@swamp/software-factory";

// --- shapes mirroring breakdown_board.ts's internal (unexported) types -----

interface Chunk {
  id: string;
  description?: string;
  dependsOn?: string[];
  origin?: string;
  parentChunk?: string;
  addedReason?: string;
}

interface ChunkProgress {
  id: string;
  status: "pending" | "in_progress" | "done" | "dropped";
  reviewRounds?: number;
  droppedReason?: string;
  note?: string;
}

interface Envelope {
  payload?: Record<string, unknown>;
  stageId?: string;
  recordedAt?: string;
}

interface RowJson {
  id: string;
  state: string;
  reviewRounds: number;
  inWave: boolean;
  blockedBy: string[];
  dependsOn: string[];
  origin: string;
  description: string;
  note?: string;
}

// --- mock harness ------------------------------------------------------------

/**
 * `workItem` is a plain string with no characters `workItemSlug` would
 * rewrite, so the slug equals the work item verbatim and the data-name keys
 * below (`artifact-<slug>-breakdown`, etc.) are exact and predictable.
 */
const WORK_ITEM = "test-item";

function envelopeBytes(env: Envelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(env));
}

interface MockOpts {
  executionStatus?: "succeeded" | "failed";
  errorMessage?: string;
  modelType?: string;
  breakdown?: Envelope | null;
  progress?: Envelope | null;
  state?: Envelope | null;
}

function mockContext(opts: MockOpts) {
  const table: Record<string, Envelope | null | undefined> = {
    [`artifact-${WORK_ITEM}-breakdown`]: opts.breakdown,
    [`artifact-${WORK_ITEM}-progress`]: opts.progress,
    [`state-${WORK_ITEM}`]: opts.state,
  };
  return {
    scope: "method",
    modelType: opts.modelType ?? FACTORY_TYPE,
    modelId: "factory-1",
    methodName: "status",
    executionStatus: opts.executionStatus ?? "succeeded",
    errorMessage: opts.errorMessage,
    methodArgs: { workItem: WORK_ITEM },
    definition: { name: "rocky-road" },
    dataRepository: {
      getContent(
        _type: unknown,
        _modelId: string,
        dataName: string,
        _version?: number,
      ): Promise<Uint8Array | null> {
        const env = table[dataName];
        return Promise.resolve(env ? envelopeBytes(env) : null);
      },
    },
  };
}

function breakdownEnvelope(chunks: Chunk[], recordedAt?: string): Envelope {
  return { payload: { chunks }, recordedAt };
}

function progressEnvelope(
  chunks: ChunkProgress[],
  wave?: { currentChunks?: string[]; currentChunk?: string },
): Envelope {
  return { payload: { chunks, ...wave } };
}

async function rows(result: { json: Record<string, unknown> }) {
  return result.json.chunks as RowJson[];
}

function rowById(list: RowJson[], id: string): RowJson {
  const found = list.find((r) => r.id === id);
  if (!found) throw new Error(`no row for chunk ${id}`);
  return found;
}

// --- 1. derived board state --------------------------------------------------

Deno.test("not_started: chunk with no progress entry and no unmet dependency", async () => {
  const ctx = mockContext({
    breakdown: breakdownEnvelope([{ id: "c1" }]),
    progress: progressEnvelope([]),
  });
  const result = await report.execute(ctx);
  const list = await rows(result);
  assertEquals(rowById(list, "c1").state, "not_started");
});

Deno.test("blocked: chunk with an unmet dependsOn", async () => {
  const ctx = mockContext({
    breakdown: breakdownEnvelope([
      { id: "c1" },
      { id: "c2", dependsOn: ["c1"] },
    ]),
    progress: progressEnvelope([]),
  });
  const result = await report.execute(ctx);
  const list = await rows(result);
  const c2 = rowById(list, "c2");
  assertEquals(c2.state, "blocked");
  assertEquals(c2.blockedBy, ["c1"]);
});

Deno.test("ready: pending chunk once its dependency is recorded done", async () => {
  // Note: a chunk becomes `ready` only when it has a `pending` progress
  // entry AND its dependencies are done. A chunk with NO progress entry at
  // all stays `not_started` (escalating only to `blocked`, never to
  // `ready`) regardless of whether its dependencies are done — see
  // `deriveRows` in breakdown_board.ts: the `!p` branch sets `not_started`
  // unconditionally, and the later escalation only checks `blockedBy.length
  // > 0`, never promoting to `ready`.
  const ctx = mockContext({
    breakdown: breakdownEnvelope([
      { id: "c1" },
      { id: "c2", dependsOn: ["c1"] },
    ]),
    progress: progressEnvelope([
      { id: "c1", status: "done" },
      { id: "c2", status: "pending" },
    ]),
  });
  const result = await report.execute(ctx);
  const list = await rows(result);
  const c2 = rowById(list, "c2");
  assertEquals(c2.state, "ready");
  assertEquals(c2.blockedBy, []);
});

Deno.test("done, dropped, and in_progress are shown directly from recorded progress", async () => {
  const ctx = mockContext({
    breakdown: breakdownEnvelope([
      { id: "c1" },
      { id: "c2" },
      { id: "c3" },
    ]),
    progress: progressEnvelope([
      { id: "c1", status: "done" },
      { id: "c2", status: "dropped", droppedReason: "superseded" },
      { id: "c3", status: "in_progress" },
    ]),
  });
  const result = await report.execute(ctx);
  const list = await rows(result);
  assertEquals(rowById(list, "c1").state, "done");
  assertEquals(rowById(list, "c2").state, "dropped");
  assertEquals(rowById(list, "c3").state, "in_progress");
});

// --- 2 & 3. wave rendering ----------------------------------------------------

Deno.test("wave rendering from currentChunks marks every chunk in the wave", async () => {
  const ctx = mockContext({
    breakdown: breakdownEnvelope([
      { id: "c1" },
      { id: "c2" },
      { id: "c3" },
    ]),
    progress: progressEnvelope(
      [
        { id: "c1", status: "in_progress" },
        { id: "c2", status: "in_progress" },
      ],
      { currentChunks: ["c1", "c2"] },
    ),
  });
  const result = await report.execute(ctx);
  assertEquals(result.json.currentChunks, ["c1", "c2"]);
  const list = await rows(result);
  assertEquals(rowById(list, "c1").inWave, true);
  assertEquals(rowById(list, "c2").inWave, true);
  assertEquals(rowById(list, "c3").inWave, false);
  assertStringIncludes(result.markdown, "**Wave:** c1, c2");
});

Deno.test("wave rendering falls back to the legacy single currentChunk string", async () => {
  const ctx = mockContext({
    breakdown: breakdownEnvelope([
      { id: "c1" },
      { id: "c2" },
    ]),
    progress: progressEnvelope(
      [{ id: "c1", status: "in_progress" }],
      { currentChunk: "c1" },
    ),
  });
  const result = await report.execute(ctx);
  assertEquals(result.json.currentChunks, ["c1"]);
  const list = await rows(result);
  assertEquals(rowById(list, "c1").inWave, true);
  assertEquals(rowById(list, "c2").inWave, false);
  assertStringIncludes(result.markdown, "**Current chunk:** c1");
});

// --- 4. stalled-chunk section -------------------------------------------------

Deno.test("stalled section appears when a chunk's reviewRounds reaches 3", async () => {
  const ctx = mockContext({
    breakdown: breakdownEnvelope([{ id: "c1" }]),
    progress: progressEnvelope([
      { id: "c1", status: "in_progress", reviewRounds: 3 },
    ]),
  });
  const result = await report.execute(ctx);
  assertStringIncludes(result.markdown, "## Needs a human");
  assertStringIncludes(
    result.markdown,
    "**c1** has failed review 3 times",
  );
});

Deno.test("stalled section is absent when no chunk has reached the rework ceiling", async () => {
  const ctx = mockContext({
    breakdown: breakdownEnvelope([{ id: "c1" }]),
    progress: progressEnvelope([
      { id: "c1", status: "in_progress", reviewRounds: 2 },
    ]),
  });
  const result = await report.execute(ctx);
  assertEquals(result.markdown.includes("## Needs a human"), false);
});

// --- 5. silence on a factory with no breakdown artifact -----------------------

Deno.test("stays silent when the factory has no breakdown artifact at all", async () => {
  const ctx = mockContext({
    breakdown: null,
    progress: progressEnvelope([{ id: "c1", status: "done" }]),
    state: { payload: { stageId: "executing" } },
  });
  const result = await report.execute(ctx);
  assertEquals(result, { markdown: "", json: {} });
});
