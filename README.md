# mcp-parser

[![CI](https://github.com/sourcey/mcp-parser/actions/workflows/ci.yml/badge.svg)](https://github.com/sourcey/mcp-parser/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-parser)](https://www.npmjs.com/package/mcp-parser)
[![license](https://img.shields.io/npm/l/mcp-parser)](https://github.com/sourcey/mcp-parser/blob/main/LICENSE)

Snapshot, parse, validate, and document [Model Context Protocol](https://modelcontextprotocol.io) servers.

## MCP Protocol Compatibility

`snapshot` requests protocol revision [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25) by default. Pass `protocolVersion` (or `--protocol-version`) to request another:

- A handshake revision (`2025-11-25` and earlier) is offered in `initialize`. Later requests declare the revision the server negotiates in the `MCP-Protocol-Version` header, and the snapshot records it as `mcpVersion`.
- A stateless revision ([`2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28) and later) is declared on every request in `_meta` and in headers, including `Mcp-Method` and `Mcp-Name`. The snapshot reads `server/discover` instead of `initialize` and records the server's supported revisions as `mcpVersions`.

Snapshotting a server at each revision it claims to serve is a conformance check: a server that refuses a revision reports the ones it supports in the error.

Parsing, validation, and generation are revision-independent: they read an `mcp.json` document, whatever revision produced it.

Transports:

| Transport | Support |
|-----------|---------|
| [stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio) | Full |
| [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http) | Full, including server-minted sessions (`Mcp-Session-Id`) |
| [HTTP+SSE](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#backwards-compatibility) | Full. Deprecated by the specification; prefer Streamable HTTP |

Paginated `tools/list`, `resources/list`, `resources/templates/list`, and `prompts/list` results are followed to the last page. A snapshot stopped early by the page bound records `x-mcp-parser-incomplete` rather than presenting a partial list as complete.

Not implemented: `tools/call`, `resources/read`, `prompts/get`, completions, and the client features the specification deprecated in `2026-07-28` (roots, sampling, logging). This package describes a server's surface; it does not exercise it.

## Install

```bash
npm install mcp-parser
```

## Quick Start

```typescript
import { snapshot, validate, generateMarkdown } from "mcp-parser";
import { writeFile } from "node:fs/promises";

const spec = await snapshot({
  transport: { type: "stdio", command: "node", args: ["server.js"] },
});

const result = validate(spec);
if (!result.valid) {
  for (const d of result.diagnostics) {
    console.error(`${d.severity}: ${d.path} - ${d.message}`);
  }
}

await writeFile("mcp.json", JSON.stringify(spec, null, 2));
await writeFile("mcp.md", generateMarkdown(spec));
```

## What is mcp.json?

A static snapshot of an MCP server's capabilities: its tools, resources, and prompts. Think of it as `openapi.json` for MCP servers.

MCP servers describe themselves at runtime via [`tools/list`](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#listing-tools), [`resources/list`](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#listing-resources), and [`prompts/list`](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#listing-prompts). An `mcp.json` captures that live surface in a versionable file for documentation, validation, diffing, and tooling that should not need a running server.

See [mcp-schema](https://github.com/sourcey/mcp-schema) for the full type definitions and JSON Schema.

## API

### `parse(path, options?)`

Parse an `mcp.json` file into a typed `McpSpec` object.

```typescript
const spec = await parse("./mcp.json");
console.log(spec.server.name);   // "my-server"
console.log(spec.tools?.length); // 5
```

Options:

- `dereference` (default: `true`). Resolves `$ref` pointers using the spec's `$defs`.

### `parseString(content, options?)`

Parse a JSON string directly.

```typescript
const spec = parseString('{ "mcpSpec": "0.3.1", ... }');
```

### `validate(spec)`

Validate an `McpSpec` for correctness and best practices.

```typescript
const result = validate(spec);
// result.valid: boolean (true if no errors)
// result.diagnostics: array of { severity, path, message }
```

Checks for:

- Required fields (mcpSpec, server, tool names, inputSchema)
- Duplicate tool/resource/prompt names
- Missing descriptions (warnings)
- Invalid inputSchema types

### `snapshot(options)`

Connect to a running MCP server and capture a static snapshot over any of the three MCP [transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

```typescript
import { snapshot } from "mcp-parser";
import { writeFile } from "node:fs/promises";

// stdio
const spec = await snapshot({
  transport: { type: "stdio", command: "node", args: ["server.js"] },
});

// SSE
const spec = await snapshot({
  transport: { type: "sse", url: "http://localhost:3000/sse" },
});

// Streamable HTTP
const spec = await snapshot({
  transport: { type: "streamable-http", url: "http://localhost:3000/mcp" },
});

await writeFile("mcp.json", JSON.stringify(spec, null, 2));
```

All transports support an optional `timeout` (default: 30s). SSE and HTTP transports accept a `headers` object for authentication.

### `generateMarkdown(spec)`

Generate a full markdown reference document.

### `generateLlmsTxt(spec, baseUrl?)`

Generate a compact [llms.txt](https://llmstxt.org)-style index. This is a compatibility export for tools and docs sites that already consume the convention, not a guarantee that model providers will discover or fetch it automatically.

```typescript
const txt = generateLlmsTxt(spec, "https://docs.example.com");
```

### `generateLlmsFullTxt(spec)`

Generate a complete markdown reference with the server context inline.

```typescript
const full = generateLlmsFullTxt(spec);
```

## CLI

```bash
# Parse and pretty-print
mcp-parser parse ./mcp.json

# Validate
mcp-parser validate ./mcp.json

# Snapshot via stdio
mcp-parser snapshot --stdio "node server.js" -o mcp.json

# Snapshot via SSE
mcp-parser snapshot --sse http://localhost:3000/sse -o mcp.json

# Snapshot via streamable HTTP
mcp-parser snapshot --http http://localhost:3000/mcp -o mcp.json

# With auth headers
mcp-parser snapshot --sse http://localhost:3000/sse --header "Authorization:Bearer tok" -o mcp.json

# Generate markdown reference (default)
mcp-parser generate ./mcp.json -o mcp.md

# Generate compact context index
mcp-parser generate ./mcp.json --format llms-txt -o llms.txt

# Generate full context reference
mcp-parser generate ./mcp.json --format llms-full-txt -o llms-full.txt
```

## MCP Specification Resources

- [MCP Specification](https://modelcontextprotocol.io/specification/2026-07-28) (current revision)
- [MCP Specification `2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25) (the revision this client requests)
- [Specification repo](https://github.com/modelcontextprotocol/specification) (includes JSON Schema for each protocol version)
- [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk`)
- [Python SDK](https://github.com/modelcontextprotocol/python-sdk) (`mcp` on PyPI)

## Related

- [mcp-schema](https://github.com/sourcey/mcp-schema): TypeScript types and JSON Schema for MCP specs
- [sourcey](https://github.com/sourcey/sourcey): generate documentation from MCP specs, OpenAPI, and markdown

## License

MIT
