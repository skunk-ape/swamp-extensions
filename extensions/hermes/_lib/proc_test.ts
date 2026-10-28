import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { run } from "./proc.ts";

Deno.test("run passes input on stdin when given, and closes it otherwise", async () => {
  const fed = await run("cat", [], undefined, { input: "y\n" });
  assertEquals(fed.stdout, "y\n");
  // No input: stdin is closed, so cat sees EOF at once rather than blocking.
  const closed = await run("cat", []);
  assertEquals(closed.stdout, "");
  assertEquals(closed.code, 0);
});

Deno.test("clearEnv passes only the given environment", async () => {
  const r = await run("/usr/bin/env", [], undefined, {
    env: { ONLY: "this" },
    clearEnv: true,
  });
  assertEquals(r.stdout.trim(), "ONLY=this");
  // Without it the operator's environment comes along.
  const inherited = await run("/usr/bin/env", [], undefined, {
    env: { ONLY: "this" },
  });
  assert(inherited.stdout.split("\n").length > 2);
});
