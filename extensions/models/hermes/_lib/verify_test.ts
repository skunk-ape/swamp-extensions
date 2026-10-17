import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { BotSchema } from "./decl.ts";
import type { Bot } from "./decl.ts";
import {
  buildProbe,
  deniedPaths,
  parseProbeOutput,
  pyLiteral,
  summarize,
} from "./verify.ts";

function bot(over: Record<string, unknown> = {}): Bot {
  return BotSchema.parse({
    slug: "demo",
    displayName: "Demo",
    summary: "Demo.",
    vault: "demo-secrets",
    telegram: {
      allowedUsers: ["1"],
      homeChannel: "1",
      homeChannelName: "DM",
    },
    sandbox: {},
    ...over,
  });
}

const REPO = "/Users/x/src/hermes-ops";

const spec = (
  b: Bot,
  probePort = 9099,
  over: Record<string, unknown> = {},
) => ({
  bot: b,
  workdir: "/Users/x/agents/demo",
  granted: b.sandbox.filesystemAllow.map((path) => ({
    path,
    existsOnHost: true,
  })),
  denied: deniedPaths(REPO).map((path) => ({ path, existsOnHost: true })),
  foreignPorts: [],
  probePort,
  deniedHost: "example.com",
  ...over,
});

// The repo holds the vault material, so an agent that could read it would have
// exactly what the host-side-MCP split exists to keep away from it.
Deno.test("the repo is always a denied path, on either platform", () => {
  for (const platform of ["darwin", "linux"] as const) {
    assert(
      deniedPaths("/Users/x/src/hermes-ops", platform).includes(
        "/Users/x/src/hermes-ops",
      ),
      platform,
    );
  }
});

Deno.test("denied paths cover credentials and keychains", () => {
  const d = deniedPaths("/repo", "darwin");
  for (
    const p of [
      "~/.ssh",
      "~/.aws",
      "~/.config/gh/hosts.yml",
      "~/Library/Keychains",
    ]
  ) {
    assert(d.includes(p), `missing ${p}`);
  }
});

Deno.test("each platform is denied the store that actually holds its secrets", () => {
  // A wrong-platform entry degrades to VACUOUS rather than a false PASS, which
  // is safe — and proves nothing. The point of this list is to prove
  // something, so each platform names the credential store it really has.
  const mac = deniedPaths("/repo", "darwin");
  const linux = deniedPaths("/repo", "linux");
  assert(mac.includes("~/Library/Keychains"));
  assert(!linux.includes("~/Library/Keychains"));
  for (const p of ["~/.gnupg", "~/.local/share/keyrings"]) {
    assert(linux.includes(p), `missing ${p} on linux`);
    assert(!mac.includes(p), `${p} should not be probed on macOS`);
  }
  // The portable ones are on both.
  for (const p of ["~/.ssh", "~/.aws", "~/.config/gh/hosts.yml"]) {
    assert(mac.includes(p) && linux.includes(p), p);
  }
});

Deno.test("an allowlisted bot probes its OWN domains, not a neutral one", () => {
  const p = buildProbe(spec(bot({
    sandbox: { egress: ["api.anthropic.com", "api.telegram.org"] },
  })));
  assertStringIncludes(p, '"api.anthropic.com"');
  assertStringIncludes(p, '"api.telegram.org"');
  assert(
    !p.includes("api.github.com"),
    "used a neutral host for an allowlisted bot",
  );
  assertStringIncludes(p, "UNRESTRICTED = False");
});

Deno.test("an unrestricted bot probes a neutral host and skips the denial check", () => {
  const p = buildProbe(spec(bot()));
  assertStringIncludes(p, "api.github.com");
  assertStringIncludes(p, "UNRESTRICTED = True");
});

Deno.test("declared grants and MCPs reach the probe", () => {
  const p = buildProbe(spec(bot({
    sandbox: { filesystemAllow: ["/Users/x/src/lifeos"], openPorts: [8811] },
    mcps: [{ name: "gh-gate", port: 8811 }],
  })));
  assertStringIncludes(p, '"/Users/x/src/lifeos"');
  assertStringIncludes(p, '[["gh-gate", 8811]]');
});

// A closed port refuses the connection whether or not the sandbox blocks it.
Deno.test("with no listener bound the loopback probe is vacuous", () => {
  const p = buildProbe(spec(bot(), 0));
  assertStringIncludes(p, "PROBE_PORT = 0");
  assertStringIncludes(p, "a closed port proves nothing");
});

Deno.test("output parses into checks", () => {
  const checks = parseProbeOutput(
    "PASS\tworkdir is writable\t\n" +
      "FAIL\t~/.ssh is unreadable\tREAD SUCCEEDED\n" +
      "VACUOUS\t~/.aws is unreadable\tdoes not exist on this host\n" +
      "GAP\tunlisted loopback 9099 is blocked\treachable\n",
  );
  assertEquals(checks.length, 4);
  assertEquals(checks[1].outcome, "FAIL");
  assertEquals(checks[1].detail, "READ SUCCEEDED");
  assertEquals(checks[3].outcome, "GAP");
});

// A probe that crashed must not look like a probe that passed.
Deno.test("unparseable output becomes a failure, not silence", () => {
  const checks = parseProbeOutput(
    "PASS\tworkdir is writable\t\nTraceback (most recent call last):\n  ImportError\n",
  );
  assertEquals(checks.length, 2);
  assertEquals(checks[1].outcome, "FAIL");
  assertStringIncludes(checks[1].detail, "Traceback");
});

Deno.test("empty output is not mistaken for success", () => {
  assertEquals(summarize(parseProbeOutput("")).pass, 0);
});

Deno.test("summary: vacuous does not fail a run, a real failure does", () => {
  const s = summarize(parseProbeOutput(
    "PASS\ta\t\nVACUOUS\tb\t\nGAP\tc\t\n",
  ));
  assertEquals([s.pass, s.fail, s.vacuous, s.gap], [1, 0, 1, 1]);
  assert(s.clean);

  const bad = summarize(parseProbeOutput("PASS\ta\t\nFAIL\tb\t\n"));
  assert(!bad.clean);
  assertEquals(bad.fail, 1);
});

// JSON is close enough to Python to be a trap, and booleans are the trap:
// `true` is a NameError at import, which kills the whole probe before it
// produces a single check.
Deno.test("booleans serialize as Python literals, not JSON", () => {
  assertEquals(pyLiteral(true), "True");
  assertEquals(pyLiteral(false), "False");
  assertEquals(pyLiteral(null), "None");
  assertEquals(pyLiteral([true, "a", 1]), '[True, "a", 1]');
  assertEquals(pyLiteral(["x"]), '["x"]');
  assertEquals(pyLiteral([["gh-gate", 8811]]), '[["gh-gate", 8811]]');
});

Deno.test("the generated probe contains no JSON booleans", () => {
  for (const b of [bot(), bot({ sandbox: { egress: ["a.example"] } })]) {
    const p = buildProbe(spec(b));
    assert(!/=\s*(true|false)\s*$/m.test(p), "emitted a JSON boolean");
    assert(/UNRESTRICTED = (True|False)/.test(p), "no Python boolean found");
  }
});

// From inside the sandbox a denied stat and a missing file look identical, so
// existence is decided on the host and passed in. Getting this wrong reported
// VACUOUS for the single most important denial there is — the repository
// holding the vault.
Deno.test("existence comes from the host, not from inside the sandbox", () => {
  const p = buildProbe(spec(bot()));
  assert(
    !p.includes("if not os.path.exists(p):"),
    "probe decides existence itself",
  );
  assertStringIncludes(p, "for path, exists_on_host in DENIED:");
  assertStringIncludes(p, `["${REPO}", True]`);
});

Deno.test("a path absent on the host is passed through as vacuous", () => {
  const p = buildProbe(spec(bot(), 9099, {
    denied: [{ path: "~/.aws", existsOnHost: false }],
  }));
  assertStringIncludes(p, 'DENIED = [["~/.aws", False]]');
});

// Only a port with a live listener behind it can answer the loopback question.
Deno.test("undeclared ports with live listeners are probed and expected to be blocked", () => {
  const p = buildProbe(spec(bot(), 9099, {
    foreignPorts: [{ port: 8813, label: "gh-gate" }],
  }));
  assertStringIncludes(p, 'FOREIGN_PORTS = [["gh-gate", 8813]]');
  assertStringIncludes(p, "REACHED a service this bot never declared");
});

Deno.test("the probe waits before testing egress, so it cannot blame the sandbox for its own flooding", () => {
  // On Linux, nono's seccomp supervisor rate-limits denials: six back-to-back
  // refusals make EVERY later connect return EPERM, including the one to
  // nono's egress proxy. Without this wait the probe fails its own egress
  // check and reports that a bot with egress ["*"] has no network.
  const p = buildProbe(spec(bot({
    mcps: [{ name: "a", port: 8811 }, { name: "b", port: 8813 }],
    sandbox: { openPorts: [8811, 8813] },
  })));
  assertStringIncludes(p, "DENIED[0] += 1");
  assertStringIncludes(p, "if DENIED[0] > 0:");
  assertStringIncludes(p, "time.sleep(2)");
  // The wait has to come between the two phases, or it buys nothing.
  assert(p.indexOf("if DENIED[0] > 0:") < p.indexOf("--- egress"));
  assert(p.indexOf("--- loopback") < p.indexOf("if DENIED[0] > 0:"));
});
