// Prove what a bot's sandbox actually enforces.
//
// `bin/verify-sandbox.sh` in hermes-ops does this for one hard-coded agent.
// Every claim it makes is derivable from a declaration instead, which is what
// this file does: the probe is generated from the bot, so each agent is checked
// against its own boundary rather than against Alpha's.
//
// The discipline that matters more than any individual check: a probe that
// could not prove anything reports VACUOUS, never PASS. Two ways a probe goes
// vacuous, and both had been silently passing in the original script for
// months:
//
//   - A denial check against a path that does not exist. A missing file is
//     unreadable whether or not the sandbox is doing anything.
//   - A loopback denial check with nothing listening on the far end. A closed
//     port refuses the connection whether or not the sandbox blocks it.
//
// The second is why the caller binds a real listener before running the probe.

import type { Bot } from "./decl.ts";
import { workdirOf } from "./decl.ts";

/**
 * PASS  — the claim held.
 * FAIL  — the claim did not hold. Something is wrong.
 * VACUOUS — the probe could not prove anything either way.
 * GAP   — the claim did not hold, and is known not to hold. See `loopback`.
 */
export type Outcome = "PASS" | "FAIL" | "VACUOUS" | "GAP";

export type Check = { label: string; outcome: Outcome; detail: string };

/** Paths no agent may read, whatever its declaration says.
 *
 * `repoDir` is in here and is the most important entry: this repository holds
 * the vault material, so an agent that could read it would have exactly what
 * the host-side-MCP split exists to keep away from it.
 *
 * The rest is the host's credential store, which is platform-specific. A
 * wrong-platform entry degrades safely — existence is resolved on the host, so
 * an absent path reports VACUOUS rather than a false PASS — but it also proves
 * nothing, and the point of this list is to prove something. So each platform
 * gets the paths that actually hold secrets on it: the Keychain on macOS, and
 * on Linux the GNOME/KDE SecretService store and the GnuPG home, which is where
 * the same credentials live.
 */
export function deniedPaths(
  repoDir: string,
  platform: "darwin" | "linux" = "darwin",
): string[] {
  const shared = [
    "~/.ssh",
    "~/.aws",
    "~/.config/gh/hosts.yml",
  ];
  const perPlatform = platform === "darwin"
    ? ["~/Library/Keychains"]
    : ["~/.gnupg", "~/.local/share/keyrings"];
  return [...shared, ...perPlatform, repoDir];
}

/** A path, and whether it exists ON THE HOST.
 *
 * Existence has to be resolved outside the sandbox and passed in. From inside,
 * `os.path.exists()` returns False for a path the sandbox denies, so a probe
 * that checked existence itself cannot tell "absent" from "denied" — and would
 * report VACUOUS for the single most important denial there is, the repository
 * holding the vault. */
export type PathCheck = { path: string; existsOnHost: boolean };

/** A port listening on the host that this bot did NOT declare.
 *
 * These are the interesting ones. Whether a sandboxed agent can reach a service
 * it never declared is the whole loopback question, and it can only be asked
 * against a port something is actually bound to. */
export type ForeignPort = { port: number; label: string };

export type ProbeSpec = {
  bot: Bot;
  /** Absolute workdir, with $HOME already resolved. */
  workdir: string;
  granted: PathCheck[];
  denied: PathCheck[];
  foreignPorts: ForeignPort[];
  /** A loopback port with a real listener bound on it, or 0 when one could not
   * be bound — in which case the loopback probe reports VACUOUS. */
  probePort: number;
  /** A host outside every bot's allowlist, for the egress denial check. */
  deniedHost: string;
};

/**
 * A value as a Python literal.
 *
 * NOT JSON.stringify: JSON is close enough to Python syntax to be a trap, and
 * the trap is booleans. `JSON.stringify(true)` is `true`, which Python reads as
 * an undefined name and dies with a NameError at import — after which the whole
 * probe produces no checks at all.
 */
export function pyLiteral(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(pyLiteral).join(", ") + "]";
  throw new Error(`no Python literal for ${typeof v}`);
}

const py = pyLiteral;

/**
 * The probe, as a Python program.
 *
 * Python because it is what the sandbox can reach without any of the bot's own
 * toolchain being installed or working, and because a probe that needed the
 * venv could not distinguish "the sandbox denied it" from "the install is
 * broken".
 */
export function buildProbe(spec: ProbeSpec): string {
  const b = spec.bot;
  const unrestricted = b.sandbox.egress.includes("*");
  // For an allowlisted bot, prove its OWN domains are reachable. Probing a
  // neutral host instead would fail for a correct configuration and say
  // nothing about the policy under test.
  const allowedHosts = unrestricted ? ["api.github.com"] : b.sandbox.egress;

  return `# Generated by @skunk-ape/hermes/bot verify. Runs inside the sandbox.
import os, socket, sys, time, urllib.request, urllib.error

WORKDIR = ${py(spec.workdir)}
PROBE_PORT = ${spec.probePort}
MCP_PORTS = ${py(b.mcps.map((m) => [m.name, m.port]))}
FOREIGN_PORTS = ${py(spec.foreignPorts.map((f) => [f.label, f.port]))}
# [path, exists_on_host] — existence is resolved OUTSIDE the sandbox, because
# from in here a denied stat and a missing file look identical.
GRANTED = ${py(spec.granted.map((g) => [g.path, g.existsOnHost]))}
DENIED = ${py(spec.denied.map((d) => [d.path, d.existsOnHost]))}
ALLOWED_HOSTS = ${py(allowedHosts)}
DENIED_HOST = ${py(spec.deniedHost)}
UNRESTRICTED = ${py(unrestricted)}

def emit(outcome, label, detail=""):
    print("%s\\t%s\\t%s" % (outcome, label, detail))

def ok(label, cond, detail=""):
    emit("PASS" if cond else "FAIL", label, detail)

# --- filesystem: the workdir is writable ----------------------------------
probe = os.path.join(WORKDIR, ".verify-probe")
try:
    open(probe, "w").close()
    os.remove(probe)
    ok("workdir is writable", True)
except Exception as e:
    ok("workdir is writable", False, str(e))

# --- filesystem: declared grants are actually readable --------------------
for path, exists_on_host in GRANTED:
    if not exists_on_host:
        emit("VACUOUS", "granted path %s is readable" % path,
             "does not exist on this host")
        continue
    p = os.path.expanduser(os.path.expandvars(path))
    try:
        os.listdir(p) if os.path.isdir(p) else open(p).read(1)
        ok("granted path %s is readable" % path, True)
    except Exception as e:
        ok("granted path %s is readable" % path, False, str(e))

# --- filesystem: everything else is denied --------------------------------
# A missing path is unreadable whether or not the sandbox is doing anything, so
# absence is VACUOUS rather than a pass. Absence is decided by the caller, on
# the host: in here os.path.exists() is False for anything denied, which would
# turn every working denial into a vacuous non-result.
for path, exists_on_host in DENIED:
    if not exists_on_host:
        emit("VACUOUS", "%s is unreadable" % path, "does not exist on this host")
        continue
    p = os.path.expanduser(path)
    try:
        os.listdir(p) if os.path.isdir(p) else open(p).read(1)
        ok("%s is unreadable" % path, False, "READ SUCCEEDED")
    except OSError as e:
        ok("%s is unreadable" % path, True, type(e).__name__)

try:
    escape = os.path.expanduser("~/.verify-escape")
    open(escape, "w").close()
    os.remove(escape)
    ok("cannot write outside the workdir", False, "WRITE SUCCEEDED at " + escape)
except Exception:
    ok("cannot write outside the workdir", True)

# --- loopback -------------------------------------------------------------
# Every refused connection is counted, because the count decides whether the
# egress phase below has to wait. See the settle note there.
DENIED = [0]

def connects(port, timeout=3):
    s = socket.socket(); s.settimeout(timeout)
    try:
        s.connect(("127.0.0.1", port)); return True
    except Exception:
        DENIED[0] += 1
        return False
    finally:
        s.close()

# Declared MCP ports must be reachable, or the gateway starts toolless. This is
# the positive half and it only means something when a server is actually up.
for name, port in MCP_PORTS:
    if connects(port):
        ok("MCP %s on %d is reachable" % (name, port), True)
    else:
        emit("VACUOUS", "MCP %s on %d is reachable" % (name, port),
             "nothing is listening; start it before trusting this probe")

# Ports this bot did not declare, that something else on the host is really
# listening on. This is the loopback question asked properly: a closed port
# refuses the connection whether or not the sandbox blocks it, so only a port
# with a live listener behind it can answer it.
for label, port in FOREIGN_PORTS:
    if connects(port):
        emit("FAIL", "undeclared port %d (%s) is blocked" % (port, label),
             "REACHED a service this bot never declared")
    else:
        ok("undeclared port %d (%s) is blocked" % (port, label), True)

if PROBE_PORT:
    if connects(PROBE_PORT):
        emit("FAIL", "unlisted loopback %d is blocked" % PROBE_PORT,
             "reachable with a live listener behind it")
    else:
        emit("PASS", "unlisted loopback %d is blocked" % PROBE_PORT, "refused")
else:
    emit("VACUOUS", "unlisted loopback is blocked",
         "no probe listener was bound; a closed port proves nothing")

# --- settle ---------------------------------------------------------------
# The loopback phase above deliberately provokes connections the sandbox
# refuses, and on Linux nono's seccomp supervisor rate-limits denials. Once
# tripped it returns EPERM for EVERY subsequent connect — including the one to
# nono's own egress proxy, which is how all outbound traffic leaves the box. The
# egress checks below would then fail, and report that a bot with
# egress ["*"] cannot reach the network at all.
#
# That is a probe flooding its own supervisor and then blaming the sandbox, and
# it is exactly the kind of false result this file exists to avoid — a VACUOUS
# would at least have been honest. It cost an afternoon on the first Linux host:
# alpha failed and beta passed on identical egress, the only difference
# being that alpha declares four MCP ports to be refused and beta declares
# none.
#
# Measured on kernel 7.2.5: six back-to-back denials trip it, one second of
# quiet clears it. Two seconds, paid once per run and only when something was
# actually denied, buys a check that means what it says.
if DENIED[0] > 0:
    time.sleep(2)

# --- egress ---------------------------------------------------------------
# Redirects are NOT followed. api.telegram.org answers with a redirect to
# core.telegram.org, which is a different host and not in anyone's allowlist —
# so following it makes a correctly-reachable host look refused, and the
# refusal that comes back names a host the declaration never mentioned.
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

_opener = urllib.request.build_opener(_NoRedirect)

def reaches(host):
    # Any HTTP response proves the connection was allowed. 401, 403, 404 and
    # 3xx are all reachability: these endpoints are being connected to, not
    # authenticated against.
    try:
        _opener.open("https://%s/" % host, timeout=15)
        return True, "connected"
    except urllib.error.HTTPError as e:
        return True, "HTTP %d" % e.code
    except Exception as e:
        return False, type(e).__name__ + ": " + str(e)[:80]

for host in ALLOWED_HOSTS:
    got, detail = reaches(host)
    label = ("general egress works (%s)" % host) if UNRESTRICTED \\
        else ("allowed host %s is reachable" % host)
    ok(label, got, detail)

if UNRESTRICTED:
    emit("VACUOUS", "a host outside the allowlist is refused",
         "egress is [\\"*\\"]: there is no allowlist to be outside of")
else:
    got, detail = reaches(DENIED_HOST)
    ok("%s is refused" % DENIED_HOST, not got, detail)
`;
}

/** Read the probe's output back. Anything unparseable is surfaced rather than
 * dropped: a probe that crashed must not look like a probe that passed. */
export function parseProbeOutput(text: string): Check[] {
  const checks: Check[] = [];
  const noise: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    const outcome = parts[0];
    if (
      parts.length >= 2 &&
      (outcome === "PASS" || outcome === "FAIL" || outcome === "VACUOUS" ||
        outcome === "GAP")
    ) {
      checks.push({
        label: parts[1],
        outcome: outcome as Outcome,
        detail: parts[2] ?? "",
      });
    } else {
      noise.push(line);
    }
  }
  if (noise.length > 0) {
    checks.push({
      label: "probe produced unparseable output",
      outcome: "FAIL",
      detail: noise.join(" | ").slice(0, 500),
    });
  }
  return checks;
}

export type Summary = {
  pass: number;
  fail: number;
  vacuous: number;
  gap: number;
  /** No FAILs. Vacuous checks do not fail a run, but they are not evidence
   * either, so they are counted where a reader will see them. */
  clean: boolean;
};

export function summarize(checks: Check[]): Summary {
  const count = (o: Outcome) => checks.filter((c) => c.outcome === o).length;
  const fail = count("FAIL");
  return {
    pass: count("PASS"),
    fail,
    vacuous: count("VACUOUS"),
    gap: count("GAP"),
    clean: fail === 0,
  };
}

/** Where the probe is written. Inside the workdir because that is the one place
 * the sandbox can read it from. */
export function probePath(b: Bot, home: string): string {
  return `${workdirOf(b).replace("$HOME", home)}/.verify-probe.py`;
}
