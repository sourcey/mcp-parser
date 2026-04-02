/**
 * Snapshot a running MCP server into an McpSpec document.
 *
 * Connects to an MCP server via stdio or SSE, calls the introspection
 * endpoints, and returns a static McpSpec snapshot.
 */

import { spawn } from "node:child_process";
import type {
  McpSpec,
  McpTool,
  McpResource,
  McpResourceTemplate,
  McpPrompt,
  McpCapabilities,
  McpServerInfo,
} from "mcp-schema";
import { MCP_SPEC_VERSION } from "mcp-schema";

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// Snapshot options
// ---------------------------------------------------------------------------

export interface StdioTransport {
  type: "stdio";
  /** Command to start the MCP server. */
  command: string;
  /** Command arguments. */
  args?: string[];
  /** Environment variables. */
  env?: Record<string, string>;
}

export interface SseTransport {
  type: "sse";
  /** SSE endpoint URL. */
  url: string;
  /** Optional headers (e.g., for auth). */
  headers?: Record<string, string>;
}

export type SnapshotTransport = StdioTransport | SseTransport;

export interface SnapshotOptions {
  /** Transport configuration. */
  transport: SnapshotTransport;
  /** Timeout in milliseconds. Default: 30000. */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Stdio client
// ---------------------------------------------------------------------------

/**
 * Snapshot a running MCP server.
 *
 * @example
 * ```ts
 * import { snapshot } from "mcp-parser";
 *
 * const spec = await snapshot({
 *   transport: {
 *     type: "stdio",
 *     command: "node",
 *     args: ["my-mcp-server.js"],
 *   },
 * });
 *
 * console.log(JSON.stringify(spec, null, 2));
 * ```
 */
export async function snapshot(options: SnapshotOptions): Promise<McpSpec> {
  if (options.transport.type === "stdio") {
    return snapshotStdio(options.transport, options.timeout ?? 30_000);
  }

  if (options.transport.type === "sse") {
    throw new McpSnapshotError(
      "SSE transport is not yet implemented. Use stdio for now.",
    );
  }

  throw new McpSnapshotError(
    `Unknown transport type: ${(options.transport as Record<string, unknown>).type}`,
  );
}

async function snapshotStdio(
  transport: StdioTransport,
  timeout: number,
): Promise<McpSpec> {
  const proc = spawn(transport.command, transport.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...transport.env },
  });

  let nextId = 1;
  let buffer = "";
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
    }
  >();

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    // MCP uses newline-delimited JSON
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) {
            p.reject(
              new McpSnapshotError(
                `RPC error: ${msg.error.message} (${msg.error.code})`,
              ),
            );
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        // Ignore non-JSON lines (server logs, etc.)
      }
    }
  });

  function send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params && { params }),
      };
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify(request) + "\n");

      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new McpSnapshotError(`Timeout waiting for response to ${method}`));
        }
      }, timeout);
    });
  }

  try {
    // Initialize
    const initResult = (await send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mcp-parser", version: "0.1.0" },
    })) as {
      protocolVersion?: string;
      serverInfo?: McpServerInfo;
      capabilities?: McpCapabilities;
    };

    // Send initialized notification (no response expected)
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );

    const server = initResult.serverInfo ?? {
      name: "unknown",
      version: "0.0.0",
    };
    const capabilities = initResult.capabilities;
    const mcpVersion = initResult.protocolVersion;

    // Introspect in parallel
    const [toolsResult, resourcesResult, resourceTemplatesResult, promptsResult] =
      await Promise.allSettled([
        capabilities?.tools ? send("tools/list") : Promise.resolve(null),
        capabilities?.resources ? send("resources/list") : Promise.resolve(null),
        capabilities?.resources
          ? send("resources/templates/list")
          : Promise.resolve(null),
        capabilities?.prompts ? send("prompts/list") : Promise.resolve(null),
      ]);

    const tools =
      toolsResult.status === "fulfilled" && toolsResult.value
        ? ((toolsResult.value as { tools?: McpTool[] }).tools ?? [])
        : undefined;

    const resources =
      resourcesResult.status === "fulfilled" && resourcesResult.value
        ? ((resourcesResult.value as { resources?: McpResource[] }).resources ?? [])
        : undefined;

    const resourceTemplates =
      resourceTemplatesResult.status === "fulfilled" &&
      resourceTemplatesResult.value
        ? ((
            resourceTemplatesResult.value as {
              resourceTemplates?: McpResourceTemplate[];
            }
          ).resourceTemplates ?? [])
        : undefined;

    const prompts =
      promptsResult.status === "fulfilled" && promptsResult.value
        ? ((promptsResult.value as { prompts?: McpPrompt[] }).prompts ?? [])
        : undefined;

    const spec: McpSpec = {
      mcpSpec: MCP_SPEC_VERSION,
      ...(mcpVersion && { mcpVersion }),
      server,
      ...(capabilities && { capabilities }),
      transport: {
        type: "stdio",
        command: transport.command,
        ...(transport.args?.length && { args: transport.args }),
      },
      ...(tools?.length && { tools }),
      ...(resources?.length && { resources }),
      ...(resourceTemplates?.length && { resourceTemplates }),
      ...(prompts?.length && { prompts }),
    };

    return spec;
  } finally {
    proc.kill();
  }
}

/** Error thrown during MCP server snapshot. */
export class McpSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSnapshotError";
  }
}
