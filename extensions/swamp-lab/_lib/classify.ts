// Which area of swamp an issue is about, from its title.
//
// Ported from Apalone's swamp_lab_classify.py with the rule table unchanged:
// ordered, additive, case-insensitive, title first (confidence 1.0) and body
// as a fallback (0.5). One thing is deliberately different. The Python
// pipeline stored every hit and later took the "primary" area as the
// highest-confidence tag — and among equal confidences SQLite returned them
// alphabetically, so "ci" beat "stagecraft" on an issue that matched both.
// Twenty-seven Stagecraft issues were filed under another area that way. Here
// the order of `areas` IS rule order, and the primary area is simply the first.

export type Area = { area: string; label: string; confidence: number };

const RULES: Array<[string, string, string]> = [
  [
    "stagecraft",
    "Stagecraft",
    String.raw`\bstagecraft\b|\bgatorwalk[- ]?factory\b|@swamp/stagecraft`,
  ],
  [
    "extension_publish",
    "Extension publish & quality gates",
    String
      .raw`extension (push|publish|promote|quality|fmt|pull|info|source)|\bpush --(dry-run|private|yes)\b|adversarial review|safety analyz|\bscorecard\b|content hash|attestation|acceptance|swamp-extensions`,
  ],
  [
    "registry",
    "Registry & licensing",
    String
      .raw`\bregistry\b|\blicense\b|\bspdx\b|entitlement|private extension|dist-tag|\bosv\b|\byank`,
  ],
  [
    "datastore",
    "Datastore & sync",
    String
      .raw`\bdatastore\b|\bs3-datastore\b|\bgcs\b|\bsync\b|commitPush|pullChanged|litestream|\bv3\b|replicat|\bchunk storage\b|unit ?of ?work|commit log`,
  ],
  [
    "locks",
    "Locks, leases & concurrency",
    String
      .raw`\block\b|\blease\b|\bmutex\b|LOCK_TIMEOUT|\bfencing\b|race\b|concurrent|single-writer|writer-lease`,
  ],
  [
    "serve",
    "Serve runtime & workers",
    String
      .raw`\bserve\b|\bworker\b|\bdispatch\b|heartbeat|\benroll|auto-resume|\bwal\b|ring buffer|\bsink\b|audit (event|chain|log)`,
  ],
  [
    "workflow",
    "Workflow engine & semantics",
    String
      .raw`\bworkflow\b|\bstep\b|\bjob\b|forEach|\bresume\b|\bcancel|\btimeout\b|cleanup job|\bgate\b|\bapproval\b|wait_for_signal|\bsignal\b`,
  ],
  [
    "secrets",
    "Secrets & vault",
    String
      .raw`\bsecret\b|\bvault\b|\bcredential\b|\bapi[- ]?key\b|\bredact|sensitive|typed-secrets|secretspec|\bauth (login|whoami)\b`,
  ],
  [
    "run_history",
    "Run history & indexing",
    String
      .raw`run index|runs-index|run history|\brun doctor\b|repair-by-stat|fingerprint|\bgc\b|garbage collect|retention|\bpurge\b|\bprune\b`,
  ],
  [
    "data_layer",
    "Data layer & queries",
    String
      .raw`\bdata query\b|\bdata get\b|readModelData|\blatest\b marker|is_step_latest|\bversion(ing)? (floor|identity|drift)\b|\bmodel data\b`,
  ],
  [
    "extensions_runtime",
    "Extension runtime & resolution",
    String
      .raw`auto-resolve|extension (catalog|loader|resolution|auto)|unknown model type|\bbundle\b|member collision|serve reload|codegen`,
  ],
  [
    "behavior_rename",
    "model → behavior rename",
    String
      .raw`\bbehaviour?\b.*\brename\b|\brename\b.*\bbehaviour?\b|model → behavior|swamp behaviour`,
  ],
  [
    "platform",
    "Platform & OS support",
    String
      .raw`\bwindows\b|\bmacos\b|\bdarwin\b|\blinux\b|cp1252|drive letter|\bsymlink\b|\bpath (resolution|spelling)\b|realPath`,
  ],
  [
    "ci",
    "CI, tests & verification",
    String
      .raw`\bflaky\b|verify-build|\bci\b|\btest\b|promptfoo|review integrity|\bdeno check\b|property test|ephemeral storage`,
  ],
  [
    "cli_ux",
    "CLI output & DX",
    String
      .raw`\bcli\b|--json\b|exit code|\bhelp text\b|error message|stack trace|\bzod\b|prettifyError|\bbanner\b|\boutput\b|\bprints?\b|\bwarn`,
  ],
  [
    "web",
    "Web, dashboard & studio",
    String
      .raw`\bdashboard\b|\bstudio\b|swamp-club\.com|\bgrafana\b|\bproxy\b|content-encoding|\bcss\b|\bui\b|\bweb\b`,
  ],
  [
    "docs",
    "Docs & manual",
    String
      .raw`^docs?\b|\bmanual\b|\bdocumentation\b|getting-started|\breference\b|\bAGENTS\.md\b|\bCLAUDE\.md\b`,
  ],
  [
    "auth",
    "Auth, grants & access control",
    String
      .raw`\bgrant\b|\bauthz?\b|\bpermission\b|\boauth\b|\bprivilege\b|access (control|list)|\bsudo\b|restricted-model-types`,
  ],
  [
    "observability",
    "Telemetry & observability",
    String
      .raw`\botel\b|\btelemetry\b|traceparent|\btracing\b|\bmetric\b|\bspan\b`,
  ],
];

const COMPILED = RULES.map(([area, label, re]) => ({
  area,
  label,
  re: new RegExp(re, "i"),
}));

const LABELS: Record<string, string> = Object.fromEntries([
  ...RULES.map(([a, l]) => [a, l]),
  ["other", "Other"],
]);

export function labelFor(area: string): string {
  return LABELS[area] ??
    area.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Every area an issue touches, in rule order. Never empty: "other" at worst. */
export function classify(title: string, body = ""): Area[] {
  const out: Area[] = [];
  for (const r of COMPILED) {
    if (r.re.test(title)) {
      out.push({ area: r.area, label: r.label, confidence: 1 });
    } else if (body && r.re.test(body)) {
      out.push({ area: r.area, label: r.label, confidence: 0.5 });
    }
  }
  return out.length ? out : [{ area: "other", label: "Other", confidence: 0 }];
}

/** The area an issue is filed under: the first title hit in rule order. */
export function primaryArea(areas: Area[]): string {
  return (areas.find((a) => a.confidence === 1) ?? areas[0]).area;
}
