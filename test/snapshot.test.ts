import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_PARSER_CLIENT_INFO, MCP_PROTOCOL_VERSION } from "../src/protocol.js";
import { snapshot } from "../src/snapshot.js";
import { createConfig, snapshotConfig } from "../src/config.js";

const stdioServerPath = fileURLToPath(
  new URL("./fixtures/fake-stdio-server.mjs", import.meta.url),
);

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

function tool(name: string) {
  return { name, description: `tool ${name}`, inputSchema: { type: "object" } };
}

/** Three pages of tools, with an empty-string cursor in the middle. */
function toolsPage(cursor: unknown): Record<string, unknown> {
  if (cursor === undefined) return { tools: [tool("alpha")], nextCursor: "" };
  if (cursor === "") return { tools: [tool("beta")], nextCursor: "final" };
  return { tools: [tool("gamma")] };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function readBody(
  request: import("node:http").IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * A stateful Streamable HTTP server: it mints a session on initialize and
 * rejects any later request that fails to echo it, which is exactly how real
 * stateful servers behave.
 */
async function startStatefulHttpServer(
  options: { pages?: number; negotiate?: string } = {},
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const sessionId = "session-abc-123";
  const totalPages = options.pages ?? 3;

  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers as Record<string, string | undefined>,
      body,
    });

    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }

    const message = body as { id?: number; method?: string; params?: Record<string, unknown> };

    if (message?.method === "initialize") {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: options.negotiate ?? MCP_PROTOCOL_VERSION,
            serverInfo: { name: "fake-http", version: "2.0.0" },
            capabilities: { tools: { listChanged: false } },
          },
        }),
      );
      return;
    }

    // Every non-initialize request must carry the minted session.
    if (request.headers["mcp-session-id"] !== sessionId) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message?.id ?? null,
          error: { code: -32600, message: "Missing or invalid session" },
        }),
      );
      return;
    }

    if (message?.id === undefined) {
      response.writeHead(202).end();
      return;
    }

    if (message.method === "tools/list") {
      const cursor = message.params?.cursor;
      const result =
        totalPages === 1
          ? { tools: [tool("only")] }
          : { ...toolsPage(cursor), nextCursor: "endless" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
  });

  const url = await listen(server);
  return {
    url: `${url}/mcp`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Legacy HTTP+SSE server: announces its message endpoint, then streams replies. */
async function startSseServer(endpoint = "/messages"): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  let stream: import("node:http").ServerResponse | null = null;

  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers as Record<string, string | undefined>,
      body,
    });

    if (request.url?.startsWith("/sse")) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      stream = response;
      response.write(`event: endpoint\ndata: ${endpoint}\n\n`);
      return;
    }

    const message = body as { id?: number; method?: string; params?: Record<string, unknown> };
    response.writeHead(202).end();
    if (message?.id === undefined || !stream) return;

    const result =
      message.method === "initialize"
        ? {
            protocolVersion: MCP_PROTOCOL_VERSION,
            serverInfo: { name: "fake-sse", version: "3.0.0" },
            capabilities: { tools: { listChanged: false } },
          }
        : message.method === "tools/list"
          ? toolsPage(message.params?.cursor)
          : {};

    stream.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
    );
  });

  const url = await listen(server);
  return {
    url: `${url}/sse`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        stream?.end();
        server.close(() => resolve());
      }),
  };
}

let running: FakeServer | null = null;

/**
 * A stateless (2026-07-28) Streamable HTTP server. It has no `initialize`,
 * requires the revision in `_meta` and in the header, requires `Mcp-Method` to
 * mirror the body, and refuses any revision it does not serve.
 */
async function startStatelessHttpServer(
  options: { supported?: string[] } = {},
): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const supported = options.supported ?? ["2026-07-28", "2025-11-25"];

  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers as Record<string, string | undefined>,
      body,
    });
    const message = body as { id?: number; method?: string; params?: Record<string, unknown> };
    const meta = message.params?._meta as Record<string, unknown> | undefined;
    const revision = meta?.["io.modelcontextprotocol/protocolVersion"];
    const reply = (status: number, payload: Record<string, unknown>) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, ...payload }));
    };

    if (
      typeof revision !== "string" ||
      request.headers["mcp-protocol-version"] !== revision ||
      request.headers["mcp-method"] !== message.method
    ) {
      reply(400, { error: { code: -32020, message: "Header mismatch" } });
      return;
    }
    if (!supported.includes(revision)) {
      reply(400, {
        error: {
          code: -32022,
          message: "Unsupported protocol version",
          data: { supported, requested: revision },
        },
      });
      return;
    }
    const identity = { "io.modelcontextprotocol/serverInfo": { name: "fake-stateless", version: "4.0.0" } };
    if (message.method === "server/discover") {
      reply(200, {
        result: {
          resultType: "complete",
          supportedVersions: supported,
          capabilities: { tools: {} },
          _meta: identity,
          ttlMs: 60_000,
          cacheScope: "public",
        },
      });
      return;
    }
    if (message.method === "tools/list") {
      reply(200, {
        result: {
          resultType: "complete",
          ...toolsPage(message.params?.cursor),
          _meta: identity,
          ttlMs: 60_000,
          cacheScope: "public",
        },
      });
      return;
    }
    reply(404, { error: { code: -32601, message: "Method not found" } });
  });

  const url = await listen(server);
  return {
    url: `${url}/mcp`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

afterEach(async () => {
  await running?.close();
  running = null;
});

describe("snapshot over stdio", () => {
  it("walks every page of a paginated tools list", async () => {
    const spec = await snapshot({
      transport: { type: "stdio", command: process.execPath, args: [stdioServerPath] },
      timeout: 10_000,
    });

    expect(spec.server).toEqual({ name: "fake-stdio", version: "1.2.3" });
    expect(spec.mcpVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(spec.tools?.map((entry) => entry.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(spec["x-mcp-parser-incomplete"]).toBeUndefined();
  });
});

describe("snapshot over streamable HTTP", () => {
  it("snapshots a configured endpoint and lets generated headers override case-insensitive package fields", async () => {
    running = await startStatefulHttpServer({ pages: 1 });
    const config = createConfig({ api: {
      type: "streamable-http", url: running.url,
      headers: { "mcp-protocol-version": "package-value", "content-type": "text/plain", "mcp-session-id": "package-session", "X-Tenant": "${PLUGIN_ROOT}" },
    } });
    const spec = await snapshotConfig(config, "api", { pluginRoot: "/unused" });
    expect(spec.tools).toHaveLength(1);
    expect(spec.transport).toEqual({ type: "streamable-http", url: running.url });
    for (const entry of running.requests) {
      expect(entry.headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSION);
      expect(entry.headers["content-type"]).toBe("application/json");
      expect(entry.headers["x-tenant"]).toBe("${PLUGIN_ROOT}");
      if ((entry.body as { method?: string })?.method !== "initialize") expect(entry.headers["mcp-session-id"]).toBe("session-abc-123");
    }
  });

  it("requests the pinned protocol revision and identifies this package", async () => {
    running = await startStatefulHttpServer({ pages: 1 });
    const spec = await snapshot({ transport: { type: "streamable-http", url: running.url } });

    const initialize = running.requests.find(
      (entry) => (entry.body as { method?: string })?.method === "initialize",
    );
    const params = (initialize?.body as { params?: Record<string, unknown> })?.params;

    expect(params?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(params?.clientInfo).toEqual({
      name: MCP_PARSER_CLIENT_INFO.name,
      version: MCP_PARSER_CLIENT_INFO.version,
    });
    expect(initialize?.headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSION);
    expect(spec.tools?.map((entry) => entry.name)).toEqual(["only"]);
  });

  it("echoes the session a stateful server mints, and releases it on close", async () => {
    running = await startStatefulHttpServer({ pages: 1 });
    await snapshot({ transport: { type: "streamable-http", url: running.url } });

    const afterInitialize = running.requests.filter(
      (entry) =>
        (entry.body as { method?: string })?.method !== "initialize" &&
        entry.method === "POST",
    );
    expect(afterInitialize.length).toBeGreaterThan(0);
    for (const entry of afterInitialize) {
      expect(entry.headers["mcp-session-id"]).toBe("session-abc-123");
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    const released = running.requests.find((entry) => entry.method === "DELETE");
    expect(released?.headers["mcp-session-id"]).toBe("session-abc-123");
  });

  it("records itself as incomplete when the page limit stops the walk", async () => {
    running = await startStatefulHttpServer();
    const spec = await snapshot({
      transport: { type: "streamable-http", url: running.url },
      pageLimit: 2,
    });

    expect(spec.tools).toHaveLength(2);
    expect(spec["x-mcp-parser-incomplete"]).toEqual({
      pageLimitReached: ["tools"],
      pageLimit: 2,
    });
  });
});

describe("snapshot at a chosen protocol revision", () => {
  it("offers the requested handshake revision in initialize", async () => {
    running = await startStatefulHttpServer({ pages: 1, negotiate: "2025-06-18" });
    const spec = await snapshot({
      transport: { type: "streamable-http", url: running.url },
      protocolVersion: "2025-06-18",
    });

    const initialize = running.requests.find(
      (entry) => (entry.body as { method?: string })?.method === "initialize",
    );
    expect((initialize?.body as { params?: { protocolVersion?: string } }).params?.protocolVersion).toBe(
      "2025-06-18",
    );
    expect(initialize?.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(spec.mcpVersion).toBe("2025-06-18");
  });

  it("declares the negotiated revision on every request after initialize", async () => {
    running = await startStatefulHttpServer({ pages: 1, negotiate: "2025-03-26" });
    const spec = await snapshot({ transport: { type: "streamable-http", url: running.url } });

    const later = running.requests.filter(
      (entry) =>
        entry.method === "POST" && (entry.body as { method?: string })?.method !== "initialize",
    );
    expect(later.length).toBeGreaterThan(0);
    for (const entry of later) expect(entry.headers["mcp-protocol-version"]).toBe("2025-03-26");
    expect(spec.mcpVersion).toBe("2025-03-26");
  });

  it("speaks a stateless revision through server/discover and per-request metadata", async () => {
    running = await startStatelessHttpServer();
    const spec = await snapshot({
      transport: { type: "streamable-http", url: running.url },
      protocolVersion: "2026-07-28",
    });

    const methods = running.requests.map((entry) => (entry.body as { method?: string }).method);
    expect(methods).not.toContain("initialize");
    expect(methods[0]).toBe("server/discover");
    for (const entry of running.requests) {
      const meta = (entry.body as { params?: { _meta?: Record<string, unknown> } }).params?._meta;
      expect(meta?.["io.modelcontextprotocol/clientInfo"]).toEqual({
        name: MCP_PARSER_CLIENT_INFO.name,
        version: MCP_PARSER_CLIENT_INFO.version,
      });
    }
    expect(spec.server).toEqual({ name: "fake-stateless", version: "4.0.0" });
    expect(spec.mcpVersion).toBe("2026-07-28");
    expect(spec.mcpVersions).toEqual(["2026-07-28", "2025-11-25"]);
    expect(spec.tools?.map((entry) => entry.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("reports the revisions a server supports when it refuses the one requested", async () => {
    running = await startStatelessHttpServer({ supported: ["2026-07-28"] });
    await expect(
      snapshot({
        transport: { type: "streamable-http", url: running.url },
        protocolVersion: "2027-01-01",
      }),
    ).rejects.toThrow(/-32022.*supported revisions: 2026-07-28/);
  });

  it("refuses a malformed revision and a stateless revision over HTTP+SSE", async () => {
    await expect(
      snapshot({ transport: { type: "streamable-http", url: "http://127.0.0.1:1/mcp" }, protocolVersion: "latest" }),
    ).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      snapshot({ transport: { type: "sse", url: "http://127.0.0.1:1/sse" }, protocolVersion: "2026-07-28" }),
    ).rejects.toThrow(/HTTP\+SSE predates/);
  });
});

describe("snapshot over legacy SSE", () => {
  it("snapshots a configured legacy server with literal headers and generated protocol fields", async () => {
    running = await startSseServer();
    const config = createConfig({ legacy: { type: "sse", url: running.url, headers: { "MCP-Protocol-Version": "package-value", "X-Tenant": "${PLUGIN_DATA}" } } });
    const spec = await snapshotConfig(config, "legacy", { pluginRoot: "/unused", timeout: 1000 });
    expect(spec.tools).toHaveLength(3);
    for (const entry of running.requests) {
      expect(entry.headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSION);
      expect(entry.headers["x-tenant"]).toBe("${PLUGIN_DATA}");
    }
  });

  it("refuses an SSE endpoint event that changes origins", async () => {
    running = await startSseServer("https://example.org/messages");
    await expect(snapshot({ transport: { type: "sse", url: running.url, headers: { "X-Tenant": "public" } }, timeout: 1000 })).rejects.toThrow(/configured origin/);
    expect(running.requests).toHaveLength(1);
  });

  it("sends the protocol revision on the stream and on posted messages", async () => {
    running = await startSseServer();
    const spec = await snapshot({ transport: { type: "sse", url: running.url }, timeout: 10_000 });

    expect(spec.server).toEqual({ name: "fake-sse", version: "3.0.0" });
    expect(spec.tools?.map((entry) => entry.name)).toEqual(["alpha", "beta", "gamma"]);

    const stream = running.requests.find((entry) => entry.url.startsWith("/sse"));
    const posted = running.requests.filter((entry) => entry.url.startsWith("/messages"));
    expect(stream?.headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSION);
    expect(posted.length).toBeGreaterThan(0);
    for (const entry of posted) {
      expect(entry.headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSION);
    }
  });
});

describe("remote redirects", () => {
  it.each(["streamable-http", "sse"] as const)("does not forward %s headers or messages through redirects", async (type) => {
    let received = 0;
    const destination = createServer((_request, response) => { received++; response.writeHead(500).end(); });
    const target = await listen(destination);
    const origin = createServer((_request, response) => response.writeHead(307, { location: target }).end());
    const url = await listen(origin);
    try {
      await expect(snapshot({ transport: { type, url, headers: { "X-Tenant": "public" } }, timeout: 1000 })).rejects.toThrow();
      expect(received).toBe(0);
    } finally {
      await Promise.all([new Promise<void>((resolve) => origin.close(() => resolve())), new Promise<void>((resolve) => destination.close(() => resolve()))]);
    }
  });
});

describe("public protocol exports", () => {
  it("re-exports the revision helpers the changelog documents", async () => {
    const api = await import("../src/index.js");
    expect(api.MCP_FIRST_STATELESS_REVISION).toBe("2026-07-28");
    expect(api.isProtocolRevision("2025-06-18")).toBe(true);
    expect(api.isProtocolRevision("latest")).toBe(false);
    expect(api.isStatelessRevision("2026-07-28")).toBe(true);
    expect(api.isStatelessRevision("2025-11-25")).toBe(false);
  });
});
