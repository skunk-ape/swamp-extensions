import { assert, assertEquals } from "jsr:@std/assert@1";
import { LINKER_ENV, withoutLinkerEnv } from "./env.ts";

Deno.test("the linker family matches what Deno refuses, and nothing else", () => {
  // The refused set was probed empirically against the runtime the wrappers
  // run under: every LD_* and DYLD_* name is refused, and lookalikes that
  // are not loader hooks (LIBRARY_PATH, SHLIB_PATH) are allowed.
  for (
    const name of [
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "LD_AUDIT",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "DYLD_FALLBACK_LIBRARY_PATH",
    ]
  ) {
    assert(LINKER_ENV.test(name), name);
  }
  for (
    const name of [
      "PATH",
      "HOME",
      "LIBRARY_PATH",
      "SHLIB_PATH",
      "ANTHROPIC_AUTH_TOKEN",
      "LDV_PRELOAD",
    ]
  ) {
    assert(!LINKER_ENV.test(name), name);
  }
});

Deno.test("withoutLinkerEnv hides the family from a child and restores it after", async () => {
  Deno.env.set("LD_PRELOAD", "sentinel");
  Deno.env.set("DYLD_LIBRARY_PATH", "sentinel");
  try {
    let sawDuring = "";
    await withoutLinkerEnv(async () => {
      const { stdout } = await new Deno.Command("/bin/sh", {
        args: ["-c", "printenv LD_PRELOAD DYLD_LIBRARY_PATH || true"],
      }).output();
      sawDuring = new TextDecoder().decode(stdout);
    });
    assertEquals(sawDuring.trim(), "");
    assertEquals(Deno.env.get("LD_PRELOAD"), "sentinel");
    assertEquals(Deno.env.get("DYLD_LIBRARY_PATH"), "sentinel");
  } finally {
    Deno.env.delete("LD_PRELOAD");
    Deno.env.delete("DYLD_LIBRARY_PATH");
  }
});
