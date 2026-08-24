import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { model, workRoot } from "./fka.ts";

/** The parsed defaults, as a method sees them when nothing overrides. */
function defaults(over: Record<string, unknown> = {}) {
  return model.globalArguments.parse(over);
}

/** Run `body` with the environment temporarily set, restoring whatever was there. */
function withEnv(vars: Record<string, string | null>, body: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, Deno.env.get(k));
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

// --- where the workspace lives -------------------------------------------

Deno.test("the workspace defaults to the user's config directory", () => {
  // Not the repository: a wrapper is invoked by bare name, so two repos wrapping
  // one tool would render the same executable name and only one could be on PATH.
  withEnv({ XDG_CONFIG_HOME: null, HOME: "/home/ada" }, () => {
    assertEquals(workRoot("/repo", defaults()), "/home/ada/.config/fka");
  });
});

Deno.test("XDG_CONFIG_HOME wins over the home fallback", () => {
  withEnv({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/ada" }, () => {
    assertEquals(workRoot("/repo", defaults()), "/xdg/fka");
  });
});

Deno.test("a relative XDG_CONFIG_HOME is ignored rather than trusted", () => {
  // The spec says it must be absolute. Honouring a relative one would put the
  // wrappers somewhere that depends on the working directory of whoever ran the
  // method, which is nobody's intent.
  withEnv({ XDG_CONFIG_HOME: "relative/path", HOME: "/home/ada" }, () => {
    assertEquals(workRoot("/repo", defaults()), "/home/ada/.config/fka");
  });
});

Deno.test("an absolute workRoot is used as given", () => {
  withEnv({ XDG_CONFIG_HOME: null, HOME: "/home/ada" }, () => {
    assertEquals(
      workRoot("/repo", defaults({ workRoot: "/opt/fka" })),
      "/opt/fka",
    );
  });
});

Deno.test("a relative workRoot is the project-local escape hatch", () => {
  withEnv({ XDG_CONFIG_HOME: null, HOME: "/home/ada" }, () => {
    assertEquals(
      workRoot("/repo", defaults({ workRoot: ".fka" })),
      "/repo/.fka",
    );
  });
});

Deno.test("no home and no override refuses rather than guessing", () => {
  withEnv({ XDG_CONFIG_HOME: null, HOME: null }, () => {
    assertThrows(() => workRoot("/repo", defaults()), Error, "workRoot");
  });
});
