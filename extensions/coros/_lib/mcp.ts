// A minimal MCP client for one server: COROS's official one.
//
// mcpus.coros.com is stateless streamable HTTP. It issues no session id, so a
// tool call is a single JSON-RPC POST with a bearer token, and there is no
// connection to hold open or process to supervise. That is what makes it an
// API this extension can call directly, rather than an MCP an agent has to
// host.
//
// Every tool returns its result as text, and that text is itself JSON-encoded:
// the content item's `text` is `"\"Sleep Overview\\n...\""`, a JSON string
// literal. So the text is decoded once more here. If a tool ever returns a
// JSON object instead, it is kept as `json` rather than flattened, because
// structured output is what this extension would rather have.

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ToolResult = {
  tool: string;
  text: string;
  json: unknown | null;
  isError: boolean;
};

/** The server refused the token. The caller refreshes and tries once more. */
export class McpAuthError extends Error {}

/** Decode content items, undoing the server's extra layer of JSON encoding. */
export function decodeContent(
  content: Array<{ type?: string; text?: string }> | undefined,
): { text: string; json: unknown | null } {
  const texts: string[] = [];
  let json: unknown | null = null;
  for (const item of content ?? []) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(item.text);
    } catch {
      // Plain text, not double-encoded. Take it as it is.
    }
    if (typeof parsed === "string") {
      texts.push(parsed);
    } else if (parsed !== undefined && parsed !== null) {
      json = parsed;
      texts.push(item.text);
    } else {
      texts.push(item.text);
    }
  }
  return { text: texts.join("\n"), json };
}

/** Pull the JSON-RPC message out of an SSE body, should the server send one. */
export function parseSse(body: string): unknown {
  let last: unknown = null;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      last = JSON.parse(data);
    } catch {
      // A partial or non-JSON event. The response is the last whole one.
    }
  }
  return last;
}

export async function callTool(opts: {
  url: string;
  token: string;
  name: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<ToolResult> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(opts.url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${opts.token}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: opts.name, arguments: opts.args },
    }),
    signal: opts.signal,
  });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new McpAuthError(`COROS refused the token (HTTP ${res.status})`);
  }
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `COROS MCP ${opts.name}: HTTP ${res.status} ${body.slice(0, 300)}`,
    );
  }
  const type = res.headers.get("content-type") ?? "";
  // deno-lint-ignore no-explicit-any
  const msg: any = type.includes("text/event-stream")
    ? parseSse(body)
    : JSON.parse(body);
  if (!msg || typeof msg !== "object") {
    throw new Error(`COROS MCP ${opts.name}: empty response`);
  }
  if (msg.error) {
    throw new Error(
      `COROS MCP ${opts.name}: ${
        msg.error.message ?? JSON.stringify(msg.error)
      }`,
    );
  }
  const { text, json } = decodeContent(msg.result?.content);
  return {
    tool: opts.name,
    text,
    json: msg.result?.structuredContent ?? json,
    isError: msg.result?.isError === true,
  };
}
