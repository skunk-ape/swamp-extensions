// One page answering "is it us?": every provider's status, its open incidents,
// and which of them are new since the last check.
//
// Method-scoped, attached to @skunk-ape/is-it-us by default. Nothing is
// fetched here; the page is drawn from the summary record `check` just wrote,
// so it always matches the data the alert was built from.

import type { Incident, Summary } from "./_lib/providers.ts";

type DataHandle = { name: string; version?: number; specName?: string };

type MethodReportContext = {
  scope: "method";
  modelType: string;
  modelId: string;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  dataHandles: DataHandle[];
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
};

const BADGE: Record<string, string> = {
  none: "operational",
  minor: "minor",
  major: "**major**",
  critical: "**critical**",
};

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

const row = (i: Incident, fresh: Set<string>) =>
  `| ${fresh.has(i.id) ? "🆕 " : ""}${cell(i.title)} | ${i.status} | ${
    BADGE[i.impact]
  } | ${i.startedAt.slice(0, 16).replace("T", " ")} | [link](${i.url}) |`;

/** The page itself, from an already-read summary. Exported for tests. */
export function render(s: Summary): string {
  const L: string[] = [];
  const verdict = s.openIncidentCount === 0
    ? "Probably us: every provider reports no open incidents."
    : `Maybe not us: ${s.openIncidentCount} open incident${
      s.openIncidentCount === 1 ? "" : "s"
    } upstream, ${s.newIncidentCount} new since the last check.`;
  L.push(`# Is it us? — ${s.checkedAt.slice(0, 16).replace("T", " ")} UTC`);
  L.push("", verdict, "");

  L.push("| Provider | Status | Open incidents |");
  L.push("| --- | --- | ---: |");
  for (const p of s.providers) {
    const status = p.ok
      ? `${BADGE[p.indicator]} — ${cell(p.description)}`
      : "⚠️ unreachable";
    L.push(`| ${p.name} | ${status} | ${p.ok ? p.openIncidents : "?"} |`);
  }

  const fresh = new Set(s.newIncidents.map((i) => i.id));
  for (const p of s.providers) {
    const mine = s.openIncidents.filter((i) => i.provider === p.provider);
    if (!mine.length) continue;
    L.push("", `## ${p.name}`, "");
    L.push("| Incident | Status | Impact | Started (UTC) | |");
    L.push("| --- | --- | --- | --- | --- |");
    for (const i of mine) L.push(row(i, fresh));
  }

  if (s.failedProviders.length) {
    L.push(
      "",
      `Unreachable this check: ${s.failedProviders.join(", ")}. Their ` +
        "incidents from the previous check are still treated as seen, so a " +
        "recovered page does not re-alert.",
    );
  }
  if (s.resolvedIncidentIds.length) {
    L.push(
      "",
      `Resolved since the last check: ${s.resolvedIncidentIds.length}.`,
    );
  }
  if (s.firstCheck && s.newIncidentCount) {
    L.push(
      "",
      "First check: every open incident counts as new, so this run alerts on " +
        "outages already in progress.",
    );
  }
  return L.join("\n") + "\n";
}

/** Report definition for `@skunk-ape/is-it-us/rollup`. */
export const report = {
  name: "@skunk-ape/is-it-us/rollup",
  description:
    "Roll GitHub, Cloudflare and AWS status into one table, marking incidents new since the last check.",
  scope: "method",
  labels: ["status", "incidents"],
  execute: async (ctx: MethodReportContext) => {
    if (ctx.executionStatus === "failed") {
      return {
        markdown: `# Is it us?\n\nThe check failed: ${
          ctx.errorMessage ?? "unknown error"
        }\n`,
        json: { ok: false, error: ctx.errorMessage ?? "" },
      };
    }
    const h = ctx.dataHandles.find((d) => d.specName === "summary");
    const raw = h
      ? await ctx.dataRepository.getContent(
        ctx.modelType,
        ctx.modelId,
        h.name,
        h.version,
      )
      : null;
    if (!raw) {
      return {
        markdown: "# Is it us?\n\nNo summary was written by this run.\n",
        json: { ok: false },
      };
    }
    const s = JSON.parse(new TextDecoder().decode(raw)) as Summary;
    return {
      markdown: render(s),
      json: {
        ok: true,
        checkedAt: s.checkedAt,
        overall: s.overall,
        openIncidentCount: s.openIncidentCount,
        newIncidentCount: s.newIncidentCount,
        failedProviders: s.failedProviders,
        providers: s.providers,
      },
    };
  },
};
