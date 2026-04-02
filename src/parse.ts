/**
 * Parse mcp.json files into typed McpSpec objects.
 */

import { readFile } from "node:fs/promises";
import type { McpSpec } from "mcp-spec";

export interface ParseOptions {
  /** Resolve $ref pointers within tool schemas. Default: true. */
  dereference?: boolean;
}

/**
 * Parse an mcp.json file from disk.
 *
 * @param path - Path to the mcp.json file
 * @param options - Parse options
 * @returns Parsed and optionally dereferenced McpSpec
 *
 * @example
 * ```ts
 * import { parse } from "mcp-parser";
 * const spec = await parse("./mcp.json");
 * console.log(spec.server.name);
 * ```
 */
export async function parse(
  path: string,
  options: ParseOptions = {},
): Promise<McpSpec> {
  const content = await readFile(path, "utf-8");
  return parseString(content, options);
}

/**
 * Parse an mcp.json string into a typed McpSpec.
 *
 * @param content - JSON string
 * @param options - Parse options
 * @returns Parsed McpSpec
 */
export function parseString(
  content: string,
  options: ParseOptions = {},
): McpSpec {
  const raw: unknown = JSON.parse(content);
  if (typeof raw !== "object" || raw === null) {
    throw new McpParseError("Expected a JSON object");
  }

  const spec = raw as Record<string, unknown>;

  if (typeof spec.mcpSpec !== "string") {
    throw new McpParseError('Missing or invalid "mcpSpec" version field');
  }

  if (
    typeof spec.server !== "object" ||
    spec.server === null ||
    typeof (spec.server as Record<string, unknown>).name !== "string" ||
    typeof (spec.server as Record<string, unknown>).version !== "string"
  ) {
    throw new McpParseError(
      'Missing or invalid "server" field (requires name and version)',
    );
  }

  const result = spec as unknown as McpSpec;

  if (options.dereference !== false && result.$defs) {
    return dereferenceSpec(result);
  }

  return result;
}

/**
 * Resolve $ref pointers within tool schemas using the spec's $defs.
 */
function dereferenceSpec(spec: McpSpec): McpSpec {
  if (!spec.$defs || Object.keys(spec.$defs).length === 0) {
    return spec;
  }

  const defs = spec.$defs;

  function resolveRefs(obj: unknown): unknown {
    if (typeof obj !== "object" || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(resolveRefs);

    const record = obj as Record<string, unknown>;

    if (typeof record.$ref === "string") {
      const refPath = record.$ref;
      const match = refPath.match(/^#\/\$defs\/(.+)$/);
      if (match && defs[match[1]]) {
        return resolveRefs(structuredClone(defs[match[1]]));
      }
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      resolved[key] = resolveRefs(value);
    }
    return resolved;
  }

  return resolveRefs(spec) as McpSpec;
}

/** Error thrown when parsing an invalid mcp.json file. */
export class McpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpParseError";
  }
}
