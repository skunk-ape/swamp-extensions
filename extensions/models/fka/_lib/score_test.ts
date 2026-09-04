import { assert, assertEquals } from "jsr:@std/assert@1";
import { defaultWrappers, ReviewSchema, toPolicy, wrapperName } from "./review.ts";
import type { Review, Tier } from "./review.ts";
import type { Invocation } from "./corpus.ts";
import { effectiveArgv, validate } from "./validate.ts";
import {
  agreement,
  falseRefusals,
  type LabelledInvocation,
  leakage,
  wouldPrompt,
} from "./score.ts";

function inv(binary: string, argv: string[], path: string[]): Invocation {
  return { binary, argv, path, raw: [binary, ...argv].join(" "), count: 1 };
}

function review(partial: Partial<Review>): Review {
  return ReviewSchema.parse({
    cli: "git",
    binary: "/usr/bin/git",
    ...partial,
  });
}

// ---------------------------------------------------------------------------
// falseRefusals — the babysitting number
// ---------------------------------------------------------------------------

Deno.test("falseRefusals: a command admitted by a safe wrapper is not one", () => {
  const r = review({
    wrappers: [{
      segment: "safe",
      name: "git",
      purpose: "",
      prepend: [],
      append: [],
      admits: {},
      accepts: "table",
    }],
    commands: [{
      path: ["status"],
      tier: "read-safe",
      summary: "",
      why: "",
      options: {},
      dropped: {},
    }],
  });
  const corpus = [inv("git", ["status"], ["status"])];
  assertEquals(falseRefusals(r, corpus).refusals.length, 0);
});

Deno.test("falseRefusals: a deliberately thin table produces a non-zero count", () => {
  // "log" was never added to the review at all — the table is thin by
  // construction, and every commmand it omits must show up as a refusal.
  const r = review({
    wrappers: [{
      segment: "safe",
      name: "git",
      purpose: "",
      prepend: [],
      append: [],
      admits: {},
      accepts: "table",
    }],
    commands: [{
      path: ["status"],
      tier: "read-safe",
      summary: "",
      why: "",
      options: {},
      dropped: {},
    }],
  });
  const corpus = [
    inv("git", ["status"], ["status"]),
    inv("git", ["log", "--oneline"], ["log"]),
  ];
  const refusals = falseRefusals(r, corpus).refusals;
  assertEquals(refusals.length, 1);
  assertEquals(refusals[0].invocation.path, ["log"]);
});

Deno.test("falseRefusals: a help wrapper never satisfies a real invocation, even when nothing else is safe", () => {
  // Real shape: defaultWrappers("git", "--help") — not a hand-built wrapper
  // list — so the `help` wrapper is present exactly as `generate` would ship
  // it. Both real commands are ask-tier (push is modify, config is escape),
  // so nothing in the table is unattended except `help`. A help wrapper can
  // describe `git push`; it can never run it. Every one of these 65
  // invocations must count as a false refusal in BOTH modes.
  const r = review({
    wrappers: defaultWrappers("git", "--help"),
    commands: [
      {
        path: ["push"],
        tier: "modify",
        summary: "",
        why: "",
        options: {},
        dropped: {},
      },
      {
        path: ["config"],
        tier: "escape",
        summary: "",
        why: "",
        options: {},
        dropped: {},
      },
    ],
  });
  const corpus = [
    ...Array.from({ length: 60 }, () => inv("git", ["push"], ["push"])),
    ...Array.from({ length: 5 }, () => inv("git", ["config"], ["config"])),
  ];

  const bucketResult = falseRefusals(r, corpus);
  assertEquals(bucketResult.mode, "segment-bucket");
  assertEquals(bucketResult.refusals.length, 65);

  // settings mode: grant the help wrapper explicitly (as an operator would),
  // and it must still fail to satisfy any invocation.
  const settingsResult = falseRefusals(r, corpus, {
    allow: ["Bash(fka-help-git:*)"],
  });
  assertEquals(settingsResult.mode, "settings");
  assertEquals(settingsResult.refusals.length, 65);
});

Deno.test("falseRefusals: a command only an ask-tier wrapper admits still counts", () => {
  // "push" is admitted by the write wrapper, but write is not unattended, so
  // this still costs a prompt every time — exactly the babysitting the metric
  // is meant to surface.
  const r = review({
    wrappers: [{
      segment: "write",
      name: "git",
      purpose: "",
      prepend: [],
      append: [],
      admits: {},
      accepts: "table",
    }],
    commands: [{
      path: ["push"],
      tier: "modify",
      summary: "",
      why: "",
      options: {},
      dropped: {},
    }],
  });
  const corpus = [inv("git", ["push"], ["push"])];
  assertEquals(falseRefusals(r, corpus).refusals.length, 1);
});

Deno.test("falseRefusals scopes to the review's own cli in a mixed-tool corpus", () => {
  const r = review({
    wrappers: [{
      segment: "safe",
      name: "git",
      purpose: "",
      prepend: [],
      append: [],
      admits: {},
      accepts: "table",
    }],
    commands: [{
      path: ["status"],
      tier: "read-safe",
      summary: "",
      why: "",
      options: {},
      dropped: {},
    }],
  });
  const corpus = [
    inv("git", ["status"], ["status"]),
    inv("gh", ["pr", "list"], ["pr", "list"]),
  ];
  assertEquals(falseRefusals(r, corpus).refusals.length, 0);
});

// ---------------------------------------------------------------------------
// leakage — a wrapper exceeding its own segment's promise
// ---------------------------------------------------------------------------

Deno.test("leakage: a correctly scoped safe wrapper never leaks", () => {
  const r = review({
    wrappers: [{
      segment: "safe",
      name: "git",
      purpose: "",
      prepend: [],
      append: [],
      admits: {}, // defaults to the segment's own ceiling, read-safe
      accepts: "table",
    }],
    commands: [
      {
        path: ["status"],
        tier: "read-safe",
        summary: "",
        why: "",
        options: {},
        dropped: {},
      },
      {
        path: ["push"],
        tier: "modify",
        summary: "",
        why: "",
        options: {},
        dropped: {},
      },
    ],
  });
  const corpus = [
    inv("git", ["status"], ["status"]),
    inv("git", ["push"], ["push"]),
  ];
  assertEquals(leakage(r, corpus).length, 0);
});

Deno.test("leakage: a deliberately over-broad table produces a non-zero count", () => {
  // A human edit widens the safe wrapper's admits.maxTier past what the
  // "safe" segment promises. toPolicy honours the override, so the wrapper
  // now admits a modify-tiered command — exactly the failure this metric
  // exists to catch.
  const r = review({
    wrappers: [{
      segment: "safe",
      name: "git",
      purpose: "",
      prepend: [],
      append: [],
      admits: { maxTier: "modify" },
      accepts: "table",
    }],
    commands: [
      {
        path: ["status"],
        tier: "read-safe",
        summary: "",
        why: "",
        options: {},
        dropped: {},
      },
      {
        path: ["push"],
        tier: "modify",
        summary: "",
        why: "",
        options: {},
        dropped: {},
      },
    ],
  });
  const corpus = [inv("git", ["push"], ["push"])];
  const leaks = leakage(r, corpus);
  assertEquals(leaks.length, 1);
  assertEquals(leaks[0].commandTier, "modify");
  assertEquals(leaks[0].segmentCeiling, "read-safe");
});

Deno.test("N1: leakage catches a prepend-pinned wrapper too, not just an unpinned one", () => {
  // Same shape as the test above, but the wrapper PINS the leaking command
  // rather than admitting it via a bare table lookup. The corpus can only
  // ever record the full effective argv the wrapper actually ran —
  // ["push"] — never the empty residual the caller typed. Folding
  // `effectiveArgv` over that recorded argv directly (the pre-fix behaviour)
  // doubles the pin to ["push", "push"], which matches no command path at
  // all, so the leak silently disappears instead of being reported.
  const r = review({
    wrappers: [{
      segment: "safe",
      name: "git-push",
      purpose: "",
      prepend: ["push"],
      append: [],
      admits: { maxTier: "modify" },
      accepts: "table",
    }],
    commands: [{
      path: ["push"],
      tier: "modify",
      summary: "",
      why: "",
      options: {},
      dropped: {},
    }],
  });
  const corpus = [inv("git", ["push"], ["push"])];
  const leaks = leakage(r, corpus);
  assertEquals(leaks.length, 1);
  assertEquals(leaks[0].commandTier, "modify");
});

Deno.test("leakage: a help wrapper is exempt, since it has no ceiling to exceed", () => {
  const r = review({
    wrappers: [{
      segment: "help",
      name: "git",
      purpose: "",
      prepend: [],
      append: ["--help"],
      admits: {},
      accepts: "path-only",
    }],
    commands: [
      {
        path: ["push"],
        tier: "escape",
        summary: "",
        why: "",
        options: {},
        dropped: {},
      },
    ],
  });
  const corpus = [inv("git", ["push"], ["push"])];
  assertEquals(leakage(r, corpus).length, 0);
});

// ---------------------------------------------------------------------------
// wouldPrompt — coarse, conservative, and labelled as an estimate
// ---------------------------------------------------------------------------

Deno.test("wouldPrompt marks a literal prefix match as certainly allowed", () => {
  const corpus = [
    inv("git", ["status"], ["status"]),
    inv("git", ["push", "--force"], ["push"]),
  ];
  const estimates = wouldPrompt({ allow: ["Bash(git status:*)"] }, corpus);
  assertEquals(estimates[0].certainlyAllowed, true);
  assertEquals(estimates[1].certainlyAllowed, false);
});

Deno.test("wouldPrompt treats everything as a prompt with no matching allow rule", () => {
  const corpus = [inv("git", ["status"], ["status"])];
  assertEquals(wouldPrompt({}, corpus)[0].certainlyAllowed, false);
  assertEquals(
    wouldPrompt({ allow: ["Bash(gh:*)"] }, corpus)[0].certainlyAllowed,
    false,
  );
});

Deno.test("wouldPrompt ignores non-Bash allow rules rather than mismatching on them", () => {
  const corpus = [inv("git", ["status"], ["status"])];
  const estimates = wouldPrompt({ allow: ["Read(*)", "Bash(git:*)"] }, corpus);
  assertEquals(estimates[0].certainlyAllowed, true);
});

// ---------------------------------------------------------------------------
// agreement — mis-tiering against the hand-labelled fixture
// ---------------------------------------------------------------------------

Deno.test("agreement: a review that matches the fixture reports full agreement", () => {
  const labelled: LabelledInvocation[] = [
    { binary: "git", path: ["status"], tier: "read-safe" },
    { binary: "git", path: ["push"], tier: "modify" },
  ];
  const r = review({
    commands: [
      {
        path: ["status"],
        tier: "read-safe",
        summary: "",
        why: "",
        options: {},
        dropped: {},
      },
      {
        path: ["push"],
        tier: "modify",
        summary: "",
        why: "",
        options: {},
        dropped: {},
      },
    ],
  });
  const result = agreement(r, labelled);
  assertEquals(result.total, 2);
  assertEquals(result.scored, 2);
  assertEquals(result.agreed, 2);
  assertEquals(result.mismatches.length, 0);
  assertEquals(result.missing.length, 0);
});

Deno.test("agreement: a mis-tiered command is reported, not silently averaged away", () => {
  // The classifier put a modify-tier command in read-safe — the exact
  // mistake usage alone can never surface, since usage says only what ran.
  const labelled: LabelledInvocation[] = [
    { binary: "git", path: ["push"], tier: "modify" },
  ];
  const r = review({
    commands: [
      {
        path: ["push"],
        tier: "read-safe",
        summary: "",
        why: "",
        options: {},
        dropped: {},
      },
    ],
  });
  const result = agreement(r, labelled);
  assertEquals(result.agreed, 0);
  assertEquals(result.mismatches.length, 1);
  assertEquals(result.mismatches[0].labelledTier, "modify");
  assertEquals(result.mismatches[0].reviewTier, "read-safe");
});

Deno.test("agreement: a labelled command absent from the review is 'missing', not a mismatch", () => {
  const labelled: LabelledInvocation[] = [
    { binary: "git", path: ["log"], tier: "read-safe" },
  ];
  const r = review({ commands: [] });
  const result = agreement(r, labelled);
  assertEquals(result.scored, 0);
  assertEquals(result.mismatches.length, 0);
  assertEquals(result.missing.length, 1);
});

Deno.test("agreement scopes the fixture to the review's own tool", () => {
  const labelled: LabelledInvocation[] = [
    { binary: "git", path: ["status"], tier: "read-safe" },
    { binary: "gh", path: ["pr", "list"], tier: "read-safe" },
  ];
  const r = review({
    commands: [
      {
        path: ["status"],
        tier: "read-safe",
        summary: "",
        why: "",
        options: {},
        dropped: {},
      },
    ],
  });
  assertEquals(agreement(r, labelled).total, 1);
});

Deno.test("the checked-in labelled fixture parses and scores against a matching review", async () => {
  const url = new URL("../testdata/labelled.json", import.meta.url);
  const raw = JSON.parse(await Deno.readTextFile(url));
  const labelled = raw.entries as LabelledInvocation[];
  assert(
    labelled.length >= 50,
    `expected at least 50 entries, got ${labelled.length}`,
  );

  // Build a review that agrees with the fixture on every git entry. Command
  // entries become commands; option entries become options ON their command,
  // carrying their own tier. Flattening an option entry into a bare command
  // would put it in `missing` and quietly stop testing anything.
  const gitEntries = labelled.filter((l) => l.binary === "git");
  const byPath = new Map<string, {
    path: string[];
    tier: Tier;
    summary: string;
    why: string;
    options: Record<string, { arity: 0 | 1; tier?: Tier }>;
    dropped: Record<string, string>;
  }>();
  for (const l of gitEntries.filter((e) => e.option === undefined)) {
    byPath.set(l.path.join(" "), {
      path: l.path,
      tier: l.tier,
      summary: "",
      why: "",
      options: {},
      dropped: {},
    });
  }
  for (const l of gitEntries.filter((e) => e.option !== undefined)) {
    const cmd = byPath.get(l.path.join(" "));
    assert(cmd, `option entry ${l.option} has no command entry for ${l.path.join(" ")}`);
    cmd.options[l.option!] = { arity: 0, tier: l.tier };
  }
  const r = review({ commands: [...byPath.values()] });
  const result = agreement(r, labelled);
  assertEquals(result.total, gitEntries.length);
  assertEquals(result.agreed, gitEntries.length);
  assertEquals(result.mismatches.length, 0);
  assertEquals(result.missing.length, 0);
});

// ---------------------------------------------------------------------------
// agreement at the option level — where DESIGN.md says the danger actually is
// ---------------------------------------------------------------------------

Deno.test("agreement: an option entry scores against the option's own tier", () => {
  // `swamp extension push` is modify and `--dry-run` on it is not. This is
  // the case no Bash() prefix rule can express, so it is the case the
  // fixture most needs to cover FOR MIS-TIERING DETECTION — `agreement`
  // compares the labelled tier to whatever tier the table carries, at the
  // option granularity, independent of whether that tiering does anything.
  //
  // It does not, by itself: `toPolicy` filters commands by the COMMAND's own
  // tier before it ever looks at an option's tier (review.ts's `toPolicy`),
  // so a `modify`-tiered command is excluded from a `safe`-ceiling wrapper
  // whatever its options say. Tiering `--dry-run` "read-safe" here changes
  // nothing about which wrapper can run it — the mechanism that actually
  // lets it run unattended is a PINNED alias (DESIGN.md, "Pinning beats
  // permitting"), demonstrated in the `falseRefusals` test below this one.
  const labelled: LabelledInvocation[] = [
    { binary: "swamp", path: ["extension", "push"], tier: "modify" },
    {
      binary: "swamp",
      path: ["extension", "push"],
      option: "--dry-run",
      tier: "read-safe",
    },
  ];
  const r = review({
    cli: "swamp",
    commands: [{
      path: ["extension", "push"],
      tier: "modify",
      summary: "",
      why: "",
      options: { "--dry-run": { arity: 0, tier: "read-safe" } },
      dropped: {},
    }],
  });
  const result = agreement(r, labelled);
  assertEquals(result.agreed, 2);
  assertEquals(result.scoredOptions, 1);
  assertEquals(result.mismatches.length, 0);
});

Deno.test("falseRefusals: the pinned-alias mechanism is what actually admits --dry-run unattended", () => {
  // The real answer to "how does `swamp extension push --dry-run` run
  // without a prompt" — a pinned alias, permitted by name in settings.json,
  // not by tiering the option low on a generic write wrapper (see the test
  // above). The alias sits in the `write` segment (segment-bucket mode would
  // never call it unattended), but this operator's settings.json allows this
  // ONE wrapper name specifically while still asking for `write` generally.
  const r = review({
    cli: "swamp",
    wrappers: [{
      segment: "write",
      name: "swamp-push-dry",
      purpose: "swamp extension push --dry-run, and nothing else",
      prepend: [],
      append: ["--dry-run"],
      admits: { paths: [["extension", "push"]] },
      accepts: "table",
    }],
    commands: [{
      path: ["extension", "push"],
      tier: "modify",
      summary: "",
      why: "",
      options: { "--dry-run": { arity: 0, tier: "read-safe" } },
      dropped: {},
    }],
  });
  const corpus = [inv("swamp", ["extension", "push", "--dry-run"], [])];

  const withoutSettings = falseRefusals(r, corpus);
  assertEquals(withoutSettings.mode, "segment-bucket");
  assertEquals(withoutSettings.refusals.length, 1); // write is never unattended here

  const withSettings = falseRefusals(r, corpus, {
    allow: ["Bash(fka-write-swamp-push-dry:*)"],
    ask: ["Bash(fka-write:*)"],
  });
  assertEquals(withSettings.mode, "settings");
  assertEquals(withSettings.refusals.length, 0); // the pinned alias is allowed by name
});

// ---------------------------------------------------------------------------
// N1 — the scorer must agree with the wrapper's own effectiveArgv fold
// ---------------------------------------------------------------------------

/**
 * Drive one corpus invocation through (a) the scorer's path — `falseRefusals`
 * with a settings ruleset that allows exactly this one wrapper by name — and
 * (b) the wrapper's own path — `effectiveArgv(POLICY, Deno.args)` +
 * `validate`, exactly as `wrapper.ts:92-93` runs it, fed the RESIDUAL a
 * caller would actually type at this wrapper — and assert the two verdicts
 * agree.
 *
 * This is finding N1's regression test. Two prior review rounds each found a
 * different way for the scorer to check the wrong vector (a wrong import,
 * then a wrong argument at the right call site); inspection alone did not
 * stop either recurrence, so this pins the equivalence itself rather than
 * any one implementation detail.
 */
function assertScorerAgreesWithWrapper(
  pin: { prepend: string[]; append: string[] },
  residual: string[],
) {
  const r = review({
    cli: "swamp",
    wrappers: [{
      segment: "safe",
      name: "target",
      purpose: "",
      prepend: pin.prepend,
      append: pin.append,
      admits: {},
      accepts: "table",
    }],
    commands: [{
      path: ["model", "list"],
      tier: "read-safe",
      summary: "",
      why: "",
      options: { "--dry-run": { arity: 0, tier: "read-safe" } },
      dropped: {},
    }],
  });
  const spec = r.wrappers[0];
  const policy = toPolicy(r, spec);

  // (b) the wrapper's own path, verbatim per wrapper.ts:92-93.
  const wrapperVerdict = validate(policy, effectiveArgv(policy, residual));

  // A corpus can only ever record what the wrapper actually ran — the full
  // effective argv, folded once — never the caller's bare residual, since
  // nothing outside the wrapper process observes `Deno.args`.
  const recorded = effectiveArgv(policy, residual);
  const corpus = [inv("swamp", recorded, [])];

  // (a) the scorer's path.
  const name = wrapperName(r.prefix, spec.segment, spec.name);
  const result = falseRefusals(r, corpus, { allow: [`Bash(${name}:*)`] });

  assertEquals(
    result.refusals.length === 0,
    wrapperVerdict.ok,
    `scorer disagreed with the wrapper's own verdict for prepend=${
      JSON.stringify(pin.prepend)
    } append=${JSON.stringify(pin.append)}: wrapper.ok=${wrapperVerdict.ok}, ` +
      `scorer admitted=${result.refusals.length === 0}`,
  );
}

Deno.test("N1: falseRefusals agrees with the wrapper's own fold — prepend pin", () => {
  // The pin supplies the whole path; the caller at this wrapper types
  // nothing. Buggy scoring (effectiveArgv over the FULL recorded argv)
  // doubles the pin here and wrongly refuses.
  assertScorerAgreesWithWrapper({ prepend: ["model", "list"], append: [] }, []);
});

Deno.test("N1: falseRefusals agrees with the wrapper's own fold — append pin", () => {
  assertScorerAgreesWithWrapper(
    { prepend: [], append: ["--dry-run"] },
    ["model", "list"],
  );
});

Deno.test("N1: falseRefusals agrees with the wrapper's own fold — unpinned", () => {
  assertScorerAgreesWithWrapper({ prepend: [], append: [] }, [
    "model",
    "list",
  ]);
});

Deno.test("agreement: an option with no tier of its own inherits its command's", () => {
  const labelled: LabelledInvocation[] = [
    { binary: "git", path: ["log"], option: "--oneline", tier: "read-safe" },
  ];
  const r = review({
    commands: [{
      path: ["log"],
      tier: "read-safe",
      summary: "",
      why: "",
      options: { "--oneline": { arity: 0 } },
      dropped: {},
    }],
  });
  const result = agreement(r, labelled);
  assertEquals(result.agreed, 1);
  assertEquals(result.scoredOptions, 1);
});

Deno.test("agreement: an escape-tier option left at its command's tier is a mismatch", () => {
  // `git log` is read-safe and `git log --ext-diff` runs a program of the
  // caller's choosing. A classifier that tiers the command correctly and the
  // option not at all is exactly the failure a command-only fixture misses.
  const labelled: LabelledInvocation[] = [
    { binary: "git", path: ["log"], option: "--ext-diff", tier: "escape" },
  ];
  const r = review({
    commands: [{
      path: ["log"],
      tier: "read-safe",
      summary: "",
      why: "",
      options: { "--ext-diff": { arity: 0 } },
      dropped: {},
    }],
  });
  const result = agreement(r, labelled);
  assertEquals(result.agreed, 0);
  assertEquals(result.mismatches.length, 1);
  assertEquals(result.mismatches[0].option, "--ext-diff");
  assertEquals(result.mismatches[0].labelledTier, "escape");
  assertEquals(result.mismatches[0].reviewTier, "read-safe");
});

Deno.test("agreement: an option the table never allowlisted is missing, not mis-tiered", () => {
  // Absent from the table means refused, which is safe. Counting it as a
  // mis-tier would report a safety failure where there is none.
  const labelled: LabelledInvocation[] = [
    { binary: "git", path: ["log"], option: "--ext-diff", tier: "escape" },
  ];
  const r = review({
    commands: [{
      path: ["log"],
      tier: "read-safe",
      summary: "",
      why: "",
      options: {},
      dropped: {},
    }],
  });
  const result = agreement(r, labelled);
  assertEquals(result.mismatches.length, 0);
  assertEquals(result.missing.length, 1);
  assertEquals(result.missing[0].option, "--ext-diff");
  assertEquals(result.scoredOptions, 0);
});

Deno.test("the shipped fixture carries option-level entries and a real escape sample", () => {
  // Guards the gap this fixture was rebuilt to close: a fixture of bare
  // command paths scores a classifier only where being wrong is cheapest.
  const raw = Deno.readTextFileSync(
    new URL("../testdata/labelled.json", import.meta.url),
  );
  const fixture = JSON.parse(raw) as { entries: LabelledInvocation[] };
  const withOption = fixture.entries.filter((e) => e.option !== undefined);
  const escapes = fixture.entries.filter((e) => e.tier === "escape");
  assert(withOption.length >= 20, "fixture must carry option-level entries");
  assert(escapes.length >= 5, "escape is the tier whose mistakes are worst");
  assert(
    fixture.entries.some((e) =>
      e.binary === "swamp" &&
      e.path.join(" ") === "extension push" &&
      e.option === "--dry-run"
    ),
    "DESIGN.md's motivating case must be in the ground truth",
  );
});
