# mcp-parser

[![CI](https://github.com/sourcey/mcp-parser/actions/workflows/ci.yml/badge.svg)](https://github.com/sourcey/mcp-parser/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-parser)](https://www.npmjs.com/package/mcp-parser)
[![license](https://img.shields.io/npm/l/mcp-parser)](https://github.com/sourcey/mcp-parser/blob/main/LICENSE)

Parse, validate, and snapshot [Model Context Protocol](https://modelcontextprotocol.io) servers.

## MCP Protocol Compatibility

Built against the [MCP specification](https://github.com/modelcontextprotocol/specification). Supports all released protocol versions:

| Protocol Version | Status |
|------------------|--------|
| [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25) | Current stable |
| [`2025-06-18`](https://modelcontextprotocol.io/specification/2025-06-18) | Supported |
| [`2025-03-26`](https://modelcontextprotocol.io/specification/2025-03-26) | Supported |
| [`2024-11-05`](https://modelcontextprotocol.io/specification/2024-11-05) | Supported |

All three MCP transports are supported: [stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio), [SSE](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#backwards-compatibility), and [streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http).

## Install

```bash
npm install mcp-parser
```

## Quick Start

```typescript
import { parse, validate, generateLlmsTxt } from "mcp-parser";

const spec = await parse("./mcp.json");

const result = validate(spec);
if (!result.valid) {
  for (const d of result.diagnostics) {
    console.error(`${d.severity}: ${d.path} - ${d.message}`);
  }
}

const llmsTxt = generateLlmsTxt(spec);
```

## What is mcp.json?

A static snapshot of an MCP server's capabilities: its tools, resources, and prompts. Think of it as `openapi.json` for MCP servers.

MCP servers describe themselves at runtime via [`tools/list`](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#listing-tools), [`resources/list`](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#listing-resources), and [`prompts/list`](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#listing-prompts). An `mcp.json` captures that in a versionable file for documentation, validation, and code generation.

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
const spec = parseString('{ "mcpSpec": "0.2.0", ... }');
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

Connect to a running MCP server and capture a static snapshot. Supports all three MCP [transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

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

### `generateLlmsTxt(spec, baseUrl?)`

Generate an [llms.txt](https://llmstxt.org) index file for LLM discovery.

```typescript
const txt = generateLlmsTxt(spec, "https://docs.example.com");
```

### `generateLlmsFullTxt(spec)`

Generate a complete markdown reference for large-context LLMs.

```typescript
const full = generateLlmsFullTxt(spec);
```

### `generateMarkdown(spec)`

Generate a full markdown reference document.

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

# Generate llms.txt
mcp-parser generate ./mcp.json --format llms-txt -o llms.txt

# Generate full reference
mcp-parser generate ./mcp.json --format llms-full-txt -o llms-full.txt
```

## MCP Specification Resources

- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25) (current stable)
- [Specification repo](https://github.com/modelcontextprotocol/specification) (includes JSON Schema for each protocol version)
- [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk`)
- [Python SDK](https://github.com/modelcontextprotocol/python-sdk) (`mcp` on PyPI)

## Related

- [mcp-schema](https://github.com/sourcey/mcp-schema): TypeScript types and JSON Schema for MCP specs
- [sourcey](https://github.com/sourcey/sourcey): generate documentation from MCP specs, OpenAPI, and markdown

## License

MIT
