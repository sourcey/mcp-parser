/** Agent Plugins MCP configuration. The bundled upstream schema owns its shape. */
import { readFile, mkdir, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { isIP } from "node:net";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  agentPluginsMcpSchema,
  AGENT_PLUGINS_MCP_SCHEMA_URL,
} from "mcp-schema";
import type { AgentPluginsMcpConfig, AgentPluginsMcpServer, McpSpec } from "mcp-schema";
import type { ValidationDiagnostic } from "./validate.js";
import { McpParseError } from "./parse.js";
import { snapshot } from "./snapshot.js";
import type { SnapshotOptions, SnapshotTransport } from "./snapshot.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(agentPluginsMcpSchema);
const validateServer = ajv.getSchema(`${AGENT_PLUGINS_MCP_SCHEMA_URL}#/$defs/server`)!;
// Project just the envelope, so one invalid entry does not disable its siblings.
const validateEnvelope = ajv.compile({
  ...agentPluginsMcpSchema,
  $id: undefined,
  properties: {
    ...agentPluginsMcpSchema.properties,
    mcpServers: { ...agentPluginsMcpSchema.properties.mcpServers, additionalProperties: true },
  },
});

export interface ConfigValidationResult {
  valid: boolean;
  topLevelValid: boolean;
  /** Independently valid entries; empty if the envelope is invalid. */
  servers: Record<string, AgentPluginsMcpServer>;
  diagnostics: ValidationDiagnostic[];
}

export interface ConfigValidationOptions {
  /** If provided by a plugin loader, its manifest schema must target the same release. */
  pluginSchema?: string;
}

/** Validate offline; never retrieve a schema or start a server. */
export function validateConfig(value: unknown, options: ConfigValidationOptions = {}): ConfigValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];
  const error = (path: string, message: string) => diagnostics.push({ severity: "error", path, message });
  const servers: Record<string, AgentPluginsMcpServer> = Object.create(null);
  if (!validateEnvelope(value)) {
    for (const issue of validateEnvelope.errors ?? []) error(issue.instancePath, issue.message ?? "Invalid configuration");
    return { valid: false, topLevelValid: false, servers, diagnostics };
  }
  if (options.pluginSchema !== undefined && options.pluginSchema !== AGENT_PLUGINS_MCP_SCHEMA_URL.replace(/mcp\.schema\.json$/, "plugin.schema.json")) {
    error("/$schema", "MCP configuration and plugin manifest must target the same supported Agent Plugins release");
    return { valid: false, topLevelValid: false, servers, diagnostics };
  }
  const config = value as unknown as AgentPluginsMcpConfig;
  for (const [name, server] of Object.entries(config.mcpServers)) {
    const path = `/mcpServers/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (!validateServer(server)) {
      for (const issue of validateServer.errors ?? []) error(path + issue.instancePath, issue.message ?? "Invalid server");
      continue;
    }
    const before = diagnostics.length;
    if (server.type === "stdio") {
      // A relative executable is passed as one token, including spaces in its path.
      const command = server.command;
      if (command.includes("${PLUGIN_ROOT}") || command.includes("${PLUGIN_DATA}") || /[\x00-\x1f\x7f]/.test(command) ||
        (!command.startsWith("./") && (/[\s/\\'"`;|&<>$()]/.test(command) || command === "." || command === ".."))) {
        error(`${path}/command`, "Expected a bare executable token or a plugin-relative ./ path; command placeholders are not supported");
      }
      for (const key of Object.keys(server.env ?? {})) {
        const reserved = process.platform === "win32" ? key.toUpperCase() : key;
        if (reserved === "PLUGIN_ROOT" || reserved === "PLUGIN_DATA") error(`${path}/env`, "PLUGIN_ROOT and PLUGIN_DATA are client-managed");
        if (key.includes("=") || /\0/.test(key) || /\0/.test(server.env![key])) error(`${path}/env`, "Invalid process environment entry");
      }
    } else {
      try {
        const url = new URL(server.url);
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
        if (!/^https?:\/\//i.test(server.url) || /[\s\x00-\x1f\x7f]/.test(server.url) ||
          url.username || url.password || server.url.includes("#") || server.url.slice(server.url.indexOf("://") + 3).split(/[/?]/, 1)[0].includes("@") ||
          (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
          throw new Error();
        }
      } catch {
        error(`${path}/url`, "Expected an absolute HTTPS URL (HTTP is allowed only for loopback), without user information or a fragment");
      }
      const names = new Set<string>();
      for (const [name, value] of Object.entries(server.headers ?? {})) {
        try {
          validateHeaderName(name);
          validateHeaderValue(name, value);
          if (names.has(name.toLowerCase())) throw new Error();
          names.add(name.toLowerCase());
        } catch {
          error(`${path}/headers`, "Invalid HTTP header or duplicate case-insensitive header name");
        }
      }
    }
    if (diagnostics.length === before) servers[name] = server;
  }
  return { valid: diagnostics.length === 0, topLevelValid: true, servers, diagnostics };
}

function requireConfig(value: unknown): AgentPluginsMcpConfig {
  const result = validateConfig(value);
  if (!result.valid) throw new McpParseError(result.diagnostics.map((d) => `${d.path}: ${d.message}`).join("\n"));
  return value as AgentPluginsMcpConfig;
}

export function parseConfigString(content: string): AgentPluginsMcpConfig {
  return requireConfig(JSON.parse(content));
}

export async function parseConfig(path: string): Promise<AgentPluginsMcpConfig> {
  return parseConfigString(await readFile(path, "utf8"));
}

/** Create the standard configuration from authored server entries. */
export function createConfig(servers: Record<string, AgentPluginsMcpServer>): AgentPluginsMcpConfig {
  return requireConfig({ $schema: AGENT_PLUGINS_MCP_SCHEMA_URL, mcpServers: servers });
}

/** Generate a plugin config from a snapshot's explicit connection hints. No fields are inferred. */
export function generateConfig(spec: McpSpec, serverName: string): string {
  if (!serverName) throw new McpParseError("A server name is required for configuration output");
  if (!spec.transport) throw new McpParseError("Snapshot has no transport hints; supply an authored server entry to createConfig");
  const config = requireConfig({ $schema: AGENT_PLUGINS_MCP_SCHEMA_URL, mcpServers: { [serverName]: spec.transport } });
  return JSON.stringify(config, null, 2) + "\n";
}

export interface ConfigPaths {
  /** Existing plugin root; resolved through the filesystem before use. */
  pluginRoot: string;
  /** Caller-owned, per-installed-plugin persistent directory. Required for stdio. */
  pluginData?: string;
}

/** Exact, single-pass expansion. Unknown placeholders and replacement text remain literal. */
function expand(value: string, root: string, data: string): string {
  return value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_, name: string) => name === "ROOT" ? root : data);
}

async function contained(root: string, path: string): Promise<string> {
  const actual = await realpath(path);
  const rel = relative(root, actual);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new McpParseError("Configured path escapes its filesystem-resolved root");
  return actual;
}

/** Resolve one valid entry; invalid siblings remain isolated and are available in validateConfig diagnostics. */
export async function resolveConfigServer(value: unknown, name: string, paths: ConfigPaths): Promise<SnapshotTransport> {
  const result = validateConfig(value);
  const server = result.servers[name];
  if (!server) {
    throw new McpParseError(`Unavailable MCP server ${JSON.stringify(name)}: ${result.diagnostics.map((d) => `${d.path}: ${d.message}`).join("; ") || "entry not found"}`);
  }
  if (server.type !== "stdio") return { ...server };
  if (!paths.pluginData) throw new McpParseError("stdio configuration requires a dedicated pluginData directory");
  const root = await realpath(paths.pluginRoot);
  await mkdir(resolve(paths.pluginData), { recursive: true });
  const data = await realpath(paths.pluginData);
  const command = server.command.startsWith("./") ? await contained(root, resolve(root, server.command)) : server.command;
  let cwd = root;
  if (server.cwd !== undefined) {
    const dataRooted = server.cwd === "${PLUGIN_DATA}" || server.cwd.startsWith("${PLUGIN_DATA}/");
    cwd = await contained(dataRooted ? data : root, resolve(root, expand(server.cwd, root, data)));
  }
  const env = Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, expand(value, root, data)]));
  return {
    type: "stdio", command, cwd,
    ...(server.args && { args: server.args.map((value) => expand(value, root, data)) }),
    env: { ...env, PLUGIN_ROOT: root, PLUGIN_DATA: data },
  };
}

/** Snapshot one configured server using the existing MCP transport implementation. */
export async function snapshotConfig(
  config: unknown, serverName: string, options: ConfigPaths & Omit<SnapshotOptions, "transport">,
): Promise<McpSpec> {
  const transport = await resolveConfigServer(config, serverName, options);
  const spec = await snapshot({ ...options, transport });
  // Keep portable authored paths, never resolved local paths, environment or credentials.
  const server = (config as AgentPluginsMcpConfig).mcpServers[serverName];
  spec.transport = server.type === "stdio"
    ? { type: server.type, command: server.command, ...(server.args && { args: server.args }), ...(server.cwd && { cwd: server.cwd }) }
    : { type: server.type, url: server.url };
  return spec;
}
