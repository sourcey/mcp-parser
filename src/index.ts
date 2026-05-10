/**
 * mcp-parser: snapshot, parse, validate, and document Model Context Protocol servers.
 *
 * Static contract tooling for MCP server surfaces.
 *
 * @example
 * ```ts
 * import { parse, validate, generateMarkdown } from "mcp-parser";
 *
 * const spec = await parse("./mcp.json");
 * const result = validate(spec);
 *
 * if (result.valid) {
 *   const markdown = generateMarkdown(spec);
 *   console.log(markdown);
 * }
 * ```
 *
 * @packageDocumentation
 */

// Re-export all types from mcp-schema for convenience
export type {
  McpSpec,
  McpTool,
  ToolAnnotations,
  McpResource,
  McpResourceTemplate,
  ResourceAnnotations,
  McpPrompt,
  McpPromptArgument,
  McpServerInfo,
  McpCapabilities,
  McpTransport,
  JsonSchema,
} from "mcp-schema";

export { MCP_SPEC_VERSION, mcpSpecSchema } from "mcp-schema";

// Parser
export { parse, parseString, McpParseError } from "./parse.js";
export type { ParseOptions } from "./parse.js";

// Validator
export { validate } from "./validate.js";
export type { ValidationResult, ValidationDiagnostic } from "./validate.js";

// Snapshot
export { snapshot, McpSnapshotError } from "./snapshot.js";
export type {
  SnapshotOptions,
  SnapshotTransport,
  StdioTransport,
  SseTransport,
  StreamableHttpTransport,
} from "./snapshot.js";

// Generators
export {
  generateLlmsTxt,
  generateLlmsFullTxt,
  generateMarkdown,
} from "./generate.js";
