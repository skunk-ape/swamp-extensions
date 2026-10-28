import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  kernelEnforcesNetwork,
  MIN_KERNEL,
  parseKernelVersion,
  parseShow,
  parseSsEstablished,
} from "./systemd.ts";

// ---------------------------------------------------------------------------
// systemctl show
// ---------------------------------------------------------------------------

const show = (kv: Record<string, string>) =>
  Object.entries(kv).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";

Deno.test("a running unit reports launchd's vocabulary, not systemd's", () => {
  // The whole point of the translation: writeStatus() and every stored fleet
  // report compare against "running".
  const st = parseShow(
    "sh.alpha.gateway",
    show({
      LoadState: "loaded",
      ActiveState: "active",
      SubState: "running",
      MainPID: "4242",
      ExecMainStatus: "0",
      ExecMainExitTimestamp: "",
    }),
  );
  assertEquals(st.loaded, true);
  assertEquals(st.state, "running");
  assertEquals(st.pid, 4242);
  assertEquals(st.lastExitStatus, null);
});

Deno.test("a unit that was never installed is not loaded", () => {
  const st = parseShow(
    "sh.demo.gateway",
    show({ LoadState: "not-found", ActiveState: "inactive", SubState: "dead" }),
  );
  assertEquals(st.loaded, false);
  assertEquals(st.state, null);
  assertEquals(st.pid, null);
});

Deno.test("installed but stopped is loaded-and-exited, not not-loaded", () => {
  // The distinction status reporting turns on: "you never installed this" and
  // "this is installed and died" need different answers from a human.
  const st = parseShow(
    "sh.gamma.gateway",
    show({
      LoadState: "loaded",
      ActiveState: "failed",
      SubState: "failed",
      MainPID: "0",
      ExecMainStatus: "3",
      ExecMainExitTimestamp: "Tue 2026-09-22 09:14:02 PDT",
    }),
  );
  assertEquals(st.loaded, true);
  assertEquals(st.state, "exited");
  assertEquals(st.pid, null);
  assertEquals(st.lastExitStatus, 3);
});

Deno.test("a unit between restarts is waiting, not exited", () => {
  // Restart=on-failure parks the unit in auto-restart. Reporting that as
  // "exited" would make a bot that is coming back look like one that is gone.
  const st = parseShow(
    "sh.beta.gateway",
    show({
      LoadState: "loaded",
      ActiveState: "activating",
      SubState: "auto-restart",
      MainPID: "0",
      ExecMainStatus: "1",
      ExecMainExitTimestamp: "Tue 2026-09-22 09:14:02 PDT",
    }),
  );
  assertEquals(st.state, "waiting");
  assertEquals(st.lastExitStatus, 1);
});

Deno.test("a clean exit status is not mistaken for never having exited", () => {
  // ExecMainStatus is 0 in both cases, so the timestamp is what separates them.
  const never = parseShow(
    "x",
    show({
      LoadState: "loaded",
      ActiveState: "active",
      SubState: "running",
      MainPID: "9",
      ExecMainStatus: "0",
      ExecMainExitTimestamp: "",
    }),
  );
  const exited = parseShow(
    "x",
    show({
      LoadState: "loaded",
      ActiveState: "inactive",
      SubState: "dead",
      MainPID: "0",
      ExecMainStatus: "0",
      ExecMainExitTimestamp: "Tue 2026-09-22 09:14:02 PDT",
    }),
  );
  assertEquals(never.lastExitStatus, null);
  assertEquals(exited.lastExitStatus, 0);
});

// ---------------------------------------------------------------------------
// ss
// ---------------------------------------------------------------------------

Deno.test("established sockets are counted and the header is not", () => {
  const out = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port
ESTAB  0      0          127.0.0.1:8813      127.0.0.1:52344
ESTAB  0      0          127.0.0.1:52344     127.0.0.1:8813
`;
  // Two sockets is one live session seen from both ends.
  assertEquals(parseSsEstablished(out), 2);
});

Deno.test("no sockets is zero, not a parse failure", () => {
  assertEquals(parseSsEstablished(""), 0);
  assertEquals(
    parseSsEstablished(
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port\n",
    ),
    0,
  );
});

// ---------------------------------------------------------------------------
// The kernel floor
// ---------------------------------------------------------------------------

Deno.test("release strings from real distributions parse", () => {
  assertEquals(parseKernelVersion("6.8.0-45-generic"), { major: 6, minor: 8 });
  assertEquals(parseKernelVersion("6.12.4-arch1-1"), { major: 6, minor: 12 });
  assertEquals(parseKernelVersion("5.15.0-1052-aws"), { major: 5, minor: 15 });
  assertEquals(parseKernelVersion("6.7.0\n"), { major: 6, minor: 7 });
  assertEquals(parseKernelVersion("not a kernel"), null);
});

Deno.test("the floor is Landlock ABI v4, and 6.12 is above 6.7", () => {
  // The comparison must be numeric per component: a string compare puts
  // "6.12" below "6.7" and would wave through the exact kernels that work.
  assert(kernelEnforcesNetwork({ major: 6, minor: 12 }));
  assert(kernelEnforcesNetwork({ major: 6, minor: 7 }));
  assert(kernelEnforcesNetwork({ major: 7, minor: 0 }));
  assert(!kernelEnforcesNetwork({ major: 6, minor: 6 }));
  assert(!kernelEnforcesNetwork({ major: 5, minor: 15 }));
});

Deno.test("an unreadable kernel version is not evidence of support", () => {
  // A host that cannot say what kernel it runs must not be treated as capable:
  // the failure it would produce is a sandbox enforcing no network boundary
  // while reporting perfect health.
  assert(!kernelEnforcesNetwork(null));
  assertEquals(MIN_KERNEL, { major: 6, minor: 7 });
});
