import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  denoFlags,
  REFUSED_EXIT,
  renderSettings,
  renderSkill,
  renderWrapper,
} from "./wrapper.ts";
import { ReviewSchema, toPolicy } from "./review.ts";
import type { Review } from "./review.ts";

const VALIDATE = new URL("./validate.ts", import.meta.url);

const review: Review = ReviewSchema.parse({
  cli: "demo",
  binary: "/usr/bin/demo",
  binaryVersion: "demo 1.2.3",
  generatedAt: "2026-08-22T00:00:00.000Z",
  emit: ["read-safe", "read-private", "modify"],
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
  const script = renderWrapper(review, "read-safe", source, "/usr/bin/deno");
  assertStringIncludes(script, source.trimEnd());
});

Deno.test("the validator has no imports, so a wrapper needs no network or lockfile", async () => {
  const source = await Deno.readTextFile(VALIDATE);
  const imports = source.split("\n").filter((l) => /^\s*import[\s{]/.test(l));
  assertEquals(imports, []);
});

// --- the shebang ---------------------------------------------------------

Deno.test("the wrapper grants itself the narrowest permissions that work", () => {
  const flags = denoFlags(toPolicy(review, "read-safe"));
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
  const script = renderWrapper(review, "read-safe", source, "/usr/bin/deno");
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
  const script = renderWrapper(long, "read-safe", source, "/usr/bin/deno");
  const [first, second] = script.split("\n");
  assertEquals(first, "#!/bin/sh");
  assert(first.length < 127);
  assertStringIncludes(second, "exec '/usr/bin/deno' 'run'");
});

Deno.test("the launcher line is a comment to TypeScript and a no-op to sh", async () => {
  const source = await Deno.readTextFile(VALIDATE);
  const script = renderWrapper(review, "read-safe", source, "/usr/bin/deno");
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
    "read-safe",
    source,
    "/opt/my deno/deno",
  );
  const second = script.split("\n")[1];
  assertStringIncludes(second, `'/opt/my deno/deno'`);
  assertStringIncludes(second, `'--allow-run=/opt/my tools/demo'`);
});

Deno.test("a wrapper refuses commands above its tier", async () => {
  const source = await Deno.readTextFile(VALIDATE);
  const safe = renderWrapper(review, "read-safe", source, "/usr/bin/deno");
  // The escape-tier option must not survive into the safe wrapper's table.
  assert(!safe.includes(`"--exec"`));
  assert(!safe.includes(`"delete"`));

  const write = renderWrapper(review, "modify", source, "/usr/bin/deno");
  assertStringIncludes(write, `"delete"`);
  assert(!write.includes(`"--exec"`));
});

Deno.test("a refusal points at the tier that would accept the command", async () => {
  const source = await Deno.readTextFile(VALIDATE);
  const safe = renderWrapper(review, "read-safe", source, "/usr/bin/deno");
  assertStringIncludes(safe, "private-demo or write-demo");

  const write = renderWrapper(review, "modify", source, "/usr/bin/deno");
  assertStringIncludes(write, "No higher tier is available");
});

// --- the permission snippet ---------------------------------------------

function rules(
  snippet: string,
): { allow: string[]; ask: string[]; deny: string[] } {
  const json = snippet.slice(snippet.indexOf("{"));
  return JSON.parse(json).permissions;
}

Deno.test("only read-safe is allowed; every other tier asks", () => {
  const { allow, ask, deny } = rules(renderSettings(review));
  assertEquals(allow, ["Bash(safe-demo:*)"]);
  assertEquals(ask, ["Bash(private-demo:*)", "Bash(write-demo:*)"]);
  assertEquals(deny, ["Bash(demo:*)"]);
});

Deno.test("no deny rule is a prefix of an allow rule", () => {
  // This is the invariant the naming scheme exists to hold. Bash rules match by
  // string prefix and deny wins, so a deny that prefixes an allow silently
  // cancels it — which is exactly what `gh` vs `gh-safe` would have done.
  const { allow, ask, deny } = rules(renderSettings(review));
  const command = (rule: string) =>
    rule.replace(/^Bash\(/, "").replace(/:\*\)$/, "");
  for (const d of deny.map(command)) {
    for (const a of [...allow, ...ask].map(command)) {
      assert(!a.startsWith(d), `deny "${d}" would swallow "${a}"`);
    }
  }
});

Deno.test("the snippet admits the limit of a prefix rule rather than implying there is none", () => {
  const snippet = renderSettings(review);
  assertStringIncludes(snippet, "not a sandbox");
  assertStringIncludes(snippet, "/usr/bin/demo");
});

Deno.test("a wrapper is never proposed for a tier that was not emitted", () => {
  const narrow = ReviewSchema.parse({ ...review, emit: ["read-safe"] });
  const { allow, ask } = rules(renderSettings(narrow));
  assertEquals(allow, ["Bash(safe-demo:*)"]);
  assertEquals(ask, []);
});

// --- the skill snippet ---------------------------------------------------

Deno.test("the skill names every emitted wrapper and no other", () => {
  const skill = renderSkill(review, "/tmp/bin");
  for (const name of ["safe-demo", "private-demo", "write-demo"]) {
    assertStringIncludes(skill, name);
  }
  assert(!skill.includes("escape-demo"));
});

Deno.test("the skill uses real commands from the table, never invented ones", () => {
  const skill = renderSkill(review, "/tmp/bin");
  assertStringIncludes(skill, "safe-demo list");
  assertStringIncludes(skill, "write-demo delete");
});

Deno.test("the skill explains what a refusal means and what not to do about it", () => {
  const skill = renderSkill(review, "/tmp/bin");
  assertStringIncludes(skill, String(REFUSED_EXIT));
  assertStringIncludes(skill, "FKA_CHECK=1");
  assertStringIncludes(skill, "Do not route around a refusal");
});
