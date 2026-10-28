import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { parsePrint } from "./launchd.ts";
import {
  gatewayLabelFor,
  hasLiveSession,
  mcpLabelFor,
  substitutePlaceholders,
  unresolvedPlaceholders,
} from "./proc.ts";

Deno.test("labels are derived from the slug", () => {
  assertEquals(gatewayLabelFor("alpha"), "sh.alpha.gateway");
  assertEquals(mcpLabelFor("alpha", "gh-gate"), "sh.alpha.gh-gate");
  assertEquals(mcpLabelFor("alpha", "newsboat-mcp"), "sh.alpha.newsboat-mcp");
});

Deno.test("placeholders are substituted everywhere they appear", () => {
  const out = substitutePlaceholders(
    "<string>__REPO__/bin/run-x.sh</string><string>__HOME__/a:__HOME__/b</string><string>/etc/profiles/per-user/__USER__/bin</string>",
    { repo: "/r", home: "/h", user: "u" },
  );
  assertEquals(
    out,
    "<string>/r/bin/run-x.sh</string><string>/h/a:/h/b</string><string>/etc/profiles/per-user/u/bin</string>",
  );
  assertEquals(unresolvedPlaceholders(out), []);
});

// Installing a plist with a placeholder left in it produces a job that fails at
// exec, pointing at a path that does not exist.
Deno.test("an unsubstituted placeholder is detected", () => {
  const found = unresolvedPlaceholders("a __REPO__ b __USER__ c __REPO__");
  assertEquals(found.sort(), ["__REPO__", "__USER__"]);
});

const RUNNING = `
gui/501/sh.beta.gateway = {
	active count = 1
	path = /Users/x/Library/LaunchAgents/sh.beta.gateway.plist
	state = running
	program = /Users/x/src/agent-ops/bin/run-beta.sh
	pid = 45058
	last exit code = (never exited)
}
`;

const EXITED = `
gui/501/sh.demo.gateway = {
	state = waiting
	last exit code = 3
}
`;

Deno.test("launchctl print yields state and pid", () => {
  const s = parsePrint("sh.beta.gateway", RUNNING);
  assertEquals(s.loaded, true);
  assertEquals(s.state, "running");
  assertEquals(s.pid, 45058);
  assertEquals(s.lastExitStatus, null); // "(never exited)" is not an exit code
});

Deno.test("a waiting service reports its last exit code and no pid", () => {
  const s = parsePrint("sh.demo.gateway", EXITED);
  assertEquals(s.state, "waiting");
  assertEquals(s.pid, null);
  assertEquals(s.lastExitStatus, 3);
});

// Two established sockets on a loopback port is both ends of one session.
Deno.test("a live session needs both ends", () => {
  assert(!hasLiveSession(0));
  assert(!hasLiveSession(1));
  assert(hasLiveSession(2));
  assert(hasLiveSession(4));
});
