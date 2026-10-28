import { assertEquals } from "jsr:@std/assert@1.0.19";
import { claudeArgs } from "./generate.ts";

Deno.test("claudeArgs: the rewrite session holds no tools or MCP servers", () => {
  const args = claudeArgs("m", "sys");
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assertEquals(args.slice(0, 5), ["-p", "--model", "m", "--system-prompt", "sys"]);
  assertEquals(at("--tools"), "");
  assertEquals(at("--setting-sources"), "");
  for (
    const flag of [
      "--strict-mcp-config",
      "--safe-mode",
      "--disable-slash-commands",
      "--no-session-persistence",
    ]
  ) {
    assertEquals(args.includes(flag), true, flag);
  }
  // --mcp-config would re-admit servers; --strict-mcp-config alone admits none.
  assertEquals(args.includes("--mcp-config"), false);
});
