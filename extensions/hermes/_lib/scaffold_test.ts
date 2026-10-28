import { assert, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { scaffoldYaml } from "./scaffold.ts";
import { parse as parseYaml } from "jsr:@std/yaml@1.2.0";

function scaffold(over: Record<string, string> = {}): string {
  return scaffoldYaml({
    slug: "probe",
    displayName: "Probe",
    vault: "probe-secrets",
    typeVersion: "2026.09.09.2",
    id: "11111111-2222-3333-4444-555555555555",
    ...over,
  });
}

Deno.test("the scaffold is valid YAML with the model envelope intact", () => {
  // deno-lint-ignore no-explicit-any
  const doc = parseYaml(scaffold()) as any;
  assert(doc.type === "@skunk-ape/hermes/bot");
  assert(doc.name === "probe");
  assert(doc.id === "11111111-2222-3333-4444-555555555555");
  assert(doc.globalArguments.slug === "probe");
  assert(doc.globalArguments.vault === "probe-secrets");
});

Deno.test("egress is left empty rather than defaulted to unrestricted", () => {
  // deno-lint-ignore no-explicit-any
  const doc = parseYaml(scaffold()) as any;
  // A bot must not acquire open egress by nobody reading a line.
  assert(Array.isArray(doc.globalArguments.sandbox.egress));
  assert(doc.globalArguments.sandbox.egress.length === 0);
  assertStringIncludes(scaffold(), "EDIT ME");
});

Deno.test("the safe answers are the defaults", () => {
  // deno-lint-ignore no-explicit-any
  const doc = parseYaml(scaffold()) as any;
  const g = doc.globalArguments;
  assert(g.sandbox.filesystemAllow.length === 0);
  assert(g.sandbox.openPorts.length === 0);
  assert(g.mcps.length === 0);
  // An empty allowlist denies every sender, which is the correct default.
  assert(g.telegram.allowedUsers.length === 0);
});

Deno.test("the vault commands a person needs are written down", () => {
  const y = scaffold();
  assertStringIncludes(y, "swamp vault put probe-secrets anthropic-key");
  assertStringIncludes(y, "swamp vault put probe-secrets telegram-bot-token");
});

Deno.test("the comments carry the reasons, not just the field names", () => {
  const y = scaffold();
  assertStringIncludes(y, "lethal trifecta");
  assertStringIncludes(y, "confinement is inherited");
  assertStringIncludes(y, "one chat history");
});
