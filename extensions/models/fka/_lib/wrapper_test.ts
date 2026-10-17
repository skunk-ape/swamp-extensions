import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  denoFlags,
  REFUSED_EXIT,
  renderSettings,
  renderSkill,
  renderWrapper,
} from "./wrapper.ts";
import { ReviewSchema, toPolicy } from "./review.ts";
import type { Review, WrapperSpec } from "./review.ts";

const VALIDATE = new URL("./validate.ts", import.meta.url);

/** The spec a review carries for one segment. */
function at(segment: WrapperSpec["segment"], from?: Review): WrapperSpec {
  const found = (from ?? review).wrappers.find((s) => s.segment === segment);
  if (!found) throw new Error(`no ${segment} alias in this fixture`);
  return found;
}

const review: Review = ReviewSchema.parse({
  cli: "demo",
  binary: "/usr/bin/demo",
  binaryVersion: "demo 1.2.3",
  generatedAt: "2026-08-22T00:00:00.000Z",
  wrappers: [
    { segment: "help", name: "demo", append: ["--help"], accepts: "path-only" },
    { segment: "safe", name: "demo", admits: { maxTier: "read-safe" } },
    { segment: "private", name: "demo", admits: { maxTier: "read-private" } },
    { segment: "write", name: "demo", admits: { maxTier: "modify" } },
  ],
  env: { scrub: ["DEMO_PAGER", "LD_PRELOAD"], set: { NO_COLOR: "1" } },
  globalOptions: { "--no-color": { arity: 0, tier: "read-safe" } },
  commands: [
    {
      path: ["list"],
      tier: "read-safe",
      summary: "List things",
      why: "reads only",
      options: {
        "--limit": { arity: 1 },
        "--exec": { arity: 1, tier: "escape" },
      },
    },
    {
      path: ["whoami"],
      tier: "read-private",
      why: "prints the logged-in identity",
    },
    { path: ["delete"], tier: "modify", why: "removes a thing" },
  ],
});

// --- the inlined validator ----------------------------------------------

Deno.test("the wrapper carries the validator source verbatim", async () => {
  // The claim the whole design rests on: the parser guarding an allow rule is
  // the module this suite exercises, not a second implementation of it.
  const source = await Deno.readTextFile(VALIDATE);
  const script = renderWrapper(review, at("safe"), source, "/usr/bin/deno");
  assertStringIncludes(script, source.trimEnd());
});

Deno.test("the validator has no imports, so a wrapper needs no network or lockfile", async () => {
  const source = await Deno.readTextFile(VALIDATE);
  const imports = source.split("\n").filter((l) => /^\s*import[\s{]/.test(l));
  assertEquals(imports, []);
});

// --- the shebang ---------------------------------------------------------

Deno.test("the wrapper grants itself the narrowest permissions that work", () => {
  const flags = denoFlags(toPolicy(review, at("safe")));
  // Naming the one binary is a real boundary: a wrapper that is somehow talked
  // into spawning cannot spawn anything else.
  assert(flags.includes("--allow-run=/usr/bin/demo"));
  assert(!flags.includes("--allow-run"));
  assert(!flags.some((f) => f.startsWith("--allow-net")));
  assert(!flags.some((f) => f.startsWith("--allow-write")));
  assert(!flags.some((f) => f.startsWith("--allow-read")));
  assert(!flags.some((f) => f.startsWith("--allow-ffi")));
  assert(!flags.includes("-A"));
});

Deno.test("the binary is embedded absolute, so PATH cannot be re-aimed", async () => {
  const source = await Deno.readTextFile(VALIDATE);
  const script = renderWrapper(review, at("safe"), source, "/usr/bin/deno");
  assertStringIncludes(script, `"binary": "/usr/bin/demo"`);
});

Deno.test("the launcher keeps the shebang line short enough for any kernel", async () => {
  const source = await Deno.readTextFile(VALIDATE);
  // A long nix store path plus flags used to produce a 957-byte shebang. Linux
  // caps that line at 127 bytes and silently falls through to /bin/sh, so the
  // wrapper became a shell script full of syntax errors instead of a refusal.
  const long = ReviewSchema.parse({
    ...review,
    binary: "/nix/store/hiw6ii978dc8s153v60fzy6myzqxymm7-git-2.55.0/bin/git",
    env: {
      scrub: Array.from({ length: 60 }, (_, i) => `DEMO_VAR_${i}`),
      set: {},
    },
  });
  const script = renderWrapper(long, at("safe", long), source, "/usr/bin/deno");
  const [first, second] = script.split("\n");
  assertEquals(first, "#!/bin/sh");
  assert(first.length < 127);
  assertStringIncludes(second, "exec '/usr/bin/deno' 'run'");
});

Deno.test("the launcher line is a comment to TypeScript and a no-op to sh", async () => {
  const source = await Deno.readTextFile(VALIDATE);
  const script = renderWrapper(review, at("safe"), source, "/usr/bin/deno");
  const second = script.split("\n")[1];
  // `:` is sh's null command and `//` is only an argument to it; to TypeScript
  // the line is a string literal followed by a comment.
  assert(second.startsWith('":" //;'));
  assertStringIncludes(second, `"$0" "$@"`);
});

Deno.test("a path with a space survives the launcher", async () => {
  const source = await Deno.readTextFile(VALIDATE);
  const spaced = ReviewSchema.parse({
    ...review,
    binary: "/opt/my tools/demo",
  });
  const script = renderWrapper(
    spaced,
    at("safe", spaced),
    source,
    "/opt/my deno/deno",
  );
  const second = script.split("\n")[1];
  assertStringIncludes(second, `'/opt/my deno/deno'`);
  assertStringIncludes(second, `'--allow-run=/opt/my tools/demo'`);
});

Deno.test("a wrapper refuses commands above its tier", async () => {
  const source = await Deno.readTextFile(VALIDATE);
  const safe = renderWrapper(review, at("safe"), source, "/usr/bin/deno");
  // The escape-tier option must not survive into the safe wrapper's table.
  assert(!safe.includes(`"--exec"`));
  assert(!safe.includes(`"delete"`));

  const write = renderWrapper(review, at("write"), source, "/usr/bin/deno");
  assertStringIncludes(write, `"delete"`);
  assert(!write.includes(`"--exec"`));
});

Deno.test("a refusal points at a wider alias for the same tool", async () => {
  const source = await Deno.readTextFile(VALIDATE);
  const safe = renderWrapper(review, at("safe"), source, "/usr/bin/deno");
  assertStringIncludes(safe, "fka-private-demo or fka-write-demo");

  const write = renderWrapper(review, at("write"), source, "/usr/bin/deno");
  assertStringIncludes(write, "No wider alias exists");
});

Deno.test("a refusal never points at another tool's alias", async () => {
  const source = await Deno.readTextFile(VALIDATE);
  const mixed = ReviewSchema.parse({
    ...review,
    wrappers: [
      { segment: "safe", name: "demo", admits: { maxTier: "read-safe" } },
      { segment: "write", name: "other", admits: { maxTier: "modify" } },
    ],
  });
  const script = renderWrapper(mixed, mixed.wrappers[0], source, "/x/deno");
  assert(!script.includes("fka-write-other"));
});

// --- the permission snippet ---------------------------------------------

function rules(
  snippet: string,
): { allow: string[]; ask: string[]; deny?: string[] } {
  const json = snippet.slice(snippet.indexOf("{"));
  return JSON.parse(json).permissions;
}

Deno.test("rules are keyed on the segment, not on the tool", () => {
  // The whole point of the shared prefix: this file does not grow when you
  // wrap another CLI tomorrow.
  const { allow, ask } = rules(renderSettings(review));
  assertEquals(allow, ["Bash(fka-help:*)", "Bash(fka-safe:*)"]);
  assertEquals(ask, ["Bash(fka-private:*)", "Bash(fka-write:*)"]);
});

Deno.test("no rule denies the raw tool", () => {
  // Denying it is harsher than the default without being safer: an unlisted
  // command already prompts, so the operator keeps the option of approving
  // one, and an absolute path was never matched by the bare name anyway.
  const { deny } = rules(renderSettings(review));
  assertEquals(deny, undefined);
  assert(!renderSettings(review).includes('"deny"'));
});

Deno.test("a segment with no alias gets no rule", () => {
  const narrow = ReviewSchema.parse({
    ...review,
    wrappers: [{
      segment: "safe",
      name: "demo",
      admits: { maxTier: "read-safe" },
    }],
  });
  const { allow, ask } = rules(renderSettings(narrow));
  assertEquals(allow, ["Bash(fka-safe:*)"]);
  assertEquals(ask, []);
});

Deno.test("the snippet says what one shared rule costs", () => {
  const snippet = renderSettings(review);
  // Someone pasting this deserves to know that a later run on a different tool
  // lands inside the rule they just wrote.
  assertStringIncludes(snippet, "running");
  assertStringIncludes(snippet, "review gate");
  assertStringIncludes(snippet, "narrowest useful grant");
});

// --- the skill snippet ---------------------------------------------------

Deno.test("the skill names every alias in the plan and no other", () => {
  const skill = renderSkill(review, "/tmp/bin");
  for (const name of ["fka-help-demo", "fka-safe-demo", "fka-write-demo"]) {
    assertStringIncludes(skill, name);
  }
  assert(!skill.includes("fka-escape-demo"));
});

Deno.test("the skill uses real commands from the table, never invented ones", () => {
  const skill = renderSkill(review, "/tmp/bin");
  assertStringIncludes(skill, "fka-safe-demo list");
  assertStringIncludes(skill, "fka-write-demo delete");
});

Deno.test("the skill says the help alias reaches what nothing else runs", () => {
  const skill = renderSkill(review, "/tmp/bin");
  assertStringIncludes(skill, "reaches every command");
  // The example has to use a command the safe alias will not run, or it
  // demonstrates nothing.
  assertStringIncludes(skill, "fka-help-demo delete");
  assertStringIncludes(skill, "not yours to pass");
});

Deno.test("the skill omits the help note when the plan has no help alias", () => {
  const narrow = ReviewSchema.parse({
    ...review,
    wrappers: [{
      segment: "safe",
      name: "demo",
      admits: { maxTier: "read-safe" },
    }],
  });
  assert(!renderSkill(narrow, "/tmp/bin").includes("reaches every command"));
});

Deno.test("an alias that pins a subcommand shows the argument the caller types", () => {
  const pinned = ReviewSchema.parse({
    ...review,
    commands: [
      { path: ["pr", "list"], tier: "read-safe", why: "reads" },
    ],
    wrappers: [{
      segment: "safe",
      name: "demo-pr",
      prepend: ["pr"],
      admits: { maxTier: "read-safe" },
    }],
  });
  const skill = renderSkill(pinned, "/tmp/bin");
  // `pr` is the alias's own; typing it again would be wrong.
  assertStringIncludes(skill, "fka-safe-demo-pr list");
  assert(!skill.includes("fka-safe-demo-pr pr list"));
});

Deno.test("the skill explains what a refusal means and what not to do about it", () => {
  const skill = renderSkill(review, "/tmp/bin");
  assertStringIncludes(skill, String(REFUSED_EXIT));
  assertStringIncludes(skill, "FKA_CHECK=1");
  assertStringIncludes(skill, "Do not route around a refusal");
});

// --- running for real ------------------------------------------------------

Deno.test("a wrapper runs even when the caller's environment carries linker variables", async () => {
  // Deno refuses to spawn under the wrapper's scoped --allow-run when the
  // child would inherit an LD_* or DYLD_* variable, and callers routinely
  // have them. Before the wrapper dropped that family itself, this surfaced
  // as a raw NotCapable crash instead of the tool running.
  if (Deno.build.os !== "darwin" && Deno.build.os !== "linux") return;
  const source = await Deno.readTextFile(VALIDATE);
  const real = ReviewSchema.parse({ ...review, binary: "/usr/bin/true" });
  const script = renderWrapper(real, at("safe", real), source, Deno.execPath());
  const dir = await Deno.makeTempDir();
  const path = `${dir}/fka-safe-demo`;
  try {
    await Deno.writeTextFile(path, script);
    await Deno.chmod(path, 0o755);
    const { code, stderr } = await new Deno.Command(path, {
      args: ["list"],
      env: {
        ...Deno.env.toObject(),
        LD_PRELOAD: "probe",
        LD_LIBRARY_PATH: "probe",
        DYLD_INSERT_LIBRARIES: "probe",
      },
      stdout: "null",
      stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(stderr);
    assert(!err.includes("NotCapable"), err);
    assertEquals(code, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
