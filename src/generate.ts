/**
 * Generate documentation-oriented output from an McpSpec.
 */

import type {
  McpSpec,
  McpTool,
  McpResource,
  McpResourceTemplate,
  McpPrompt,
  JsonSchema,
} from "mcp-schema";

// ---------------------------------------------------------------------------
// llms.txt
// ---------------------------------------------------------------------------

/**
 * Generate an llms.txt file from a McpSpec.
 *
 * The llms.txt format is a concise markdown index of a project's
 * documentation. It is useful as a compatibility export for tools and
 * documentation sites that already consume the convention.
 *
 * @param spec - The MCP spec to generate from
 * @param baseUrl - Optional base URL for linking to hosted docs
 *
 * @example
 * ```ts
 * import { parse, generateLlmsTxt } from "mcp-parser";
 *
 * const spec = await parse("./mcp.json");
 * const txt = generateLlmsTxt(spec);
 * await writeFile("llms.txt", txt);
 * ```
 */
export function generateLlmsTxt(spec: McpSpec, baseUrl?: string): string {
  const lines: string[] = [];
  const base = baseUrl?.replace(/\/$/, "") ?? "";

  lines.push(`# ${spec.server.name}`);
  lines.push("");

  if (spec.description) {
    lines.push(`> ${spec.description.split("\n")[0]}`);
    lines.push("");
  }

  if (spec.tools?.length) {
    lines.push("## Tools");
    lines.push("");
    for (const tool of spec.tools) {
      const slug = slugify(tool.name);
      const link = base ? `${base}/tools/${slug}.html` : "";
      const desc = tool.description ? `: ${tool.description}` : "";
      lines.push(
        link
          ? `- [${tool.name}](${link})${desc}`
          : `- ${tool.name}${desc}`,
      );
    }
    lines.push("");
  }

  if (spec.resources?.length) {
    lines.push("## Resources");
    lines.push("");
    for (const resource of spec.resources) {
      const desc = resource.description ? `: ${resource.description}` : "";
      lines.push(`- ${resource.name} (\`${resource.uri}\`)${desc}`);
    }
    lines.push("");
  }

  if (spec.resourceTemplates?.length) {
    lines.push("## Resource Templates");
    lines.push("");
    for (const template of spec.resourceTemplates) {
      const desc = template.description ? `: ${template.description}` : "";
      lines.push(`- ${template.name} (\`${template.uriTemplate}\`)${desc}`);
    }
    lines.push("");
  }

  if (spec.prompts?.length) {
    lines.push("## Prompts");
    lines.push("");
    for (const prompt of spec.prompts) {
      const desc = prompt.description ? `: ${prompt.description}` : "";
      lines.push(`- ${prompt.name}${desc}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// llms-full.txt
// ---------------------------------------------------------------------------

/**
 * Generate an llms-full.txt file as complete markdown documentation.
 *
 * This is the full reference with all server context inline.
 *
 * @param spec - The MCP spec to generate from
 */
export function generateLlmsFullTxt(spec: McpSpec): string {
  const lines: string[] = [];

  lines.push(`# ${spec.server.name}`);
  if (spec.server.version) {
    lines.push(`Version: ${spec.server.version}`);
  }
  lines.push("");

  if (spec.description) {
    lines.push(spec.description);
    lines.push("");
  }

  if (spec.tools?.length) {
    lines.push("## Tools");
    lines.push("");
    for (const tool of spec.tools) {
      lines.push(...formatTool(tool));
    }
  }

  if (spec.resources?.length) {
    lines.push("## Resources");
    lines.push("");
    for (const resource of spec.resources) {
      lines.push(...formatResource(resource));
    }
  }

  if (spec.resourceTemplates?.length) {
    lines.push("## Resource Templates");
    lines.push("");
    for (const template of spec.resourceTemplates) {
      lines.push(...formatResourceTemplate(template));
    }
  }

  if (spec.prompts?.length) {
    lines.push("## Prompts");
    lines.push("");
    for (const prompt of spec.prompts) {
      lines.push(...formatPrompt(prompt));
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown reference
// ---------------------------------------------------------------------------

/**
 * Generate a complete markdown reference document.
 *
 * @param spec - The MCP spec to generate from
 */
export function generateMarkdown(spec: McpSpec): string {
  // Alias for the full markdown reference.
  return generateLlmsFullTxt(spec);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatTool(tool: McpTool): string[] {
  const lines: string[] = [];
  lines.push(`### ${tool.name}`);
  lines.push("");

  if (tool.description) {
    lines.push(tool.description);
    lines.push("");
  }

  if (tool.annotations) {
    const badges: string[] = [];
    if (tool.annotations.readOnlyHint) badges.push("read-only");
    if (tool.annotations.destructiveHint) badges.push("destructive");
    if (tool.annotations.idempotentHint) badges.push("idempotent");
    if (tool.annotations.openWorldHint) badges.push("open-world");
    if (badges.length) {
      lines.push(badges.map((b) => `\`${b}\``).join(" "));
      lines.push("");
    }
  }

  if (tool.inputSchema?.properties) {
    lines.push("**Parameters:**");
    lines.push("");
    lines.push("| Name | Type | Required | Description |");
    lines.push("|------|------|----------|-------------|");
    const required = new Set(tool.inputSchema.required ?? []);
    for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
      const type = formatType(schema);
      const req = required.has(name) ? "yes" : "no";
      const desc = (schema as Record<string, unknown>).description ?? "";
      lines.push(`| \`${name}\` | ${type} | ${req} | ${desc} |`);
    }
    lines.push("");
  }

  if (tool.outputSchema) {
    lines.push("**Returns:**");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(tool.outputSchema, null, 2));
    lines.push("```");
    lines.push("");
  }

  return lines;
}

function formatResource(resource: McpResource): string[] {
  const lines: string[] = [];
  lines.push(`### ${resource.name}`);
  lines.push("");
  lines.push(`URI: \`${resource.uri}\``);
  if (resource.mimeType) lines.push(`Type: \`${resource.mimeType}\``);
  lines.push("");
  if (resource.description) {
    lines.push(resource.description);
    lines.push("");
  }
  return lines;
}

function formatResourceTemplate(template: McpResourceTemplate): string[] {
  const lines: string[] = [];
  lines.push(`### ${template.name}`);
  lines.push("");
  lines.push(`URI Template: \`${template.uriTemplate}\``);
  if (template.mimeType) lines.push(`Type: \`${template.mimeType}\``);
  lines.push("");
  if (template.description) {
    lines.push(template.description);
    lines.push("");
  }
  return lines;
}

function formatPrompt(prompt: McpPrompt): string[] {
  const lines: string[] = [];
  lines.push(`### ${prompt.name}`);
  lines.push("");

  if (prompt.description) {
    lines.push(prompt.description);
    lines.push("");
  }

  if (prompt.arguments?.length) {
    lines.push("**Arguments:**");
    lines.push("");
    lines.push("| Name | Required | Description |");
    lines.push("|------|----------|-------------|");
    for (const arg of prompt.arguments) {
      const req = arg.required ? "yes" : "no";
      const desc = arg.description ?? "";
      lines.push(`| \`${arg.name}\` | ${req} | ${desc} |`);
    }
    lines.push("");
  }

  return lines;
}

function formatType(schema: JsonSchema): string {
  if (typeof schema.type === "string") return `\`${schema.type}\``;
  if (Array.isArray(schema.type))
    return schema.type.map((t: string) => `\`${t}\``).join(" \\| ");
  if (schema.$ref) return `\`${schema.$ref.split("/").pop()}\``;
  return "`any`";
}

function slugify(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}
