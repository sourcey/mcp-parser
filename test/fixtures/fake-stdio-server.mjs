#!/usr/bin/env node
/**
 * Minimal MCP server over stdio, for snapshot tests.
 *
 * Paginates `tools/list` across three pages and deliberately uses an empty
 * string as the second cursor: an empty cursor is valid and must not be read as
 * the end of results.
 */

let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    const result = handle(message);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  }
});

function tool(name) {
  return { name, description: `tool ${name}`, inputSchema: { type: "object" } };
}

function handle(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion ?? "unknown",
      serverInfo: { name: "fake-stdio", version: "1.2.3" },
      capabilities: { tools: { listChanged: false } },
    };
  }
  if (message.method === "tools/list") {
    const cursor = message.params?.cursor;
    if (cursor === undefined) return { tools: [tool("alpha")], nextCursor: "" };
    if (cursor === "") return { tools: [tool("beta")], nextCursor: "final" };
    return { tools: [tool("gamma")] };
  }
  return {};
}
