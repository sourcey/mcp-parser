/**
 * Validate MCP spec documents against the schema.
 */

import type { McpSpec, McpTool, McpResource, McpResourceTemplate, McpPrompt } from "mcp-schema";

/** A single validation diagnostic. */
export interface ValidationDiagnostic {
  /** Severity of the issue. */
  severity: "error" | "warning";
  /** JSON path to the problematic field (e.g., "tools[0].inputSchema"). */
  path: string;
  /** Human-readable description of the issue. */
  message: string;
}

/** Result of validating an MCP spec. */
export interface ValidationResult {
  /** Whether the spec is valid (no errors, warnings are OK). */
  valid: boolean;
  /** All diagnostics found. */
  diagnostics: ValidationDiagnostic[];
}

/**
 * Validate an McpSpec document.
 *
 * Checks structural correctness, required fields, and best practices.
 * Returns warnings for missing descriptions and other quality issues.
 *
 * @example
 * ```ts
 * import { parse, validate } from "mcp-parser";
 *
 * const spec = await parse("./mcp.json");
 * const result = validate(spec);
 *
 * if (!result.valid) {
 *   for (const d of result.diagnostics) {
 *     console.error(`${d.severity}: ${d.path} — ${d.message}`);
 *   }
 * }
 * ```
 */
export function validate(spec: McpSpec): ValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];

  // Root fields
  if (!spec.mcpSpec) {
    diagnostics.push({
      severity: "error",
      path: "mcpSpec",
      message: "Missing mcpSpec version",
    });
  }

  if (!spec.server?.name) {
    diagnostics.push({
      severity: "error",
      path: "server.name",
      message: "Missing server name",
    });
  }

  if (!spec.server?.version) {
    diagnostics.push({
      severity: "error",
      path: "server.version",
      message: "Missing server version",
    });
  }

  if (!spec.description) {
    diagnostics.push({
      severity: "warning",
      path: "description",
      message: "Missing server description — recommended for documentation",
    });
  }

  const hasContent =
    (spec.tools && spec.tools.length > 0) ||
    (spec.resources && spec.resources.length > 0) ||
    (spec.resourceTemplates && spec.resourceTemplates.length > 0) ||
    (spec.prompts && spec.prompts.length > 0);

  if (!hasContent) {
    diagnostics.push({
      severity: "warning",
      path: "",
      message: "Spec has no tools, resources, or prompts",
    });
  }

  // Validate tools
  if (spec.tools) {
    const toolNames = new Set<string>();
    for (let i = 0; i < spec.tools.length; i++) {
      const tool = spec.tools[i];
      const path = `tools[${i}]`;
      validateTool(tool, path, toolNames, diagnostics);
    }
  }

  // Validate resources
  if (spec.resources) {
    const uris = new Set<string>();
    for (let i = 0; i < spec.resources.length; i++) {
      const resource = spec.resources[i];
      const path = `resources[${i}]`;
      validateResource(resource, path, uris, diagnostics);
    }
  }

  // Validate resource templates
  if (spec.resourceTemplates) {
    const templateUris = new Set<string>();
    for (let i = 0; i < spec.resourceTemplates.length; i++) {
      const template = spec.resourceTemplates[i];
      const path = `resourceTemplates[${i}]`;
      validateResourceTemplate(template, path, templateUris, diagnostics);
    }
  }

  // Validate prompts
  if (spec.prompts) {
    const promptNames = new Set<string>();
    for (let i = 0; i < spec.prompts.length; i++) {
      const prompt = spec.prompts[i];
      const path = `prompts[${i}]`;
      validatePrompt(prompt, path, promptNames, diagnostics);
    }
  }

  return {
    valid: !diagnostics.some((d) => d.severity === "error"),
    diagnostics,
  };
}

function validateTool(
  tool: McpTool,
  path: string,
  names: Set<string>,
  diagnostics: ValidationDiagnostic[],
): void {
  if (!tool.name) {
    diagnostics.push({
      severity: "error",
      path: `${path}.name`,
      message: "Tool is missing a name",
    });
  } else if (names.has(tool.name)) {
    diagnostics.push({
      severity: "error",
      path: `${path}.name`,
      message: `Duplicate tool name: "${tool.name}"`,
    });
  } else {
    names.add(tool.name);
  }

  if (!tool.description) {
    diagnostics.push({
      severity: "warning",
      path: `${path}.description`,
      message: `Tool "${tool.name}" has no description`,
    });
  }

  if (!tool.inputSchema) {
    diagnostics.push({
      severity: "error",
      path: `${path}.inputSchema`,
      message: `Tool "${tool.name}" is missing inputSchema`,
    });
  } else if (tool.inputSchema.type !== "object") {
    diagnostics.push({
      severity: "error",
      path: `${path}.inputSchema.type`,
      message: `Tool "${tool.name}" inputSchema type must be "object"`,
    });
  } else if (tool.inputSchema.required && tool.inputSchema.properties) {
    // Check required fields reference existing properties
    for (const req of tool.inputSchema.required) {
      if (!(req in tool.inputSchema.properties)) {
        diagnostics.push({
          severity: "error",
          path: `${path}.inputSchema.required`,
          message: `Tool "${tool.name}" requires "${req}" but it is not defined in properties`,
        });
      }
    }
  }

  // Validate outputSchema if present
  if (tool.outputSchema && tool.outputSchema.type && tool.outputSchema.type !== "object") {
    diagnostics.push({
      severity: "warning",
      path: `${path}.outputSchema.type`,
      message: `Tool "${tool.name}" outputSchema type is "${tool.outputSchema.type}", expected "object"`,
    });
  }

  // Warn on tool name conventions
  if (tool.name && /[A-Z]/.test(tool.name)) {
    diagnostics.push({
      severity: "warning",
      path: `${path}.name`,
      message: `Tool "${tool.name}" uses uppercase characters — lowercase with underscores is conventional`,
    });
  }

  if (tool.name && /\s/.test(tool.name)) {
    diagnostics.push({
      severity: "error",
      path: `${path}.name`,
      message: `Tool "${tool.name}" contains whitespace`,
    });
  }
}

function validateResource(
  resource: McpResource,
  path: string,
  uris: Set<string>,
  diagnostics: ValidationDiagnostic[],
): void {
  if (!resource.uri) {
    diagnostics.push({
      severity: "error",
      path: `${path}.uri`,
      message: "Resource is missing a URI",
    });
  } else if (uris.has(resource.uri)) {
    diagnostics.push({
      severity: "error",
      path: `${path}.uri`,
      message: `Duplicate resource URI: "${resource.uri}"`,
    });
  } else {
    uris.add(resource.uri);
  }

  // Validate URI has a scheme
  if (resource.uri && !/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(resource.uri)) {
    diagnostics.push({
      severity: "warning",
      path: `${path}.uri`,
      message: `Resource URI "${resource.uri}" has no scheme (e.g., "file://", "https://")`,
    });
  }

  if (!resource.name) {
    diagnostics.push({
      severity: "error",
      path: `${path}.name`,
      message: "Resource is missing a name",
    });
  }

  if (!resource.description) {
    diagnostics.push({
      severity: "warning",
      path: `${path}.description`,
      message: `Resource "${resource.name}" has no description`,
    });
  }
}

function validatePrompt(
  prompt: McpPrompt,
  path: string,
  names: Set<string>,
  diagnostics: ValidationDiagnostic[],
): void {
  if (!prompt.name) {
    diagnostics.push({
      severity: "error",
      path: `${path}.name`,
      message: "Prompt is missing a name",
    });
  } else if (names.has(prompt.name)) {
    diagnostics.push({
      severity: "error",
      path: `${path}.name`,
      message: `Duplicate prompt name: "${prompt.name}"`,
    });
  } else {
    names.add(prompt.name);
  }

  if (!prompt.description) {
    diagnostics.push({
      severity: "warning",
      path: `${path}.description`,
      message: `Prompt "${prompt.name}" has no description`,
    });
  }

  if (prompt.arguments) {
    const argNames = new Set<string>();
    for (let j = 0; j < prompt.arguments.length; j++) {
      const arg = prompt.arguments[j];
      if (!arg.name) {
        diagnostics.push({
          severity: "error",
          path: `${path}.arguments[${j}].name`,
          message: "Prompt argument is missing a name",
        });
      } else if (argNames.has(arg.name)) {
        diagnostics.push({
          severity: "error",
          path: `${path}.arguments[${j}].name`,
          message: `Duplicate argument name: "${arg.name}"`,
        });
      } else {
        argNames.add(arg.name);
      }

      if (arg.name && !arg.description) {
        diagnostics.push({
          severity: "warning",
          path: `${path}.arguments[${j}].description`,
          message: `Prompt argument "${arg.name}" has no description`,
        });
      }
    }
  }
}

function validateResourceTemplate(
  template: McpResourceTemplate,
  path: string,
  uris: Set<string>,
  diagnostics: ValidationDiagnostic[],
): void {
  if (!template.uriTemplate) {
    diagnostics.push({
      severity: "error",
      path: `${path}.uriTemplate`,
      message: "Resource template is missing a uriTemplate",
    });
  } else {
    if (uris.has(template.uriTemplate)) {
      diagnostics.push({
        severity: "error",
        path: `${path}.uriTemplate`,
        message: `Duplicate resource template URI: "${template.uriTemplate}"`,
      });
    } else {
      uris.add(template.uriTemplate);
    }

    // URI templates should contain at least one {variable}
    if (!/\{[^}]+\}/.test(template.uriTemplate)) {
      diagnostics.push({
        severity: "warning",
        path: `${path}.uriTemplate`,
        message: `Resource template "${template.uriTemplate}" has no template variables — use a resource instead`,
      });
    }
  }

  if (!template.name) {
    diagnostics.push({
      severity: "error",
      path: `${path}.name`,
      message: "Resource template is missing a name",
    });
  }

  if (!template.description) {
    diagnostics.push({
      severity: "warning",
      path: `${path}.description`,
      message: `Resource template "${template.name}" has no description`,
    });
  }
}
