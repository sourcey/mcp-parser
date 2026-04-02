# mcp-parser

Parse, validate, and snapshot [Model Context Protocol](https://modelcontextprotocol.io) servers.

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

MCP servers describe themselves at runtime via introspection (`tools/list`, `resources/list`, `prompts/list`). An `mcp.json` captures that in a versionable file for documentation, validation, and code generation.

See [mcp-schema](https://github.com/sourcey/mcp-schema) for the type definitions and JSON Schema.

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
const spec = parseString('{ "mcpSpec": "0.1.0", ... }');
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

Connect to a running MCP server and capture a static snapshot. Supports all three MCP transports.

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

## Related

- [mcp-schema](https://github.com/sourcey/mcp-schema): TypeScript types and JSON Schema for MCP specs
- [sourcey](https://github.com/sourcey/sourcey): generate documentation from MCP specs, OpenAPI, and markdown

## License

MIT
