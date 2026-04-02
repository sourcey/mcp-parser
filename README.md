# mcp-parser

Parse, validate, and snapshot [Model Context Protocol](https://modelcontextprotocol.io) servers.

## Install

```bash
npm install mcp-parser
```

## Quick Start

```typescript
import { parse, validate, generateLlmsTxt } from "mcp-parser";

// Parse an mcp.json file
const spec = await parse("./mcp.json");

// Validate it
const result = validate(spec);
if (!result.valid) {
  for (const d of result.diagnostics) {
    console.error(`${d.severity}: ${d.path} — ${d.message}`);
  }
}

// Generate llms.txt for AI agent discovery
const llmsTxt = generateLlmsTxt(spec);
```

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
// result.valid — boolean (true if no errors)
// result.diagnostics — array of { severity, path, message }
```

Checks for:
- Required fields (mcpSpec, server, tool names, inputSchema)
- Duplicate tool/resource/prompt names
- Missing descriptions (warnings)
- Invalid inputSchema types

### `snapshot(options)`

Connect to a running MCP server and capture a static snapshot.

```typescript
import { snapshot } from "mcp-parser";

const spec = await snapshot({
  transport: {
    type: "stdio",
    command: "node",
    args: ["my-mcp-server.js"],
  },
  timeout: 30_000,
});

// Write the snapshot to disk
import { writeFile } from "node:fs/promises";
await writeFile("mcp.json", JSON.stringify(spec, null, 2));
```

Supported transports:

- `stdio`: spawn a process and communicate via stdin/stdout
- `sse`: connect to an SSE endpoint (coming soon)

### `generateLlmsTxt(spec, baseUrl?)`

Generate an [llms.txt](https://llmstxt.org) index file for LLM discovery.

```typescript
const txt = generateLlmsTxt(spec, "https://docs.example.com");
```

### `generateLlmsFullTxt(spec)`

Generate a complete markdown reference (llms-full.txt) for large-context LLMs.

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

# Snapshot a running server
mcp-parser snapshot --stdio "node server.js" -o mcp.json

# Generate llms.txt
mcp-parser generate ./mcp.json --format llms-txt -o llms.txt

# Generate full reference
mcp-parser generate ./mcp.json --format llms-full-txt -o llms-full.txt
```

## What is mcp.json?

An `mcp.json` file is a static snapshot of an MCP server's capabilities: its tools, resources, and prompts. Think of it as `openapi.json` for MCP servers.

MCP servers describe themselves at runtime via introspection (`tools/list`, `resources/list`, `prompts/list`). An `mcp.json` captures that in a versionable file for documentation, validation, and code generation.

See [mcp-spec](https://github.com/sourcey/mcp-spec) for the full type definitions and JSON Schema.

## Related

- [mcp-spec](https://github.com/sourcey/mcp-spec): TypeScript types and JSON Schema for MCP specs
- [sourcey](https://github.com/sourcey/sourcey): generate documentation from MCP specs, OpenAPI, and markdown

## License

MIT
