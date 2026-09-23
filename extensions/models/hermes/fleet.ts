// One table for every bot on the machine.
//
// The question this answers is the one that cannot be answered by reading a
// file: across all the agents running here, which are up, which sandbox is
// wider than the others, and which claims about those sandboxes have actually
// been proven rather than asserted.
//
// It is workflow-scoped because that is the only scope that sees more than one
// model. A method-scoped report sees the execution it is attached to, which is
// one bot; the fleet only exists across the steps of an audit run.
//
// Nothing here re-measures anything. `status`, `verification` and `rendered`
// are written by the methods that did the measuring, and this reads them back
// — so a number in this table is always traceable to the run that produced it.

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

type DataRepository = {
  getContent: (
    type: string,
    modelId: string,
    dataName: string,
    version?: number,
  ) => Promise<Uint8Array | null>;
};

type WorkflowReportContext = {
  scope: "workflow";
  workflowName: string;
  workflowRunId: string;
  workflowStatus: "succeeded" | "failed";
  stepExecutions: StepExecution[];
  dataRepository: DataRepository;
  logger: { info: (m: string, p?: Record<string, unknown>) => void };
};

/** What one bot contributed to this audit. Every field is optional because a
 * step can fail, and a report that assumed otherwise would crash on exactly the
 * run worth reading. */
type BotRow = {
  slug: string;
  displayName: string;
  status?: {
    healthy: boolean;
    problems: string[];
    services: { label: string; state: string | null }[];
    ports: { name: string; liveSession: boolean }[];
  };
  verification?: {
    clean: boolean;
    pass: number;
    fail: number;
    vacuous: number;
    checks: { label: string; outcome: string; detail: string }[];
  };
  rendered?: {
    clean: boolean;
    changedCount: number;
    egress: string[];
    egressUnrestricted: boolean;
    extraFilesystemGrants: string[];
    openPorts: number[];
    mcps: { name: string; port: number }[];
  };
  failedSteps: string[];
};

async function readJson(
  ctx: WorkflowReportContext,
  step: StepExecution,
  specName: string,
): Promise<Record<string, unknown> | null> {
  const handle = step.dataHandles.find((h) => h.specName === specName);
  if (!handle) return null;
  try {
    const raw = await ctx.dataRepository.getContent(
      step.modelType,
      step.modelId,
      handle.name,
      handle.version,
    );
    if (!raw) return null;
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

/** How wide a sandbox is, in one phrase, ordered so the widest sorts first. */
export function egressShape(
  unrestricted: boolean | undefined,
  egress: string[] | undefined,
): string {
  if (unrestricted) return "any host";
  if (!egress || egress.length === 0) return "unknown";
  return `${egress.length} host${egress.length === 1 ? "" : "s"}`;
}

/**
 * One line summarising a bot's state, in the order a reader cares about it:
 * something is broken, then something is unproven, then everything is fine.
 */
export function verdict(row: BotRow): string {
  if (row.failedSteps.length > 0) {
    return `audit incomplete (${row.failedSteps.join(", ")} failed)`;
  }
  if (row.status && !row.status.healthy) {
    return row.status.problems[0] ?? "not healthy";
  }
  if (row.verification && !row.verification.clean) {
    const bad = row.verification.checks.filter((c) => c.outcome === "FAIL");
    return `sandbox claim does not hold: ${bad[0]?.label ?? "unknown"}`;
  }
  if (row.rendered && !row.rendered.clean) {
    return `${row.rendered.changedCount} generated file(s) drifted from the declaration`;
  }
  return "ok";
}

const tick = (b: boolean | undefined) =>
  b === undefined ? "?" : b ? "yes" : "**no**";

/**
 * The fleet, as one table.
 *
 * Workflow-scoped because that is the only scope that sees more than one bot: a
 * method-scoped report sees the execution it is attached to, and "this bot's
 * boundary is wider than it needs to be" is a comparison. Nothing here is
 * re-measured — every number traces back to the `render`, `status` or `verify`
 * run that produced it.
 */
export const report = {
  name: "@skunk-ape/hermes/fleet",
  description:
    "Every Hermes bot on this machine in one table: what is running, how wide each sandbox is, and which claims about those sandboxes were actually proven.",
  scope: "workflow",
  labels: ["hermes", "fleet", "security"],
  execute: async (context: WorkflowReportContext) => {
    const rows = new Map<string, BotRow>();

    for (const step of context.stepExecutions) {
      if (!step.modelType.startsWith("@skunk-ape/hermes/bot")) continue;
      const slug = (step.globalArgs?.slug as string) ?? step.modelName;
      const row = rows.get(slug) ?? {
        slug,
        displayName: (step.globalArgs?.displayName as string) ?? slug,
        failedSteps: [],
      };

      if (step.status !== "succeeded") {
        // A failed verify is itself a finding, so its data is still read below
        // where it exists. The step is recorded either way: a table that
        // silently omitted a bot whose audit crashed would be worse than one
        // that says so.
        row.failedSteps.push(step.methodName);
      }

      const status = await readJson(context, step, "status");
      if (status) row.status = status as unknown as BotRow["status"];
      const verification = await readJson(context, step, "verification");
      if (verification) {
        row.verification = verification as unknown as BotRow["verification"];
      }
      const rendered = await readJson(context, step, "rendered");
      if (rendered) row.rendered = rendered as unknown as BotRow["rendered"];

      rows.set(slug, row);
    }

    const bots = [...rows.values()].sort((a, b) =>
      a.slug.localeCompare(b.slug)
    );

    if (bots.length === 0) {
      return {
        markdown:
          "# Bot fleet\n\nNo `@skunk-ape/hermes/bot` steps ran, so there is nothing to report.\n",
        json: { bots: [], generatedAt: new Date().toISOString() },
      };
    }

    // ---- markdown -------------------------------------------------------
    const lines: string[] = [];
    lines.push("# Bot fleet");
    lines.push("");
    lines.push(
      `Workflow \`${context.workflowName}\` — ${context.workflowStatus}, ${bots.length} bot(s).`,
    );
    lines.push("");

    lines.push("| bot | running | sandbox proven | rendered | verdict |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const b of bots) {
      const running = b.status
        ? `${
          b.status.services.filter((s) => s.state === "running").length
        }/${b.status.services.length}`
        : "?";
      const proven = b.verification
        ? `${b.verification.pass} pass, ${b.verification.fail} fail${
          b.verification.vacuous ? `, ${b.verification.vacuous} vacuous` : ""
        }`
        : "not verified";
      lines.push(
        `| ${b.slug} | ${running} | ${proven} | ${tick(b.rendered?.clean)} | ${
          verdict(b)
        } |`,
      );
    }
    lines.push("");

    // The boundary table is the point of the whole thing: three bots side by
    // side is the only way "this one is wider than it needs to be" is visible.
    lines.push("## Boundaries");
    lines.push("");
    lines.push("| bot | egress | extra filesystem grants | loopback | MCPs |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const b of bots) {
      const r = b.rendered;
      const grants = r?.extraFilesystemGrants?.length
        ? r.extraFilesystemGrants.join(", ")
        : "none";
      const ports = r?.openPorts?.length ? r.openPorts.join(", ") : "none";
      lines.push(
        `| ${b.slug} | ${
          egressShape(r?.egressUnrestricted, r?.egress)
        } | ${grants} | ${ports} | ${r?.mcps?.length ?? 0} |`,
      );
    }
    lines.push("");

    const withProblems = bots.filter((b) =>
      (b.status && !b.status.healthy) ||
      (b.verification && !b.verification.clean) ||
      b.failedSteps.length > 0
    );
    if (withProblems.length > 0) {
      lines.push("## Problems");
      lines.push("");
      for (const b of withProblems) {
        lines.push(`### ${b.displayName} (${b.slug})`);
        lines.push("");
        for (const s of b.failedSteps) lines.push(`- step \`${s}\` failed`);
        for (const p of b.status?.problems ?? []) lines.push(`- ${p}`);
        for (const c of b.verification?.checks ?? []) {
          if (c.outcome === "FAIL") {
            lines.push(`- sandbox: ${c.label} — ${c.detail}`);
          }
        }
        lines.push("");
      }
    }

    // Vacuous checks are not failures and are not evidence either. Surfacing
    // them is the whole reason the outcome exists: a reader who sees only
    // "0 fail" would take a probe that proved nothing for a boundary that
    // holds.
    const vacuous = bots.flatMap((b) =>
      (b.verification?.checks ?? [])
        .filter((c) => c.outcome === "VACUOUS")
        .map((c) => ({ slug: b.slug, ...c }))
    );
    if (vacuous.length > 0) {
      lines.push("## Proved nothing");
      lines.push("");
      lines.push(
        "Not failures, and not evidence either — a check that could not be decided either way.",
      );
      lines.push("");
      for (const v of vacuous) {
        lines.push(`- \`${v.slug}\` ${v.label} — ${v.detail}`);
      }
      lines.push("");
    }

    return {
      markdown: lines.join("\n"),
      json: {
        generatedAt: new Date().toISOString(),
        workflowRunId: context.workflowRunId,
        workflowStatus: context.workflowStatus,
        bots: bots.map((b) => ({
          slug: b.slug,
          displayName: b.displayName,
          verdict: verdict(b),
          healthy: b.status?.healthy ?? null,
          servicesRunning:
            b.status?.services.filter((s) => s.state === "running").length ??
              null,
          servicesTotal: b.status?.services.length ?? null,
          liveSessions: b.status?.ports.filter((p) => p.liveSession).length ??
            null,
          verificationClean: b.verification?.clean ?? null,
          pass: b.verification?.pass ?? null,
          fail: b.verification?.fail ?? null,
          vacuous: b.verification?.vacuous ?? null,
          renderClean: b.rendered?.clean ?? null,
          egress: b.rendered?.egress ?? null,
          egressUnrestricted: b.rendered?.egressUnrestricted ?? null,
          extraFilesystemGrants: b.rendered?.extraFilesystemGrants ?? null,
          openPorts: b.rendered?.openPorts ?? null,
          failedSteps: b.failedSteps,
        })),
        vacuous,
      },
    };
  },
};
