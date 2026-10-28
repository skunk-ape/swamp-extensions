// The last few days of sleep, recovery and training, on one page.
//
// Workflow-scoped, because the page joins two behaviors: sleep and recovery
// come from the official server, activities and training load from Training
// Hub. A method-scoped report sees one of them.
//
// Nothing is fetched here. Every number is read from the data the workflow's
// steps wrote, so the page is always traceable to the run that produced it,
// and a step that failed shows up as a gap with its name rather than as a
// quietly shorter table.

import {
  formatClock,
  formatDistance,
  formatPace,
  type UnitSystem,
} from "./_lib/units.ts";

type DataHandle = { name: string; version?: number; specName?: string };

type StepExecution = {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  modelId: string;
  methodName: string;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: DataHandle[];
  globalArgs: Record<string, unknown>;
};

type WorkflowReportContext = {
  scope: "workflow";
  workflowName: string;
  workflowRunId: string;
  workflowStatus: "succeeded" | "failed";
  stepExecutions: StepExecution[];
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
};

// deno-lint-ignore no-explicit-any
type Rec = Record<string, any>;

async function readAll(
  ctx: WorkflowReportContext,
  step: StepExecution,
  specName: string,
): Promise<Rec[]> {
  const out: Rec[] = [];
  for (const h of step.dataHandles.filter((h) => h.specName === specName)) {
    try {
      const raw = await ctx.dataRepository.getContent(
        step.modelType,
        step.modelId,
        h.name,
        h.version,
      );
      if (raw) out.push(JSON.parse(new TextDecoder().decode(raw)));
    } catch {
      // One unreadable record is a gap in a row, not a reason to lose the page.
    }
  }
  return out;
}

/** Records the page is drawn from, already read out of the run's data. */
export type Inputs = {
  units: UnitSystem;
  days: Rec[];
  snapshot: Rec | null;
  metrics: Rec[];
  activities: Rec[];
  failedSteps: string[];
};

const dash = "–";
const v = (x: unknown, suffix = "") =>
  x === null || x === undefined ? dash : `${x}${suffix}`;
const hm = (min: number | null | undefined) =>
  min === null || min === undefined
    ? dash
    : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
const weekday = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });

/** The page itself, from already-read records. Exported for tests. */
export function render(i: Inputs): string {
  const L: string[] = [];
  const days = [...i.days].sort((a, b) => b.date.localeCompare(a.date));
  const latest = days[0];
  const s = i.snapshot;

  L.push(`# COROS — ${s?.today ?? latest?.date ?? "recent"}`);
  L.push("");

  // ---- headline: the five numbers worth reading first -------------------
  const head: string[] = [];
  if (s?.recovery?.percent !== null && s?.recovery?.percent !== undefined) {
    head.push(
      `**Recovery ${s.recovery.percent}%** (${s.recovery.level ?? "?"})`,
    );
  }
  if (latest?.sleep?.score != null) {
    head.push(
      `sleep ${latest.sleep.score} (${hm(latest.sleep.mainAsleepMinutes)})`,
    );
  }
  if (latest?.hrv?.avg != null) {
    const range = latest.hrv.rangeLow != null
      ? ` in ${latest.hrv.rangeLow}-${latest.hrv.rangeHigh}`
      : "";
    head.push(`HRV ${latest.hrv.avg} ms${range} — ${latest.hrv.status ?? "?"}`);
  }
  if (latest?.restingHr != null) head.push(`RHR ${latest.restingHr}`);
  if (latest?.load?.ratio != null) {
    head.push(
      `load ratio ${latest.load.ratio} (${latest.load.comment ?? "?"})`,
    );
  }
  if (head.length) L.push(head.join(" · "), "");

  // ---- sleep and recovery, one row per wake-up day -----------------------
  if (days.length) {
    L.push("## Sleep and recovery", "");
    L.push(
      "| Day | Score | Asleep | Deep | REM | HRV | RHR | Stress | Steps |",
    );
    L.push("| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |");
    for (const d of days) {
      const hrv = d.hrv?.avg != null
        ? `${d.hrv.avg}${
          d.hrv.status && d.hrv.status !== "Normal"
            ? ` (${d.hrv.status.toLowerCase()})`
            : ""
        }`
        : dash;
      L.push(
        `| ${weekday(d.date)} ${d.date.slice(5)} | ${v(d.sleep?.score)} | ${
          hm(d.sleep?.mainAsleepMinutes)
        } | ${v(d.sleep?.deepPct, "%")} | ${
          v(d.sleep?.remPct, "%")
        } | ${hrv} | ${v(d.restingHr)} | ${v(d.stressAvg)} | ${
          d.activity?.steps != null
            ? d.activity.steps.toLocaleString("en-US")
            : dash
        } |`,
      );
    }
    L.push(
      "",
      "Dates are wake-up days: a night's sleep belongs to the morning it ended.",
      "",
    );
  }

  // ---- training ----------------------------------------------------------
  const acts = [...i.activities].sort((a, b) =>
    String(b.startTime).localeCompare(String(a.startTime))
  );
  if (acts.length) {
    L.push("## Activities", "");
    L.push("| When | Sport | Name | Distance | Time | Pace | Avg HR | Load |");
    L.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |");
    for (const a of acts) {
      const when = a.startTime
        ? `${weekday(a.startTime.slice(0, 10))} ${a.startTime.slice(5, 10)}`
        : dash;
      const pace =
        a.distanceMetres > 0 && a.durationSeconds > 0 && a.sportType < 200
          ? formatPace(a.durationSeconds / (a.distanceMetres / 1000), i.units)
          : dash;
      L.push(
        `| ${when} | ${a.sport} | ${a.name || dash} | ${
          a.distanceMetres
            ? formatDistance(Math.round(a.distanceMetres), i.units)
            : dash
        } | ${
          a.durationSeconds ? formatClock(a.durationSeconds) : dash
        } | ${pace} | ${v(a.avgHr)} | ${v(a.trainingLoad)} |`,
      );
    }
    L.push("");
  }

  const metrics = [...i.metrics].sort((a, b) => b.date.localeCompare(a.date));
  if (metrics.length || s?.fitness) {
    L.push("## Load and fitness", "");
    if (metrics.length) {
      L.push("| Day | Load | Acute | Chronic | Ratio | Fatigue |");
      L.push("| --- | ---: | ---: | ---: | ---: | ---: |");
      for (const m of metrics) {
        L.push(
          `| ${weekday(m.date)} ${m.date.slice(5)} | ${v(m.trainingLoad)} | ${
            v(m.acuteLoad)
          } | ${v(m.chronicLoad)} | ${v(m.trainingLoadRatio)} | ${
            v(m.fatigue)
          } |`,
        );
      }
      L.push("");
    }
    const f = s?.fitness;
    if (f) {
      const parts = [
        `VO2max ${v(f.vo2max)}`,
        `running level ${v(f.runningLevel)}`,
      ];
      if (f.thresholdPaceSecPerKm) {
        parts.push(`threshold ${formatPace(f.thresholdPaceSecPerKm, i.units)}`);
      }
      L.push(parts.join(" · "));
      const preds = Object.entries(f.predictions ?? {});
      if (preds.length) {
        L.push(
          "",
          "Predictions: " + preds.map(([k, t]) => `${k} ${t}`).join(", "),
        );
      }
      L.push("");
    }
  }

  if (s?.schedule) {
    L.push("## Coming up", "", "```", s.schedule, "```", "");
  }

  // ---- what is missing, and why -----------------------------------------
  const problems = [
    ...i.failedSteps.map((x) =>
      `step **${x}** failed — its section is missing`
    ),
    ...(s?.errors ?? []).map((e: Rec) =>
      `${e.tool}: ${String(e.error).slice(0, 200)}`
    ),
  ];
  if (problems.length) {
    L.push("## Gaps", "");
    for (const p of problems) L.push(`- ${p}`);
    L.push("");
  }
  return L.join("\n");
}

/** Workflow-scoped report joining the official and Training Hub behaviors. */
export const report = {
  name: "@skunk-ape/coros/recent",
  description:
    "Recent sleep, recovery, HRV, activities and training load from COROS on one page, joined across the official and Training Hub behaviors.",
  scope: "workflow",
  labels: ["coros", "health", "training"],
  execute: async (context: WorkflowReportContext) => {
    const inputs: Inputs = {
      units: "imperial",
      days: [],
      snapshot: null,
      metrics: [],
      activities: [],
      failedSteps: [],
    };
    for (const step of context.stepExecutions) {
      if (!step.modelType.startsWith("@skunk-ape/coros/")) continue;
      if (step.status !== "succeeded") {
        inputs.failedSteps.push(`${step.modelName}.${step.methodName}`);
      }
      if (step.modelType === "@skunk-ape/coros/official") {
        if (step.globalArgs?.units === "metric") inputs.units = "metric";
        inputs.days.push(...await readAll(context, step, "day"));
        inputs.snapshot = (await readAll(context, step, "snapshot"))[0] ??
          inputs.snapshot;
      }
      if (step.modelType === "@skunk-ape/coros/hub") {
        inputs.metrics.push(...await readAll(context, step, "metrics"));
        inputs.activities.push(...await readAll(context, step, "activity"));
      }
    }
    return {
      markdown: render(inputs),
      json: {
        generatedAt: new Date().toISOString(),
        workflowRunId: context.workflowRunId,
        workflowStatus: context.workflowStatus,
        days: inputs.days,
        snapshot: inputs.snapshot,
        metrics: inputs.metrics,
        activities: inputs.activities,
        failedSteps: inputs.failedSteps,
      },
    };
  },
};
