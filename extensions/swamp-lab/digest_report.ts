// The digest page, attached to the workflow run.
//
// The behavior already renders the markdown and stores it with the digest, so
// a `data query` for the stored digest and this report show the same page.
// This only finds the digest step's record and hands its markdown back — so
// whoever runs the workflow gets the page in the run's own output.

type DataHandle = { name: string; version?: number; specName?: string };

type StepExecution = {
  modelType: string;
  modelId: string;
  modelName: string;
  methodName: string;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: DataHandle[];
};

type WorkflowReportContext = {
  workflowRunId: string;
  workflowStatus: string;
  stepExecutions: StepExecution[];
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      name: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
};

/** Workflow-scoped report returning the digest's markdown. */
export const report = {
  name: "@skunk-ape/swamp-lab/digest",
  description:
    "The Swamp Lab digest page: shipped, opened, Stagecraft, repeats, and what lands near your work.",
  scope: "workflow",
  labels: ["swamp-club", "lab", "digest"],
  execute: async (context: WorkflowReportContext) => {
    const failed = context.stepExecutions
      .filter((s) =>
        s.modelType === "@skunk-ape/swamp-lab" && s.status !== "succeeded"
      )
      .map((s) => `${s.modelName}.${s.methodName}`);
    const step = context.stepExecutions.find((s) =>
      s.modelType === "@skunk-ape/swamp-lab" && s.methodName === "digest" &&
      s.status === "succeeded"
    );
    const h = step?.dataHandles.find((d) => d.specName === "digest");
    let markdown = "";
    if (step && h) {
      const raw = await context.dataRepository.getContent(
        step.modelType,
        step.modelId,
        h.name,
        h.version,
      );
      if (raw) {
        markdown = JSON.parse(new TextDecoder().decode(raw)).markdown ?? "";
      }
    }
    if (!markdown) {
      markdown =
        "## Lab\n\n**No digest:** the digest step did not complete. Report this as a coverage gap, not a quiet day.\n";
    }
    if (failed.length) {
      markdown += `\n*Failed steps: ${failed.join(", ")}.*\n`;
    }
    return {
      markdown,
      json: {
        workflowRunId: context.workflowRunId,
        workflowStatus: context.workflowStatus,
        failedSteps: failed,
      },
    };
  },
};
