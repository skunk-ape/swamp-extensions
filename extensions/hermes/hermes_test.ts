// The methods themselves, not just the templates they render.
//
// Everything under _lib is pure and tested there. What is left here is the part
// that touches a filesystem and decides things: whether `render` writes in check
// mode, whether `scaffold` will overwrite a declaration somebody edited, and
// whether `provision --check` can report on a workdir that does not exist yet.
//
// Both bugs the first real provision run turned up lived in this layer, not in
// the templates, which is the argument for these tests existing at all.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { model } from "./hermes.ts";
import { BotSchema } from "./_lib/decl.ts";
import type { Bot } from "./_lib/decl.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

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

type Written = {
  specName: string;
  name: string;
  data: Record<string, unknown>;
};

/** A method context over a throwaway directory. Nothing here reaches the host
 * beyond that directory: no launchd, no network, no subprocess. */
function ctx(repoDir: string, b: Bot = bot()) {
  const written: Written[] = [];
  const logs: string[] = [];
  return {
    written,
    logs,
    ctx: {
      globalArgs: b,
      repoDir,
      logger: {
        info: (m: string) => logs.push(m),
        warning: (m: string) => logs.push("WARN " + m),
      },
      signal: new AbortController().signal,
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ specName, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

async function inTempRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// deno-lint-ignore no-explicit-any
const methods = model.methods as any;

Deno.test("render writes the runtime, and check mode writes nothing", async () => {
  await inTempRepo(async (dir) => {
    const a = ctx(dir);
    await methods.render.execute({ check: true, outputDir: "" }, a.ctx);
    const rendered = a.written[0].data as Record<string, unknown>;
    assertEquals(rendered.clean, false);
    // Check mode is a report. Nothing may exist afterwards.
    await Deno.stat(`${dir}/profiles`).then(
      () => assert(false, "check mode wrote a profile"),
      () => {},
    );

    const b = ctx(dir);
    await methods.render.execute({ check: false, outputDir: "" }, b.ctx);
    // Both platforms' profiles, and they must differ: macOS enforces with
    // allow_domain + open_port, Linux with connect_port, and installing the
    // wrong one removes the boundary rather than merely misconfiguring it.
    const mac = await Deno.readTextFile(
      `${dir}/profiles/demo.darwin.nono.json`,
    );
    const linux = await Deno.readTextFile(
      `${dir}/profiles/demo.linux.nono.json`,
    );
    assertStringIncludes(mac, "GENERATED");
    assertStringIncludes(linux, "GENERATED");
    assert(mac !== linux, "the two platforms' profiles must not be identical");

    // And now it is clean, which is what makes check mode a drift detector.
    const c = ctx(dir);
    await methods.render.execute({ check: true, outputDir: "" }, c.ctx);
    assertEquals((c.written[0].data as Record<string, unknown>).clean, true);
  });
});

Deno.test("render refuses a declaration that contradicts itself", async () => {
  await inTempRepo(async (dir) => {
    // An MCP whose port the profile never opened: the gateway comes up with no
    // tools at all, warns into a log nobody reads, and starts anyway.
    const broken = bot({ mcps: [{ name: "gh-gate", port: 8813 }] });
    const a = ctx(dir, broken);
    let threw = "";
    try {
      await methods.render.execute({ check: false, outputDir: "" }, a.ctx);
    } catch (e) {
      threw = String(e);
    }
    assertStringIncludes(threw, "openPorts");
    assertStringIncludes(threw, "toolless");
  });
});

Deno.test("scaffold writes a declaration that is not ready to render", async () => {
  await inTempRepo(async (dir) => {
    const a = ctx(dir);
    await methods.scaffold.execute(
      { slug: "newbot", displayName: "", vault: "", force: false },
      a.ctx,
    );
    const y = await Deno.readTextFile(
      `${dir}/models/@skunk-ape/hermes/bot/newbot.yaml`,
    );
    assertStringIncludes(y, "name: newbot");
    // Defaulted from the slug rather than demanded on the command line.
    assertStringIncludes(y, 'displayName: "Newbot"');
    assertStringIncludes(y, "vault: newbot-secrets");
    // The warning is the point: a scaffold that looked ready to render would
    // be a bot with no egress list and an empty Telegram allowlist.
    assert(a.logs.some((l) => l.startsWith("WARN")));
  });
});

Deno.test("scaffold will not silently discard hand-written boundaries", async () => {
  await inTempRepo(async (dir) => {
    const a = ctx(dir);
    await methods.scaffold.execute(
      { slug: "newbot", displayName: "", vault: "", force: false },
      a.ctx,
    );
    const path = `${dir}/models/@skunk-ape/hermes/bot/newbot.yaml`;
    const first = await Deno.readTextFile(path);

    let threw = "";
    try {
      await methods.scaffold.execute(
        { slug: "newbot", displayName: "", vault: "", force: false },
        ctx(dir).ctx,
      );
    } catch (e) {
      threw = String(e);
    }
    assertStringIncludes(threw, "already has a filled-in declaration");
    assertEquals(await Deno.readTextFile(path), first);

    // force is the deliberate way through, and it keeps the model's identity.
    const c = ctx(dir);
    await methods.scaffold.execute(
      { slug: "newbot", displayName: "Renamed", vault: "", force: true },
      c.ctx,
    );
    const after = await Deno.readTextFile(path);
    assertStringIncludes(after, 'displayName: "Renamed"');
    const idOf = (s: string) => s.match(/^id:\s*(\S+)$/m)![1];
    assertEquals(idOf(after), idOf(first));
  });
});

Deno.test("provision --check reports a workdir that does not exist yet", async () => {
  await inTempRepo(async (dir) => {
    // workdirRoot inside the temp dir: check mode must not create it, and if it
    // ever did, this is where the evidence would be.
    const b = bot({ workdirRoot: `${dir}/agents` });
    const a = ctx(dir, b);
    await methods.provision.execute({
      check: true,
      hermesRepo: "https://example.invalid/hermes-agent.git",
      hermesRef: "main",
      pythonVersion: "3.11",
      seedHfFrom: "",
      funesBin: `${dir}/nonexistent-funes`,
      skipDeps: false,
      restageFunes: false,
    }, a.ctx);

    const p = a.written[0].data as Record<string, unknown>;
    assertEquals(p.checkOnly, true);
    assertEquals(p.complete, false);
    assert((p.missingCount as number) > 0);

    const steps = p.steps as { name: string; status: string }[];
    const status = (n: string) => steps.find((s) => s.name === n)?.status;
    assertEquals(status("directories"), "missing");
    assertEquals(status("hermes-agent"), "missing");
    assertEquals(status("interpreter"), "missing");
    assertEquals(status("hermes/config.yaml"), "missing");
    // No host binary to stage, so this is a skip rather than a claim.
    assertEquals(status("funes binary"), "skipped");

    // Nothing may have been created. A check that provisions is not a check.
    await Deno.stat(`${dir}/agents`).then(
      () => assert(false, "check mode created the workdir"),
      () => {},
    );
  });
});

Deno.test("every method a bot needs is declared, with a schema", () => {
  for (
    const m of [
      "scaffold",
      "render",
      "provision",
      "verify",
      "install",
      "uninstall",
      "status",
      "restart",
      "snapshot",
      "restore",
    ]
  ) {
    assert(methods[m], `missing method ${m}`);
    assert(methods[m].description.length > 40, `${m} needs a real description`);
    assert(typeof methods[m].execute === "function");
  }
});

// ---------------------------------------------------------------------------
// provision on a workdir the bot has had its hands on
// ---------------------------------------------------------------------------

const PROVISION_CHECK = (dir: string) => ({
  check: true,
  hermesRepo: "https://example.invalid/hermes-agent.git",
  hermesRef: "main",
  pythonVersion: "3.11",
  seedHfFrom: "",
  funesBin: `${dir}/nonexistent-funes`,
  skipDeps: false,
  restageFunes: false,
});

Deno.test("provision --check reports the runtime and code left by the old layout", async () => {
  await inTempRepo(async (dir) => {
    const b = bot({ workdirRoot: `${dir}/agents` });
    const wd = `${dir}/agents/${b.slug}`;
    // An old-layout workdir: code inside it.
    await Deno.mkdir(`${wd}/hermes/hermes-agent`, { recursive: true });
    await Deno.mkdir(`${wd}/tools`, { recursive: true });
    const a = ctx(dir, b);
    await methods.provision.execute(PROVISION_CHECK(dir), a.ctx);

    const steps = (a.written[0].data as Record<string, unknown>).steps as {
      name: string;
      status: string;
      detail: string;
    }[];
    const step = (n: string) => steps.find((s) => s.name === n);
    assertEquals(step("runtime")?.status, "missing");
    assertStringIncludes(step("runtime")!.detail, `${dir}/agents/.runtime/`);
    assertEquals(step("legacy runtime")?.status, "unused");
    assertStringIncludes(step("legacy runtime")!.detail, "hermes/hermes-agent");
    // Check mode creates nothing, the runtime included.
    await Deno.stat(`${dir}/agents/.runtime`).then(
      () => assert(false, "check mode created the runtime"),
      () => {},
    );
  });
});

Deno.test("provision refuses a workdir directory the bot replaced with a symlink", async () => {
  await inTempRepo(async (dir) => {
    const b = bot({ workdirRoot: `${dir}/agents` });
    const wd = `${dir}/agents/${b.slug}`;
    await Deno.mkdir(wd, { recursive: true });
    await Deno.mkdir(`${dir}/operator-home`);
    await Deno.symlink(`${dir}/operator-home`, `${wd}/hermes`);
    let message = "";
    try {
      await methods.provision.execute(PROVISION_CHECK(dir), ctx(dir, b).ctx);
    } catch (e) {
      message = (e as Error).message;
    }
    assertStringIncludes(message, "is a symlink");
  });
});

Deno.test("provision refuses a .hermes link that points anywhere but the bot's own home", async () => {
  await inTempRepo(async (dir) => {
    const b = bot({ workdirRoot: `${dir}/agents` });
    const wd = `${dir}/agents/${b.slug}`;
    await Deno.mkdir(`${wd}/hermes`, { recursive: true });
    // funes add hermes writes through this link on the host.
    await Deno.symlink(`${dir}/operator-hermes`, `${wd}/.hermes`);
    let message = "";
    try {
      await methods.provision.execute(PROVISION_CHECK(dir), ctx(dir, b).ctx);
    } catch (e) {
      message = (e as Error).message;
    }
    assertStringIncludes(message, `points at ${dir}/operator-hermes`);
  });
});
