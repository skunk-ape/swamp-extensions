/**
 * Tests for the parts of @skunk-ape/hermes that are worth being wrong about.
 *
 * The methods themselves need a Linux host, so what is testable here is the
 * layer underneath: the escaping, the parsing, and the shell fragments. That is
 * also where the damage lives. A quoting bug in `renderEnvFile` writes a broken
 * API key; a quoting bug in `writeFileScript` writes something else entirely.
 *
 * Several tests run bash for real rather than asserting on generated strings,
 * because "the script I generated looks right" and "the script I generated does
 * the right thing" are different claims and only the second one matters.
 *
 * Run with: ~/.swamp/deno/deno test --allow-run --allow-read --allow-write
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildCommand,
  parseKv,
  runProbe,
  runScript,
  shellEsc,
  stripAnsi,
  writeFileScript,
} from "./_lib/exec.ts";
import {
  HERMES_BIN_FRAGMENT,
  parseHermesVersion,
  renderEnvFile,
  resolveCommitFragment,
  resolveInstallDir,
  transportFor,
  USER_BUS_FRAGMENT,
  validateEnv,
  validatePlatformAllowlists,
} from "./hermes.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

/** Check a script parses as bash without running it. */
async function bashParses(script: string): Promise<boolean> {
  const proc = new Deno.Command("bash", {
    args: ["-n"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = proc.stdin.getWriter();
  await w.write(new TextEncoder().encode(script));
  await w.close();
  const { code, stderr } = await proc.output();
  if (code !== 0) {
    console.error(new TextDecoder().decode(stderr));
  }
  return code === 0;
}

// --- shell escaping ------------------------------------------------------

Deno.test("shellEsc survives a value made of quotes", async () => {
  const nasty = `it's "quoted"; rm -rf /; $(whoami) \`id\` \\ end`;
  const { stdout } = await runScript(`printf '%s' ${shellEsc(nasty)}`);
  assertEquals(stdout, nasty);
});

Deno.test("shellEsc does not let a value become a command", async () => {
  const { stdout } = await runScript(
    `printf '%s' ${shellEsc("$(touch /tmp/hermes-should-not-exist)")}`,
  );
  assertEquals(stdout, "$(touch /tmp/hermes-should-not-exist)");
});

// --- expand_home ---------------------------------------------------------

Deno.test("expand_home expands a leading tilde and nothing else", async () => {
  const { stdout } = await runScript(`
echo "A=$(expand_home '~/.hermes')"
echo "B=$(expand_home '~')"
echo "C=$(expand_home '/opt/hermes')"
echo "D=$(expand_home 'relative/~/path')"
`);
  const kv = parseKv(stdout);
  const home = Deno.env.get("HOME");
  assertEquals(kv.A, `${home}/.hermes`);
  assertEquals(kv.B, home);
  assertEquals(kv.C, "/opt/hermes");
  // A tilde that is not leading is a literal character in a path, not a home
  // directory, and expanding it would corrupt the path.
  assertEquals(kv.D, "relative/~/path");
});

Deno.test("expand_home does not evaluate the path it is given", async () => {
  // The `eval echo` idiom this replaces would run the substitution.
  const { stdout } = await runScript(
    `expand_home '/tmp/$(id -un)/x'`,
  );
  assertEquals(stdout, "/tmp/$(id -un)/x");
});

// --- parseKv -------------------------------------------------------------

Deno.test("parseKv keeps everything after the first equals sign", () => {
  const kv = parseKv("VERSION=Hermes Agent v0.20.4 (2026-08-18)\nA=b=c\n");
  assertEquals(kv.VERSION, "Hermes Agent v0.20.4 (2026-08-18)");
  assertEquals(kv.A, "b=c");
});

Deno.test("parseKv ignores lines that are not answers", () => {
  const kv = parseKv("installing things...\nOK=yes\n=leading\n\n");
  assertEquals(kv.OK, "yes");
  assertEquals(Object.keys(kv).length, 1);
});

Deno.test("parseKv reads an empty value as empty, not missing", () => {
  const kv = parseKv("COMMIT=\n");
  assertEquals(kv.COMMIT, "");
  assert("COMMIT" in kv);
});

// --- stripAnsi -----------------------------------------------------------

Deno.test("stripAnsi removes colour but keeps the text", () => {
  assertEquals(
    stripAnsi("\x1b[0;33m\x1b[1m  Found 3 issue(s)\x1b[0m"),
    "  Found 3 issue(s)",
  );
});

// --- writeFileScript -----------------------------------------------------

Deno.test("writeFileScript writes exact content at the right mode", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/nested/.env`;
  const content = 'KEY="a b"\nOTHER="x\\ny"\n';

  await runScript(writeFileScript(shellEsc(path), content, "0600"));

  assertEquals(await Deno.readTextFile(path), content);
  const mode = (await Deno.stat(path)).mode! & 0o777;
  assertEquals(mode, 0o600);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeFileScript handles non-Latin-1 content", async () => {
  // btoa throws on anything above U+00FF, so this is the test that catches a
  // regression to `btoa(content)`.
  const dir = await Deno.makeTempDir();
  const path = `${dir}/utf8`;
  const content = 'NAME="Ünicode — 日本語 🙂"\n';

  await runScript(writeFileScript(shellEsc(path), content));

  assertEquals(await Deno.readTextFile(path), content);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeFileScript refuses a pre-planted temp symlink", async () => {
  // The attack an earlier revision was open to, and the reason mktemp is used
  // instead of "$dst.tmp.$$". With a predictable temp name, the agent this
  // model gives shell access and a writable data directory can plant a symlink
  // and have every rotated secret written wherever it likes — past the 0600,
  // and permanently, because the following mv leaves the destination a link.
  //
  // Asserting on behaviour rather than on the absence of ".tmp.$$" in the
  // script, so a different predictable scheme fails this too.
  const dir = await Deno.makeTempDir();
  const victim = `${dir}/victim.txt`;
  await Deno.writeTextFile(victim, "ORIGINAL");
  const dst = `${dir}/.env`;

  // Plant every temp name the old scheme could have produced. $$ inside the
  // script is bash's pid, so cover a generous range of plausible pids.
  const { stdout: pidOut } = await runScript(`echo "PID=$$"`);
  const shellPid = Number(parseKv(pidOut).PID);
  for (let p = shellPid - 50; p <= shellPid + 200; p++) {
    try {
      await Deno.symlink(victim, `${dst}.tmp.${p}`);
    } catch { /* already exists, or not permitted — fine */ }
  }

  await runScript(writeFileScript(shellEsc(dst), "SECRET-API-KEY\n", "0600"));

  assertEquals(
    await Deno.readTextFile(victim),
    "ORIGINAL",
    "the secret was written through a planted symlink",
  );
  assertEquals(await Deno.readTextFile(dst), "SECRET-API-KEY\n");
  const info = await Deno.lstat(dst);
  assert(!info.isSymlink, "the destination must not be left as a symlink");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeFileScript leaves no temp file behind", async () => {
  const dir = await Deno.makeTempDir();
  await runScript(writeFileScript(shellEsc(`${dir}/.env`), "x\n", "0600"));
  const left = [];
  for await (const e of Deno.readDir(dir)) left.push(e.name);
  assertEquals(left, [".env"]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("writeFileScript never exposes the content before chmod", () => {
  // The file must exist at 0600 before anything is written into it, so the
  // secret is never briefly world-readable.
  const script = writeFileScript('"$P"', "secret\n", "0600");
  const chmodAt = script.indexOf("chmod");
  const printfAt = script.indexOf("printf");
  assert(chmodAt >= 0 && printfAt >= 0);
  assert(chmodAt < printfAt, "chmod must precede the write");
});

Deno.test("writeFileScript accepts a path the script computed", async () => {
  const dir = await Deno.makeTempDir();
  const { stdout } = await runScript(`
P="${dir}/computed/.env"
${writeFileScript('"$P"', "OK=1\n")}
echo "P=$P"
`);
  assertEquals(parseKv(stdout).P, `${dir}/computed/.env`);
  assertEquals(await Deno.readTextFile(`${dir}/computed/.env`), "OK=1\n");
  await Deno.remove(dir, { recursive: true });
});

// --- runScript / runProbe ------------------------------------------------

Deno.test("runScript throws on a failing step mid-script", async () => {
  let threw = false;
  try {
    await runScript(`echo one\nfalse\necho two`);
  } catch (e) {
    threw = true;
    assertStringIncludes(String(e), "script failed");
  }
  assert(threw, "set -e must turn a failing step into an error");
});

Deno.test("runScript returns when the script exits, even if a child outlives it", async () => {
  // The bug this pins down cost thirteen minutes on the first real install.
  // A grandchild that survives the script inherits the output pipe, so waiting
  // for end-of-file waits forever on a script that already finished. Here the
  // background sleep holds stdout open for 60s; the call must still return in
  // about the drain grace, not in a minute.
  const started = Date.now();
  const { stdout, code } = await runScript(`
# A descendant that outlives the script and keeps the pipe open.
sleep 60 &
disown
echo "DONE=yes"
`);
  const elapsed = Date.now() - started;

  assertEquals(code, 0);
  assertEquals(parseKv(stdout).DONE, "yes");
  assert(
    elapsed < 20000,
    `runScript took ${elapsed}ms — it is waiting for pipe EOF rather than for exit`,
  );
});

Deno.test("runProbe reports a failure as data rather than throwing", async () => {
  const { stdout, code } = await runProbe(`
echo "A=$(false || echo no)"
echo "B=yes"
`);
  assertEquals(code, 0);
  assertEquals(parseKv(stdout).A, "no");
  assertEquals(parseKv(stdout).B, "yes");
});

// --- install directory ---------------------------------------------------

Deno.test("resolveInstallDir mirrors the upstream non-root default", () => {
  // deno-lint-ignore no-explicit-any
  const g = (o: Record<string, string>) => o as any;
  assertEquals(
    resolveInstallDir(g({ dataDir: "~/.hermes", installDir: "" })),
    "~/.hermes/hermes-agent",
  );
  assertEquals(
    resolveInstallDir(g({ dataDir: "/srv/hermes/", installDir: "" })),
    "/srv/hermes/hermes-agent",
  );
  assertEquals(
    resolveInstallDir(g({ dataDir: "~/.hermes", installDir: "/opt/h" })),
    "/opt/h",
  );
});

// --- version parsing -----------------------------------------------------

Deno.test("parseHermesVersion pulls the version out of the real banner", () => {
  // Exactly what the command printed on the test VM.
  assertEquals(
    parseHermesVersion("Hermes Agent v0.20.4 (2026.8.18)"),
    "0.20.4",
  );
  assertEquals(parseHermesVersion("Hermes Agent v1.2.30"), "1.2.30");
});

Deno.test("parseHermesVersion says unknown rather than guessing", () => {
  assertEquals(parseHermesVersion("unknown"), "unknown");
  assertEquals(parseHermesVersion(""), "unknown");
  // The release date is also three dot-separated numbers, so a banner missing
  // its version must report unknown rather than confidently returning the date.
  assertEquals(parseHermesVersion("Hermes Agent (2026.8.18)"), "unknown");
});

// --- env validation ------------------------------------------------------

Deno.test("validateEnv catches a vault reference that did not resolve", () => {
  const problems = validateEnv({
    ANTHROPIC_API_KEY: '${{ vault.get("hermes", "anthropic-key") }}',
  });
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "ANTHROPIC_API_KEY");
  assertStringIncludes(problems[0], "did not resolve");
});

Deno.test("validateEnv rejects keys that are not shell identifiers", () => {
  const problems = validateEnv({ "BAD-KEY": "x", "9LIVES": "x", "OK_1": "x" });
  assertEquals(problems.length, 2);
});

Deno.test("validateEnv passes a normal environment", () => {
  assertEquals(validateEnv({ TELEGRAM_BOT_TOKEN: "123:abc", TZ: "UTC" }), []);
});

// --- transport -----------------------------------------------------------

Deno.test("transportFor defaults to local", () => {
  // deno-lint-ignore no-explicit-any
  const g = (o: Record<string, unknown>) => o as any;
  assertEquals(transportFor(g({ transport: "local" })), { kind: "local" });
});

Deno.test("transportFor carries the host and connect timeout", () => {
  // deno-lint-ignore no-explicit-any
  const g = (o: Record<string, unknown>) => o as any;
  assertEquals(
    transportFor(g({
      transport: "ssh",
      sshHost: "lima-hermes",
      sshConnectTimeoutSeconds: 25,
    })),
    { kind: "ssh", host: "lima-hermes", connectTimeoutSeconds: 25 },
  );
});

Deno.test("local transport runs bash -s", () => {
  assertEquals(buildCommand({ kind: "local" }), {
    bin: "bash",
    args: ["-s"],
  });
});

Deno.test("ssh transport sets BatchMode and nothing about host keys", () => {
  const { bin, args } = buildCommand({
    kind: "ssh",
    host: "example-host",
    connectTimeoutSeconds: 7,
  });
  assertEquals(bin, "ssh");
  assertEquals(args, [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=7",
    "example-host",
    "bash",
    "-s",
  ]);

  // The absences are the point. Forcing StrictHostKeyChecking off — as at least
  // one published SSH extension does — silently disables host verification for
  // every connection, and re-implementing -p/-i would shadow ssh_config with a
  // worse copy of it.
  const joined = args.join(" ");
  assert(!joined.includes("StrictHostKeyChecking"));
  assert(!joined.includes("UserKnownHostsFile"));
  assert(!args.includes("-p"));
  assert(!args.includes("-i"));
  assert(!args.includes("-F"));
});

Deno.test("ssh transport still feeds the script over stdin", () => {
  // `bash -s` at the end is what keeps the script off the command line. Losing
  // it would put every script — including the base64 of a .env — into argv on
  // both machines.
  const { args } = buildCommand({ kind: "ssh", host: "h" });
  assertEquals(args.slice(-2), ["bash", "-s"]);
});

Deno.test("ssh connect timeout defaults and is always an integer", () => {
  assertStringIncludes(
    buildCommand({ kind: "ssh", host: "h" }).args.join(" "),
    "ConnectTimeout=10",
  );
  assertStringIncludes(
    buildCommand({ kind: "ssh", host: "h", connectTimeoutSeconds: 2.7 }).args
      .join(" "),
    "ConnectTimeout=2",
  );
});

// --- messaging allowlists ------------------------------------------------

Deno.test("a platform token with no allowlist is a failure", () => {
  const problems = validatePlatformAllowlists({
    TELEGRAM_BOT_TOKEN: "123:abc",
  });
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "Telegram");
  assertStringIncludes(problems[0], "TELEGRAM_ALLOWED_USERS");
});

Deno.test("a per-platform allowlist satisfies the check", () => {
  assertEquals(
    validatePlatformAllowlists({
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_ALLOWED_USERS: "8675309",
    }),
    [],
  );
  // The group allowlist counts too — a bot that only serves a group is a
  // deliberate configuration, not an oversight.
  assertEquals(
    validatePlatformAllowlists({
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_GROUP_ALLOWED_USERS: "-100123",
    }),
    [],
  );
});

Deno.test("the gateway-wide allowlist satisfies every platform", () => {
  assertEquals(
    validatePlatformAllowlists({
      TELEGRAM_BOT_TOKEN: "123:abc",
      DISCORD_BOT_TOKEN: "xyz",
      GATEWAY_ALLOWED_USERS: "me",
    }),
    [],
  );
});

Deno.test("GATEWAY_ALLOW_ALL_USERS is a deliberate opt-out", () => {
  assertEquals(
    validatePlatformAllowlists({
      TELEGRAM_BOT_TOKEN: "123:abc",
      GATEWAY_ALLOW_ALL_USERS: "true",
    }),
    [],
  );
  // Only an explicit truthy string opts out. "false" must not.
  assertEquals(
    validatePlatformAllowlists({
      TELEGRAM_BOT_TOKEN: "123:abc",
      GATEWAY_ALLOW_ALL_USERS: "false",
    }).length,
    1,
  );
});

Deno.test("WHATSAPP_ENABLED is a flag, not a token", () => {
  // Present-but-false must not count as enabled, or every install that
  // explicitly disables WhatsApp would demand an allowlist for it.
  assertEquals(
    validatePlatformAllowlists({ WHATSAPP_ENABLED: "false" }),
    [],
  );
  assertEquals(
    validatePlatformAllowlists({ WHATSAPP_ENABLED: "true" }).length,
    1,
  );
});

Deno.test("each misconfigured platform is reported separately", () => {
  const problems = validatePlatformAllowlists({
    TELEGRAM_BOT_TOKEN: "a",
    DISCORD_BOT_TOKEN: "b",
    SLACK_BOT_TOKEN: "c",
  });
  assertEquals(problems.length, 3);
});

Deno.test("an empty or whitespace token is not a configured platform", () => {
  assertEquals(validatePlatformAllowlists({ TELEGRAM_BOT_TOKEN: "" }), []);
  assertEquals(validatePlatformAllowlists({ TELEGRAM_BOT_TOKEN: "   " }), []);
});

Deno.test("no messaging configured is not a problem", () => {
  assertEquals(
    validatePlatformAllowlists({ ANTHROPIC_API_KEY: "x", GITHUB_TOKEN: "y" }),
    [],
  );
});

// --- .env rendering ------------------------------------------------------

Deno.test("renderEnvFile escapes so python-dotenv reads the value back", async () => {
  // python-dotenv unescapes \\ \' \" \a \b \f \n \r \t \v inside a
  // double-quoted value and leaves everything else alone. Bash's $'...' applies
  // the same set, which makes it a usable stand-in on a host with no Python.
  //
  // The one place they differ is the apostrophe: it needs no escaping in a
  // dotenv value but terminates a $'...' literal, so the harness escapes it
  // when building the bash literal. That is the test's quoting, not the
  // renderer's — the value under test is still exactly what was written.
  const env = {
    QUOTED: 'has "double" quotes',
    BACKSLASH: "C:\\path\\to",
    NEWLINE: "line1\nline2",
    APOSTROPHE: "it's fine",
    SPACES: "  padded  ",
  };
  const rendered = renderEnvFile(env);

  for (const [key, value] of Object.entries(env)) {
    const line = rendered.split("\n").find((l) => l.startsWith(`${key}=`));
    assert(line, `${key} is missing from the rendered file`);
    const quoted = line!.slice(key.length + 2, -1).replace(/'/g, "\\'");
    const { stdout } = await runScript(`printf '%s' $'${quoted}'`);
    assertEquals(stdout, value, `${key} did not round-trip`);
  }
});

Deno.test("renderEnvFile sorts keys so a re-render diffs cleanly", () => {
  const a = renderEnvFile({ B: "1", A: "2", C: "3" });
  const b = renderEnvFile({ C: "3", A: "2", B: "1" });
  assertEquals(a, b);
  const keys = a.split("\n").filter((l) => l.includes("=")).map((l) =>
    l.split("=")[0]
  );
  assertEquals(keys, ["A", "B", "C"]);
});

Deno.test("renderEnvFile says who wrote the file", () => {
  assertStringIncludes(renderEnvFile({}), "@skunk-ape/hermes");
});

// --- generated shell fragments -------------------------------------------

Deno.test("resolveCommitFragment is valid bash for an awkward ref", async () => {
  for (const ref of ["v2026.8.18", "main", "a".repeat(40), "it's; rm -rf /"]) {
    assert(
      await bashParses(resolveCommitFragment(ref)),
      `fragment for ref ${ref} does not parse`,
    );
  }
});

Deno.test("resolveCommitFragment takes a 40-char SHA at face value", async () => {
  const sha = "e624e9fde561e1add9388384012b295fde669ade";
  // No network: a full SHA short-circuits the ls-remote branch entirely.
  const { stdout } = await runProbe(
    `${resolveCommitFragment(sha)}\necho "COMMIT=$COMMIT"`,
  );
  assertEquals(parseKv(stdout).COMMIT, sha);
});

Deno.test("resolveCommitFragment leaves COMMIT empty for an unresolvable ref", async () => {
  const { stdout } = await runProbe(
    `${
      resolveCommitFragment("no-such-ref-hermes-test")
    }\necho "COMMIT=\${COMMIT:-}"`,
  );
  assertEquals(parseKv(stdout).COMMIT, "");
});

Deno.test("the shared fragments are valid bash", async () => {
  assert(await bashParses(HERMES_BIN_FRAGMENT));
  assert(await bashParses(USER_BUS_FRAGMENT));
});

Deno.test("HERMES_BIN_FRAGMENT reports empty when nothing is installed", async () => {
  const { stdout } = await runProbe(
    `PATH=/nonexistent\nHOME=/nonexistent\n${HERMES_BIN_FRAGMENT}\necho "HERMES_BIN=$HERMES_BIN"`,
  );
  assertEquals(parseKv(stdout).HERMES_BIN, "");
});

// --- ref resolution ------------------------------------------------------

Deno.test("a glob ref is rejected rather than resolved to something", async () => {
  // git ls-remote matches patterns, so an unfiltered ref is a lucky dip: "*"
  // and "v*" resolve to whichever tag sorts first and "?ain" resolves to main.
  // Nothing downstream would notice — the installer gets a real commit, just
  // not the one anyone chose.
  for (const ref of ["*", "v*", "?ain", "v2026.8.[0-9]"]) {
    const { code, stderr } = await runProbe(
      `${resolveCommitFragment(ref)}\necho "COMMIT=\${COMMIT:-}"`,
    );
    assert(code !== 0, `ref ${ref} should be rejected`);
    assertStringIncludes(stderr, "glob character");
  }
});

Deno.test("an ordinary ref is unaffected by the glob check", async () => {
  const { stdout, code } = await runProbe(
    `${resolveCommitFragment("v2026.8.18")}\necho "COMMIT=\${COMMIT:-}"`,
  );
  assertEquals(code, 0);
  assertEquals(
    parseKv(stdout).COMMIT,
    "e624e9fde561e1add9388384012b295fde669ade",
    "the peeled commit for the annotated tag",
  );
});

Deno.test("a full SHA is reported as unverified, not silently trusted", async () => {
  // A commit that is not a ref tip is invisible to ls-remote, so it cannot be
  // confirmed here. Previously "a"x40 resolved to itself and preflight reported
  // success for a commit that exists nowhere.
  const { stdout } = await runProbe(
    `${resolveCommitFragment("a".repeat(40))}
echo "COMMIT=\${COMMIT:-}"
echo "SHA_UNVERIFIED=\${SHA_UNVERIFIED:-no}"`,
  );
  const kv = parseKv(stdout);
  assertEquals(kv.COMMIT, "a".repeat(40));
  assertEquals(kv.SHA_UNVERIFIED, "yes");
});
