import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { BotSchema } from "./decl.ts";
import type { Bot } from "./decl.ts";
import {
  renderBot,
  renderChat,
  renderEnvLib,
  renderGateway,
  renderPlist,
  renderProfileFor,
  renderUnit,
} from "./render.ts";
import { unresolvedPlaceholders } from "./proc.ts";
import { directories } from "./provision.ts";

function bot(over: Record<string, unknown> = {}): Bot {
  return BotSchema.parse({
    slug: "demo",
    displayName: "Demo",
    summary: "Demo: general egress, one directory.",
    vault: "demo-secrets",
    telegram: {
      allowedUsers: ["12345"],
      homeChannel: "12345",
      homeChannelName: "DM",
    },
    sandbox: {},
    ...over,
  });
}

// ---------------------------------------------------------------------------
// The invariant that silently voids half a profile
// ---------------------------------------------------------------------------

Deno.test("every entrypoint uses `nono run`, never `nono wrap`", () => {
  const b = bot({
    entrypoints: ["gateway", "chat"],
    chat: { workIn: "$HOME/notes", workInEnvVar: "DEMO_CHAT_DIR" },
  });
  const entrypoints = renderBot(b).filter((f) => f.kind === "entrypoint");
  assertEquals(entrypoints.length, 2);
  for (const f of entrypoints) {
    assertStringIncludes(f.content, "exec nono run -s", f.path);
    // Only the executable lines: every launcher's header explains at length
    // why `nono wrap` is wrong, so a naive search matches the warning itself.
    const code = f.content.split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert(!/nono\s+wrap/.test(code), `${f.path} invokes nono wrap`);
  }
});

Deno.test("the profile records that it requires `nono run`", () => {
  const p = JSON.parse(renderProfileFor(bot(), "darwin").content);
  assertStringIncludes(
    p.meta.description,
    "wrap leaves the network block inert",
  );
});

// ---------------------------------------------------------------------------
// The inner shell
// ---------------------------------------------------------------------------

// This is the bug the prototype shipped: the XDG exports were spliced in above
// the positional-argument assignment, so they expanded to empty and every
// redirected path silently pointed at /hermes/xdg/... instead.
Deno.test("the inner shell binds the workdir before it is used", () => {
  const b = bot({
    entrypoints: ["gateway", "chat"],
    chat: { workIn: "$HOME/notes", workInEnvVar: "DEMO_CHAT_DIR" },
  });
  for (const f of [renderGateway(b), renderChat(b)]) {
    const bind = f.content.indexOf('W="$1"; shift');
    const firstUse = f.content.indexOf('"$W/hermes');
    assert(bind !== -1, `${f.path}: no workdir binding in the inner shell`);
    assert(
      bind < firstUse,
      `${f.path}: $W is used at ${firstUse} before it is bound at ${bind}`,
    );
  }
});

Deno.test("all four XDG homes are redirected inside the inner shell", () => {
  const c = renderGateway(bot()).content;
  const innerStart = c.indexOf("/bin/sh -c");
  for (
    const v of [
      "XDG_STATE_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
    ]
  ) {
    const at = c.indexOf(`export ${v}=`);
    assert(at > innerStart, `${v} is exported outside the inner shell`);
  }
});

// Linux leaves TMPDIR unset, and SQLite then picks /var/tmp — which passes
// access(2) under Landlock and is refused at open, so session writes that
// spill to a temp file fail with "unable to open database file".
Deno.test("TMPDIR points inside the workdir, and the launcher creates it", () => {
  for (
    const f of [
      renderGateway(bot()),
      renderChat(
        bot({
          entrypoints: ["gateway", "chat"],
          chat: { workIn: "$HOME/notes", workInEnvVar: "DEMO_CHAT_DIR" },
        }),
      ),
    ]
  ) {
    const c = f.content;
    const at = c.indexOf('export TMPDIR="$W/hermes/cache/scratch"');
    assert(
      at > c.indexOf("/bin/sh -c"),
      `${f.path}: TMPDIR not in the inner shell`,
    );
  }
  assertStringIncludes(renderEnvLib(bot()).content, "hermes/cache/scratch");
  assert(directories(bot()).includes("hermes/cache/scratch"));
});

// nono keeps its own state root under $XDG_STATE_HOME/nono, so exporting these
// before nono runs makes it refuse the grant and lose its profiles.
Deno.test("the env library does not export XDG homes", () => {
  const c = renderEnvLib(bot()).content;
  assert(!/^\s*export XDG_/m.test(c));
});

// ---------------------------------------------------------------------------
// Per-bot variation
// ---------------------------------------------------------------------------

Deno.test("HF_HUB_OFFLINE appears only when declared", () => {
  assert(!renderEnvLib(bot()).content.includes("HF_HUB_OFFLINE"));
  assertStringIncludes(
    renderEnvLib(bot({ funes: { hfOffline: true } })).content,
    "export HF_HUB_OFFLINE=1",
  );
});

Deno.test("the port-wait loop appears only when MCPs are declared", () => {
  assert(!renderGateway(bot()).content.includes("/dev/tcp"));
  const withMcps = renderGateway(bot({
    mcps: [{ name: "a", port: 8811 }, { name: "b", port: 8813 }],
    sandbox: { openPorts: [8811, 8813] },
  })).content;
  assertStringIncludes(withMcps, 'PORTS="8811 8813"');
  assertStringIncludes(withMcps, "NPORTS=2");
  // bash's own /dev/tcp, not `nc`: netcat is absent on a default Debian or
  // Fedora install, and where it exists its -z is not always the same flag.
  assertStringIncludes(withMcps, '(exec 3<>"/dev/tcp/127.0.0.1/$port")');
  assert(!withMcps.includes("nc -z"));
});

Deno.test("an unrestricted bot emits no allow_domain, so loopback survives", () => {
  // Any allow_domain puts nono in proxy mode, and on Linux that denies direct
  // loopback connect even to a port in open_port — which silently costs a bot
  // every one of its MCPs. ["*"] means "no allowlist", so omitting the key is
  // the same policy and keeps the ports reachable.
  const p = JSON.parse(
    renderProfileFor(
      bot({
        sandbox: { egress: ["*"], openPorts: [8811, 8813] },
      }),
      "linux",
    ).content,
  );
  assert(
    !("allow_domain" in p.network),
    "allow_domain must be absent on linux",
  );
  // connect_port is the Linux allowlist: its own MCPs, plus the ports it needs
  // to reach anything off the machine at all.
  assertEquals(p.network.connect_port, [8811, 8813, 443, 80]);
});

Deno.test("macOS keeps allow_domain and open_port, which is what it enforces with", () => {
  const p = JSON.parse(
    renderProfileFor(
      bot({
        sandbox: { egress: ["*"], openPorts: [8811, 8813] },
      }),
      "darwin",
    ).content,
  );
  // Without allow_domain macOS enforces NOTHING — an undeclared port with a
  // live listener is reachable. Measured; do not "simplify" this away.
  assertEquals(p.network.allow_domain, ["*"]);
  assertEquals(p.network.open_port, [8811, 8813]);
  assert(!("connect_port" in p.network));
});

Deno.test("a bot with no ports KEEPS allow_domain, because the proxy is its loopback boundary", () => {
  // On Linux an empty open_port with no allow_domain is "no port rules", not
  // "deny all". Dropping the key here removed the only confinement Beta had
  // and let the work agent reach the personal agent's credential-holding MCPs.
  const p = JSON.parse(
    renderProfileFor(
      bot({
        sandbox: { egress: ["*"], openPorts: [] },
      }),
      "linux",
    ).content,
  );
  // No MCPs: connect_port lists only the egress ports, so every loopback port
  // is denied by simply never being named.
  assertEquals(p.network.connect_port, [443, 80]);
});

Deno.test("a named allowlist still emits allow_domain", () => {
  const p = JSON.parse(
    renderProfileFor(
      bot({
        sandbox: { egress: ["api.anthropic.com"], openPorts: [] },
      }),
      "linux",
    ).content,
  );
  // A named allowlist needs the proxy to filter by host, so it keeps
  // allow_domain on both platforms — and therefore cannot have loopback ports.
  assertEquals(p.network.allow_domain, ["api.anthropic.com"]);
  assert(!("connect_port" in p.network));
});

Deno.test("the profile carries egress, ports and extra grants verbatim", () => {
  const p = JSON.parse(
    renderProfileFor(
      bot({
        sandbox: {
          egress: ["api.anthropic.com", "api.telegram.org"],
          openPorts: [8811],
          filesystemAllow: ["/Users/x/src/notes-vault"],
        },
      }),
      "darwin",
    ).content,
  );
  assertEquals(p.network.allow_domain, [
    "api.anthropic.com",
    "api.telegram.org",
  ]);
  assertEquals(p.network.open_port, [8811]);
  assertEquals(p.filesystem.allow, ["$WORKDIR", "/Users/x/src/notes-vault"]);
  assertEquals(p.network.block, false);
  assertEquals(p.workdir.access, "readwrite");
});

Deno.test("the workdir override variable is derived from the slug", () => {
  assertStringIncludes(
    renderEnvLib(bot({ slug: "gh-bot" })).content,
    'WORKDIR="${GH_BOT_HOME:-$HOME/agents/gh-bot}"',
  );
});

// A slug with a hyphen cannot name a shell function.
Deno.test("hyphenated slugs produce a legal shell function name", () => {
  const b = bot({ slug: "gh-bot" });
  assertStringIncludes(renderEnvLib(b).content, "gh_bot_env() {");
  assertStringIncludes(renderGateway(b).content, "\ngh_bot_env\n");
});

// ---------------------------------------------------------------------------
// Prose survival
// ---------------------------------------------------------------------------

// Generation that dropped these comments would be a downgrade: in the source
// deployment they are the record of why each boundary is shaped as it is.
Deno.test("declared notes are rendered as comments in the right file", () => {
  const b = bot({
    notes: {
      vault: "Work secrets live in their own vault.",
      telegram: "Its own bot, not another agent's.",
      funes: "Work-only memory.",
      network: "No port-wait loop: this bot has no MCPs.",
    },
    rationale: "Why this bot exists.\nAnd why it is shaped this way.",
  });
  const env = renderEnvLib(b).content;
  assertStringIncludes(env, "  # Work secrets live in their own vault.");
  assertStringIncludes(env, "  # Its own bot, not another agent's.");
  assertStringIncludes(env, "  # Work-only memory.");

  const gw = renderGateway(b).content;
  assertStringIncludes(gw, "# No port-wait loop: this bot has no MCPs.");
  assertStringIncludes(gw, "# Why this bot exists.");
  assertStringIncludes(gw, "# And why it is shaped this way.");
});

Deno.test("a blank line inside a note does not produce trailing whitespace", () => {
  const c = renderGateway(bot({ rationale: "First.\n\nSecond." })).content;
  assertStringIncludes(c, "# First.\n#\n# Second.");
  for (const line of c.split("\n")) {
    assert(!/\s+$/.test(line), `trailing whitespace: ${JSON.stringify(line)}`);
  }
});

// ---------------------------------------------------------------------------
// The systemd unit
// ---------------------------------------------------------------------------

Deno.test("the unit carries placeholders, never a resolved path", () => {
  const u = renderUnit(bot());
  assertEquals(u.path, "systemd/sh.demo.gateway.service");
  assertStringIncludes(u.content, "ExecStart=__REPO__/bin/run-demo.sh");
  assertStringIncludes(u.content, "Environment=HOME=__HOME__");
  // Same guard the installer applies: a committed unit must contain no
  // machine-specific absolute path, or the repository leaks one host's layout.
  assertEquals(
    unresolvedPlaceholders(u.content).sort(),
    ["__HOME__", "__REPO__"],
  );
});

Deno.test("the unit reproduces the plist's restart policy", () => {
  // KeepAlive{SuccessfulExit=false} + ThrottleInterval=10, in systemd's words.
  // Honest only because `nono run` propagates the child's exit code, which is
  // the same reason the plist's KeepAlive means what it says.
  const u = renderUnit(bot()).content;
  assertStringIncludes(u, "Restart=on-failure");
  assertStringIncludes(u, "RestartSec=10");
  assertStringIncludes(u, "WantedBy=default.target");
});

Deno.test("the unit is named for the same label launchd uses", () => {
  // Reusing the label is what lets the status schema, the fleet report and the
  // docs survive the port untouched.
  const b = bot({ slug: "sec-unit" });
  assertEquals(renderUnit(b).path, "systemd/sh.sec-unit.gateway.service");
  assertStringIncludes(
    renderUnit(b).content,
    "StandardOutput=append:__HOME__/agents/sec-unit/logs/sh.sec-unit.gateway.out.log",
  );
});

// ---------------------------------------------------------------------------
// File set
// ---------------------------------------------------------------------------

Deno.test("a gateway-only bot renders both supervisors' units", () => {
  const paths = renderBot(bot()).map((f) => f.path);
  // A plist AND a systemd unit, on whichever platform this runs. Rendering
  // conditionally on the host would make `render --check` report the absent
  // platform's file as drift on every run, on both machines.
  assertEquals(paths, [
    "bin/lib-demo-env.sh",
    "bin/lib-vault.sh",
    "bin/run-demo.sh",
    "launchd/sh.demo.gateway.plist",
    "profiles/demo.darwin.nono.json",
    "profiles/demo.linux.nono.json",
    "systemd/sh.demo.gateway.service",
  ]);
});

Deno.test("a chat entrypoint adds one file", () => {
  const paths = renderBot(bot({
    entrypoints: ["gateway", "chat"],
    chat: { workIn: "$HOME/notes", workInEnvVar: "DEMO_CHAT_DIR" },
  })).map((f) => f.path);
  assert(paths.includes("bin/demo-chat.sh"));
});

Deno.test("launchers are executable, data files are not", () => {
  for (const f of renderBot(bot())) {
    assertEquals(f.mode, f.kind === "entrypoint" ? 0o755 : 0o644, f.path);
  }
});

Deno.test("the plist keeps its placeholders and names the launcher", () => {
  const c = renderPlist(bot()).content;
  assertStringIncludes(c, "<string>__REPO__/bin/run-demo.sh</string>");
  assertStringIncludes(c, "<string>sh.demo.gateway</string>");
  assert(!c.includes("/Users/"), "plist leaked an absolute home path");
});

Deno.test("every rendered file says it is generated", () => {
  for (const f of renderBot(bot())) {
    // The profile is strict JSON and cannot carry a comment, so its marker is
    // inside meta.description rather than above the first line.
    assertStringIncludes(f.content, "GENERATED", f.path);
    assertStringIncludes(f.content, "edit the declaration", f.path);
  }
});

Deno.test("rendering is deterministic", () => {
  const a = renderBot(bot());
  const z = renderBot(bot());
  assertEquals(a.map((f) => f.content), z.map((f) => f.content));
});
