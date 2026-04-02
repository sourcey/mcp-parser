/**
 * Snapshot a running MCP server into an McpSpec document.
 *
 * Connects to an MCP server via stdio, SSE, or streamable HTTP,
 * calls the introspection endpoints, and returns a static McpSpec snapshot.
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
// Transport types
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
  /** Optional headers for auth. */
  headers?: Record<string, string>;
}

export interface StreamableHttpTransport {
  type: "streamable-http";
  /** Server URL. */
  url: string;
  /** Optional headers for auth. */
  headers?: Record<string, string>;
}

export type SnapshotTransport =
  | StdioTransport
  | SseTransport
  | StreamableHttpTransport;

export interface SnapshotOptions {
  /** Transport configuration. */
  transport: SnapshotTransport;
  /** Timeout in milliseconds. Default: 30000. */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Transport-agnostic introspection
// ---------------------------------------------------------------------------

interface McpConnection {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  notify: (method: string, params?: Record<string, unknown>) => void;
  close: () => void;
}

async function introspect(
  conn: McpConnection,
  transport: SnapshotTransport,
): Promise<McpSpec> {
  try {
    const initResult = (await conn.send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mcp-parser", version: "0.1.0" },
    })) as {
      protocolVersion?: string;
      serverInfo?: McpServerInfo;
      capabilities?: McpCapabilities;
    };

    conn.notify("notifications/initialized");

    const server = initResult.serverInfo ?? { name: "unknown", version: "0.0.0" };
    const capabilities = initResult.capabilities;
    const mcpVersion = initResult.protocolVersion;

    const [toolsResult, resourcesResult, templatesResult, promptsResult] =
      await Promise.allSettled([
        capabilities?.tools ? conn.send("tools/list") : Promise.resolve(null),
        capabilities?.resources ? conn.send("resources/list") : Promise.resolve(null),
        capabilities?.resources
          ? conn.send("resources/templates/list")
          : Promise.resolve(null),
        capabilities?.prompts ? conn.send("prompts/list") : Promise.resolve(null),
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
      templatesResult.status === "fulfilled" && templatesResult.value
        ? ((templatesResult.value as { resourceTemplates?: McpResourceTemplate[] })
            .resourceTemplates ?? [])
        : undefined;

    const prompts =
      promptsResult.status === "fulfilled" && promptsResult.value
        ? ((promptsResult.value as { prompts?: McpPrompt[] }).prompts ?? [])
        : undefined;

    const transportHint =
      transport.type === "stdio"
        ? {
            type: "stdio" as const,
            command: transport.command,
            ...(transport.args?.length && { args: transport.args }),
          }
        : { type: transport.type, url: transport.url };

    return {
      mcpSpec: MCP_SPEC_VERSION,
      ...(mcpVersion && { mcpVersion }),
      server,
      ...(capabilities && { capabilities }),
      transport: transportHint,
      ...(tools?.length && { tools }),
      ...(resources?.length && { resources }),
      ...(resourceTemplates?.length && { resourceTemplates }),
      ...(prompts?.length && { prompts }),
    };
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Snapshot a running MCP server.
 *
 * @example
 * ```ts
 * import { snapshot } from "mcp-parser";
 *
 * // stdio
 * const spec = await snapshot({
 *   transport: { type: "stdio", command: "node", args: ["server.js"] },
 * });
 *
 * // SSE
 * const spec = await snapshot({
 *   transport: { type: "sse", url: "http://localhost:3000/sse" },
 * });
 *
 * // Streamable HTTP
 * const spec = await snapshot({
 *   transport: { type: "streamable-http", url: "http://localhost:3000/mcp" },
 * });
 * ```
 */
export async function snapshot(options: SnapshotOptions): Promise<McpSpec> {
  const timeout = options.timeout ?? 30_000;
  const transport = options.transport;

  let conn: McpConnection;
  switch (transport.type) {
    case "stdio":
      conn = connectStdio(transport, timeout);
      break;
    case "sse":
      conn = await connectSse(transport, timeout);
      break;
    case "streamable-http":
      conn = connectStreamableHttp(transport, timeout);
      break;
    default:
      throw new McpSnapshotError(
        `Unknown transport type: ${(transport as Record<string, unknown>).type}`,
      );
  }

  return introspect(conn, transport);
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

function connectStdio(transport: StdioTransport, timeout: number): McpConnection {
  const proc = spawn(transport.command, transport.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...transport.env },
  });

  let nextId = 1;
  let buffer = "";
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
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
            p.reject(new McpSnapshotError(`RPC error: ${msg.error.message} (${msg.error.code})`));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        // Non-JSON output (server logs, etc.)
      }
    }
  });

  return {
    send(method, params) {
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
    },
    notify(method, params) {
      const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
      if (params) msg.params = params;
      proc.stdin.write(JSON.stringify(msg) + "\n");
    },
    close() {
      proc.kill();
    },
  };
}

// ---------------------------------------------------------------------------
// SSE transport
// ---------------------------------------------------------------------------

async function connectSse(
  transport: SseTransport,
  timeout: number,
): Promise<McpConnection> {
  const baseUrl = transport.url.replace(/\/sse\/?$/, "");
  let messageEndpoint: string | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  // Connect to SSE endpoint and wait for the endpoint event
  const controller = new AbortController();
  const sseResponse = await fetch(transport.url, {
    headers: {
      Accept: "text/event-stream",
      ...transport.headers,
    },
    signal: controller.signal,
  });

  if (!sseResponse.ok) {
    throw new McpSnapshotError(`SSE connection failed: ${sseResponse.status} ${sseResponse.statusText}`);
  }

  if (!sseResponse.body) {
    throw new McpSnapshotError("SSE response has no body");
  }

  // Parse SSE stream in background
  const reader = sseResponse.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";

  function processSseEvents(): void {
    const events = sseBuf.split("\n\n");
    sseBuf = events.pop() ?? "";
    for (const event of events) {
      let eventType = "message";
      let data = "";
      for (const line of event.split("\n")) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          data += line.slice(6);
        }
      }
      if (eventType === "endpoint" && data) {
        // The server tells us where to POST messages
        messageEndpoint = data.startsWith("http") ? data : `${baseUrl}${data}`;
      } else if (eventType === "message" && data) {
        try {
          const msg = JSON.parse(data) as JsonRpcResponse;
          if (msg.id !== undefined && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) {
              p.reject(new McpSnapshotError(`RPC error: ${msg.error.message} (${msg.error.code})`));
            } else {
              p.resolve(msg.result);
            }
          }
        } catch {
          // Non-JSON SSE data
        }
      }
    }
  }

  // Read SSE in background
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        processSseEvents();
      }
    } catch {
      // Stream closed
    }
  })();

  // Wait for the endpoint event
  const endpointDeadline = Date.now() + timeout;
  while (!messageEndpoint && Date.now() < endpointDeadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!messageEndpoint) {
    controller.abort();
    throw new McpSnapshotError("Timeout waiting for SSE endpoint event");
  }

  return {
    async send(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const request: JsonRpcRequest = {
          jsonrpc: "2.0",
          id,
          method,
          ...(params && { params }),
        };
        pending.set(id, { resolve, reject });

        fetch(messageEndpoint!, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...transport.headers,
          },
          body: JSON.stringify(request),
        }).catch((err: Error) => {
          pending.delete(id);
          reject(new McpSnapshotError(`SSE POST failed: ${err.message}`));
        });

        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new McpSnapshotError(`Timeout waiting for response to ${method}`));
          }
        }, timeout);
      });
    },
    notify(method, params) {
      const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
      if (params) msg.params = params;
      fetch(messageEndpoint!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...transport.headers,
        },
        body: JSON.stringify(msg),
      }).catch(() => {});
    },
    close() {
      controller.abort();
    },
  };
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport
// ---------------------------------------------------------------------------

function connectStreamableHttp(
  transport: StreamableHttpTransport,
  timeout: number,
): McpConnection {
  let nextId = 1;

  return {
    async send(method, params) {
      const id = nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params && { params }),
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(transport.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...transport.headers,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          throw new McpSnapshotError(
            `HTTP ${response.status}: ${response.statusText}`,
          );
        }

        const contentType = response.headers.get("content-type") ?? "";

        if (contentType.includes("application/json")) {
          const msg = (await response.json()) as JsonRpcResponse;
          if (msg.error) {
            throw new McpSnapshotError(
              `RPC error: ${msg.error.message} (${msg.error.code})`,
            );
          }
          return msg.result;
        }

        // SSE-style streaming response: collect message events
        if (contentType.includes("text/event-stream") && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });

            const events = buf.split("\n\n");
            buf = events.pop() ?? "";
            for (const event of events) {
              let data = "";
              for (const line of event.split("\n")) {
                if (line.startsWith("data: ")) data += line.slice(6);
              }
              if (!data) continue;
              try {
                const msg = JSON.parse(data) as JsonRpcResponse;
                if (msg.id === id) {
                  if (msg.error) {
                    throw new McpSnapshotError(
                      `RPC error: ${msg.error.message} (${msg.error.code})`,
                    );
                  }
                  return msg.result;
                }
              } catch (e) {
                if (e instanceof McpSnapshotError) throw e;
              }
            }
          }

          throw new McpSnapshotError(`No response for request ${id} in SSE stream`);
        }

        throw new McpSnapshotError(`Unexpected content-type: ${contentType}`);
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof McpSnapshotError) throw e;
        if ((e as Error).name === "AbortError") {
          throw new McpSnapshotError(`Timeout waiting for response to ${method}`);
        }
        throw new McpSnapshotError(`HTTP request failed: ${(e as Error).message}`);
      }
    },
    notify(method, params) {
      const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
      if (params) msg.params = params;
      fetch(transport.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...transport.headers,
        },
        body: JSON.stringify(msg),
      }).catch(() => {});
    },
    close() {
      // Stateless, nothing to close
    },
  };
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Error thrown during MCP server snapshot. */
export class McpSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSnapshotError";
  }
}
