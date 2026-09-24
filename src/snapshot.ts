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
import {
  LIST_PAGE_LIMIT,
  MCP_PARSER_CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  isProtocolRevision,
  isStatelessRevision,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * Describe an RPC error, including the revisions a server says it supports
 * when it refuses the one requested, so the caller can choose another.
 */
function rpcError(error: JsonRpcError): McpSnapshotError {
  const data = error.data as { supported?: unknown } | undefined;
  const supported = Array.isArray(data?.supported)
    ? `; supported revisions: ${data.supported.join(", ")}`
    : "";
  return new McpSnapshotError(`RPC error: ${error.message} (${error.code})${supported}`);
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
  /**
   * Maximum pages read per paginated list. Default: {@link LIST_PAGE_LIMIT}.
   * A snapshot stopped by this bound records `x-mcp-parser-incomplete`.
   */
  pageLimit?: number;
  /**
   * Protocol revision to request. Default: {@link MCP_PROTOCOL_VERSION}.
   *
   * A handshake revision (`2025-11-25` and earlier) is offered in
   * `initialize`, and later requests declare whatever the server negotiates.
   * A stateless revision (`2026-07-28` and later) is declared on every
   * request, and the server describes itself through `server/discover`.
   */
  protocolVersion?: string;
}

// ---------------------------------------------------------------------------
// Transport-agnostic introspection
// ---------------------------------------------------------------------------

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

interface McpConnection {
  send: Send;
  notify: (method: string, params?: Record<string, unknown>) => void;
  close: () => void;
}

/**
 * The revision every request declares. A handshake revision starts as the one
 * requested and becomes whatever `initialize` negotiates; a stateless revision
 * holds for the whole snapshot.
 */
interface Negotiation {
  version: string;
  stateless: boolean;
}

/** What the server says about itself before any list is read. */
interface Surface {
  server: McpServerInfo;
  capabilities?: McpCapabilities;
  mcpVersion?: string;
  mcpVersions?: string[];
  send: Send;
}

interface ListPage {
  nextCursor?: unknown;
  [key: string]: unknown;
}

interface ListOutcome<T> {
  items: T[];
  /** True when the page limit stopped the walk before the server ran out. */
  truncated: boolean;
}

/**
 * Walk every page of a paginated list method.
 *
 * Cursors are opaque: only the presence of a string `nextCursor` means more
 * results exist, so an empty string is a valid cursor and must not end the
 * walk. A snapshot that stops early records that fact rather than presenting a
 * partial list as complete.
 */
async function listAll<T>(
  send: Send,
  method: string,
  key: string,
  pageLimit: number,
): Promise<ListOutcome<T>> {
  const items: T[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < pageLimit; page += 1) {
    const result = (await send(
      method,
      cursor === undefined ? undefined : { cursor },
    )) as ListPage | null;

    const entries = result?.[key];
    if (Array.isArray(entries)) items.push(...(entries as T[]));

    const next = result?.nextCursor;
    if (typeof next !== "string") return { items, truncated: false };
    cursor = next;
  }

  return { items, truncated: true };
}

const UNKNOWN_SERVER: McpServerInfo = { name: "unknown", version: "0.0.0" };

/** Handshake revisions: offer one in `initialize`, then use what comes back. */
async function initialize(conn: McpConnection, negotiation: Negotiation): Promise<Surface> {
  const initResult = (await conn.send("initialize", {
    protocolVersion: negotiation.version,
    capabilities: {},
    clientInfo: MCP_PARSER_CLIENT_INFO,
  })) as {
    protocolVersion?: string;
    serverInfo?: McpServerInfo;
    capabilities?: McpCapabilities;
  };

  // Every later request, the initialized notification included, declares the
  // negotiated revision rather than the one offered.
  if (typeof initResult.protocolVersion === "string") {
    negotiation.version = initResult.protocolVersion;
  }
  conn.notify("notifications/initialized");

  return {
    server: initResult.serverInfo ?? UNKNOWN_SERVER,
    capabilities: initResult.capabilities,
    mcpVersion: initResult.protocolVersion,
    send: conn.send,
  };
}

/** Stateless revisions: every request carries `_meta`; discovery replaces the handshake. */
async function discover(conn: McpConnection, negotiation: Negotiation): Promise<Surface> {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": negotiation.version,
    "io.modelcontextprotocol/clientInfo": MCP_PARSER_CLIENT_INFO,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const send: Send = (method, params) => conn.send(method, { ...params, _meta: meta });

  const result = (await send("server/discover")) as {
    supportedVersions?: unknown;
    capabilities?: McpCapabilities;
    _meta?: Record<string, unknown>;
  };
  const server = result._meta?.["io.modelcontextprotocol/serverInfo"] as
    | McpServerInfo
    | undefined;
  const supported = Array.isArray(result.supportedVersions)
    ? result.supportedVersions.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  return {
    server: server ?? UNKNOWN_SERVER,
    capabilities: result.capabilities,
    // The server accepted the revision it was sent; that is the one spoken.
    mcpVersion: negotiation.version,
    ...(supported?.length && { mcpVersions: supported }),
    send,
  };
}

async function introspect(
  conn: McpConnection,
  transport: SnapshotTransport,
  pageLimit: number,
  negotiation: Negotiation,
): Promise<McpSpec> {
  try {
    const { server, capabilities, mcpVersion, mcpVersions, send } = negotiation.stateless
      ? await discover(conn, negotiation)
      : await initialize(conn, negotiation);

    const [toolsResult, resourcesResult, templatesResult, promptsResult] =
      await Promise.allSettled([
        capabilities?.tools
          ? listAll<McpTool>(send, "tools/list", "tools", pageLimit)
          : Promise.resolve(null),
        capabilities?.resources
          ? listAll<McpResource>(send, "resources/list", "resources", pageLimit)
          : Promise.resolve(null),
        capabilities?.resources
          ? listAll<McpResourceTemplate>(
              send,
              "resources/templates/list",
              "resourceTemplates",
              pageLimit,
            )
          : Promise.resolve(null),
        capabilities?.prompts
          ? listAll<McpPrompt>(send, "prompts/list", "prompts", pageLimit)
          : Promise.resolve(null),
      ]);

    const settled = <T>(
      outcome: PromiseSettledResult<ListOutcome<T> | null>,
    ): ListOutcome<T> | undefined =>
      outcome.status === "fulfilled" && outcome.value ? outcome.value : undefined;

    const toolList = settled<McpTool>(toolsResult);
    const resourceList = settled<McpResource>(resourcesResult);
    const templateList = settled<McpResourceTemplate>(templatesResult);
    const promptList = settled<McpPrompt>(promptsResult);

    const tools = toolList?.items;
    const resources = resourceList?.items;
    const resourceTemplates = templateList?.items;
    const prompts = promptList?.items;

    const truncated = (
      [
        ["tools", toolList],
        ["resources", resourceList],
        ["resourceTemplates", templateList],
        ["prompts", promptList],
      ] as const
    )
      .filter(([, outcome]) => outcome?.truncated)
      .map(([name]) => name);

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
      ...(mcpVersions && { mcpVersions }),
      server,
      ...(capabilities && { capabilities }),
      transport: transportHint,
      ...(tools?.length && { tools }),
      ...(resources?.length && { resources }),
      ...(resourceTemplates?.length && { resourceTemplates }),
      ...(prompts?.length && { prompts }),
      // An incomplete snapshot says so. Absent means every page was read.
      ...(truncated.length > 0 && {
        "x-mcp-parser-incomplete": { pageLimitReached: truncated, pageLimit },
      }),
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
  const pageLimit = options.pageLimit ?? LIST_PAGE_LIMIT;
  const transport = options.transport;
  const requested = options.protocolVersion ?? MCP_PROTOCOL_VERSION;
  if (!isProtocolRevision(requested)) {
    throw new McpSnapshotError(`Protocol revision must be YYYY-MM-DD, got ${requested}`);
  }
  const negotiation: Negotiation = {
    version: requested,
    stateless: isStatelessRevision(requested),
  };

  let conn: McpConnection;
  switch (transport.type) {
    case "stdio":
      conn = connectStdio(transport, timeout);
      break;
    case "sse":
      if (negotiation.stateless) {
        throw new McpSnapshotError(
          `HTTP+SSE predates protocol revision ${requested}; use streamable-http`,
        );
      }
      conn = await connectSse(transport, timeout, negotiation);
      break;
    case "streamable-http":
      conn = connectStreamableHttp(transport, timeout, negotiation);
      break;
    default:
      throw new McpSnapshotError(
        `Unknown transport type: ${(transport as Record<string, unknown>).type}`,
      );
  }

  return introspect(conn, transport, pageLimit, negotiation);
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
            p.reject(rpcError(msg.error));
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
  negotiation: Negotiation,
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
      "MCP-Protocol-Version": negotiation.version,
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
              p.reject(rpcError(msg.error));
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
            "MCP-Protocol-Version": negotiation.version,
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
          "MCP-Protocol-Version": negotiation.version,
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

/**
 * A header-safe rendering of a value mirrored from the body: plain visible
 * ASCII as-is, anything else (or anything that looks like the sentinel) as the
 * specification's `=?base64?…?=` form.
 */
function headerValue(value: string): string {
  const plain = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/.test(value);
  const sentinel = value.startsWith("=?base64?") && value.endsWith("?=");
  return plain && !sentinel ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Read a JSON-RPC error from a refused response, when the body holds one. */
async function refusal(response: Response): Promise<McpSnapshotError> {
  const status = `HTTP ${response.status}: ${response.statusText}`;
  try {
    const body = (await response.json()) as Partial<JsonRpcResponse>;
    if (body?.error) return new McpSnapshotError(`${status} (${rpcError(body.error).message})`);
  } catch {
    // Not a JSON-RPC body; the status is all there is.
  }
  return new McpSnapshotError(status);
}

function connectStreamableHttp(
  transport: StreamableHttpTransport,
  timeout: number,
  negotiation: Negotiation,
): McpConnection {
  let nextId = 1;
  /**
   * Session id minted by the server on initialize. Stateful servers require it
   * on every subsequent request and release it on DELETE. Servers that mint
   * none stay stateless and this remains null.
   */
  let sessionId: string | null = null;

  function requestHeaders(
    method?: string,
    params?: Record<string, unknown>,
  ): Record<string, string> {
    // Stateless revisions mirror the method, and the tool, prompt, or resource
    // it names, into headers that intermediaries can route on.
    const name = params?.name ?? params?.uri;
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": negotiation.version,
      ...(negotiation.stateless && method ? { "Mcp-Method": method } : {}),
      ...(negotiation.stateless && typeof name === "string"
        ? { "Mcp-Name": headerValue(name) }
        : {}),
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      ...transport.headers,
    };
  }

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
          headers: requestHeaders(method, params),
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        clearTimeout(timer);

        const mintedSession = response.headers.get("mcp-session-id");
        if (mintedSession) sessionId = mintedSession;

        if (!response.ok) throw await refusal(response);

        const contentType = response.headers.get("content-type") ?? "";

        if (contentType.includes("application/json")) {
          const msg = (await response.json()) as JsonRpcResponse;
          if (msg.error) throw rpcError(msg.error);
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
                  if (msg.error) throw rpcError(msg.error);
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
        headers: requestHeaders(method, params),
        body: JSON.stringify(msg),
      }).catch(() => {});
    },
    close() {
      // Release the server's session if it minted one; stateless servers have
      // nothing to close.
      if (!sessionId) return;
      void fetch(transport.url, {
        method: "DELETE",
        headers: requestHeaders(),
      }).catch(() => {});
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
