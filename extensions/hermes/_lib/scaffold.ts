// A starter declaration for a new bot.
//
// `swamp behavior create` writes a stub with `globalArguments: {}`, which is
// syntactically a model and semantically nothing: every required field is
// absent, every default is invisible, and the fields that actually matter —
// what this bot may reach on the network, what it may read outside its workdir
// — look exactly like the fields that do not. The first render fails on a
// missing key rather than making anyone think about egress.
//
// So the scaffold is deliberately not minimal. It writes every field, fills in
// what can be defaulted safely, and leaves a comment on each decision a person
// has to make. The safe answers are the defaults: no extra filesystem grants,
// no open ports, no MCPs. The one field with no safe default is `egress`, and
// it is marked as such rather than quietly set to `["*"]` — a bot with
// unrestricted egress and deep data access is the shape an injected prompt
// needs, and nobody should acquire it by not reading a line.

/** Indent a prose block as YAML comments. */
function comment(text: string, indent = "  "): string {
  return text.split("\n").map((l) =>
    l.trim() === "" ? `${indent}#` : `${indent}# ${l}`
  ).join("\n");
}

export type ScaffoldInput = {
  slug: string;
  displayName: string;
  vault: string;
  typeVersion: string;
  /** Reuse the id of a stub written by `swamp behavior create`, so scaffolding an
   * already-created model keeps its identity and its data lineage. */
  id: string;
};

export function scaffoldYaml(inp: ScaffoldInput): string {
  const { slug, displayName, vault } = inp;
  return `type: '@skunk-ape/hermes/bot'
typeVersion: ${inp.typeVersion}
id: ${inp.id}
name: ${slug}
version: 1
tags: {}
globalArguments:
  slug: ${slug}
  displayName: "${displayName}"
${
    comment(
      `One line describing what this bot's sandbox does. It becomes the nono
profile description, which is what a reviewer reads first.`,
    )
  }
  summary: "${displayName}: EDIT ME — what this sandbox does, in one line."

${
    comment(
      `Why this bot exists and why its boundaries are shaped the way they are.
Rendered as the header comment of its launcher, so it is in front of anyone
about to widen something.`,
    )
  }
  rationale: |-
    EDIT ME. Why does ${displayName} exist, and why is it a separate runtime
    rather than another profile on an existing bot?

${
    comment(
      `Its own vault. Separate encryption key, one store, and no agent can read
any of it. Put the secrets in before installing: without them the gateway
crash-loops under KeepAlive.

  swamp vault put ${vault} anthropic-key <key>
  swamp vault put ${vault} telegram-bot-token <token>`,
    )
  }
  vault: ${vault}

${
    comment(
      `This bot's OWN Telegram identity. Never share a token between bots: a
shared one puts two agents' conversations in one chat history and one
session database. Create it with @BotFather.

allowedUsers is not a secret, so it lives here where a wrong id is a
one-line fix. An empty list makes the gateway deny every sender, which is
the correct default and a useless bot.`,
    )
  }
  telegram:
    allowedUsers: []          # EDIT ME — numeric Telegram user ids
    homeChannel: "0"          # EDIT ME — where cron results and restart notices land
    homeChannelName: "EDIT ME"

${
    comment(`The boundary. Everything here widens the blast radius of a prompt
injection; nothing here is a convenience setting.

egress: ["*"] is unrestricted. A named list is the exfiltration leg of the
lethal trifecta — it is what an injected prompt needs and cannot get. A bot
with deep data access should have a short list. There is no safe default,
so this one is left wrong on purpose.

filesystemAllow: absolute paths granted IN ADDITION to the workdir. A bot
that can read a directory can be made to read it. Never grant this repo:
it holds the vault material the whole split exists to keep away.

openPorts: a real loopback allowlist under \`nono run\` — it governs connect,
not just bind. Empty means this bot cannot reach another bot's
credential-holding MCPs.`)
  }
  sandbox:
    egress: []                # EDIT ME — ["*"] for unrestricted, or name the hosts
    filesystemAllow: []
    openPorts: []

${
    comment(
      `Set hfOffline when the egress allowlist does not include huggingface.co
and the embedding cache is staged from a sibling bot instead. Failing
loudly beats reaching for a domain the sandbox will refuse.`,
    )
  }
  funes:
    hfOffline: false

${
    comment(
      `Host-side MCP servers this gateway waits for. Each one must also appear
in sandbox.openPorts or the gateway starts toolless — render refuses a
declaration where they disagree. They are NEVER spawned by the gateway:
nono's confinement is inherited, so a spawned MCP would run inside the
sandbox and lose both the credential it exists to hold and its network.`,
    )
  }
  mcps: []

${
    comment(
      `A swamp serve on loopback this bot may run workflows against, or null.
Like an MCP, its port must also be in sandbox.openPorts. Give it
{serverPort, secretKeys: {serverToken, apiKey, signinToken}}: a server token
for the bot's own principal, and a collective token at the narrowest scope,
which the CLI needs only to start. What the bot may run is decided by the
serving repo's grants/, not here.`,
    )
  }
  swamp: null

${
    comment(
      `gateway is the launchd service. Add chat for a terminal session in the
same box, and then a chat block saying where it starts.`,
    )
  }
  entrypoints: [gateway]

${
    comment(
      `What it runs on. Only a seed: once provision has written config.yaml,
Hermes owns that file and this block stops being consulted.`,
    )
  }
  runtime:
    provider: anthropic
    model: anthropic/claude-opus-5
    fallback: []

${
    comment(
      `Prose that would otherwise be lost. Each note is rendered as a comment
above the block it explains, in the generated files. Delete what you do
not need — an inherited comment that is no longer true is worse than none.`,
    )
  }
  notes:
    vault: |-
      EDIT ME — why this bot's secrets are separate.
    telegram: |-
      ${displayName}'s own Telegram bot. A shared token would put two agents'
      conversations in one chat history and one session database.
    funes: |-
      EDIT ME — whose memory this is, and whose it must never be.
methods: {}
`;
}
