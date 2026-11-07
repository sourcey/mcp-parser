import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AGENT_PLUGINS_MCP_SCHEMA_URL, createConfig, generateConfig, parseConfigString,
  parseString, resolveConfigServer, snapshotConfig, validateConfig,
} from "../src/index.js";

const run = promisify(execFile);
const config = (mcpServers: Record<string, unknown> = {}) => ({ $schema: AGENT_PLUGINS_MCP_SCHEMA_URL, mcpServers });
let temporary: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (temporary) await rm(temporary, { recursive: true, force: true }); temporary = undefined; });

async function paths() {
  temporary = await mkdtemp(join(tmpdir(), "mcp-config-${PLUGIN_DATA}-"));
  const pluginRoot = join(temporary, "plugin");
  const pluginData = join(temporary, "data");
  await mkdir(pluginRoot);
  return { pluginRoot: await realpath(pluginRoot), pluginData };
}

describe("Agent Plugins configuration", () => {
  it("parses the current official shape and keeps snapshot parsing unambiguous", () => {
    const document = config({ api: { type: "streamable-http", url: "https://example.com/mcp" } });
    expect(parseConfigString(JSON.stringify(document))).toEqual(document);
    expect(() => parseString(JSON.stringify(document))).toThrow(/parseConfig/);
    expect(() => parseConfigString('{"mcpSpec":"0.3.2","server":{"name":"test","version":"fixture"}}')).toThrow();
  });

  it("disables MCP for an invalid envelope, and isolates invalid entries otherwise", () => {
    const document = config({ good: { type: "stdio", command: "node" }, bad: { type: "http", url: "https://example.com" } });
    const result = validateConfig(document);
    expect(result).toMatchObject({ valid: false, topLevelValid: true });
    expect(Object.keys(result.servers)).toEqual(["good"]);
    for (const invalid of [null, [], { mcpServers: {} }, { ...document, $schema: "urn:unsupported-test-schema" }, { ...document, tools: [] }, { ...document, mcpServers: [] }]) {
      expect(validateConfig(invalid)).toMatchObject({ valid: false, topLevelValid: false, servers: {} });
    }
    expect(validateConfig(config())).toMatchObject({ valid: true, topLevelValid: true });
    expect(validateConfig(document, { pluginSchema: "urn:unsupported-test-manifest" }).topLevelValid).toBe(false);
    expect(validateConfig(config(), { pluginSchema: AGENT_PLUGINS_MCP_SCHEMA_URL.replace("mcp.schema", "plugin.schema") }).valid).toBe(true);
  });

  it.each([
    { type: "stdio", command: "node server.js" },
    { type: "stdio", command: "/usr/bin/node" },
    { type: "stdio", command: "../bin/server" },
    { type: "stdio", command: "${PLUGIN_ROOT}/server" },
    { type: "stdio", command: "node", cwd: "data" },
    { type: "stdio", command: "node", env: { PLUGIN_ROOT: "override" } },
    { type: "stdio", command: "node", env: { "BAD=NAME": "x" } },
    { type: "stdio", command: "node", url: "https://example.com" },
    { type: "streamable-http", url: "http://example.com/mcp" },
    { type: "streamable-http", url: "https://user:pass@example.com" },
    { type: "streamable-http", url: "https://@example.com" },
    { type: "streamable-http", url: "https://example.com/#" },
    { type: "streamable-http", url: "https://example.com/\npath" },
    { type: "streamable-http", url: "file:///tmp/mcp" },
    { type: "streamable-http", url: "https://example.com", headers: { "X-Tenant": "a", "x-tenant": "b" } },
    { type: "sse", url: "https://example.com", headers: { "Bad Name": "a" } },
    { type: "sse", url: "https://example.com", headers: { X: "a\r\nInjected: true" } },
  ])("rejects a nonconformant server: %j", (server) => {
    expect(validateConfig(config({ server })).valid).toBe(false);
  });

  it.each(["https://example.com/mcp", "http://localhost:3000/mcp", "http://127.0.0.2/mcp", "http://[::1]/mcp"])("accepts remote URL %s", (url) => {
    expect(validateConfig(config({ server: { type: "streamable-http", url } })).valid).toBe(true);
  });

  it("generates standard configuration from authored entries or explicit snapshot hints", () => {
    const server = { type: "streamable-http" as const, url: "https://example.com/mcp" };
    const document = createConfig({ api: server });
    const snapshot = { mcpSpec: "0.3.2", server: { name: "api", version: "fixture" }, transport: server, tools: [] };
    expect(JSON.parse(generateConfig(snapshot, "api"))).toEqual(document);
    expect(() => generateConfig({ ...snapshot, transport: undefined }, "api")).toThrow(/no transport/);
    expect(() => generateConfig({ ...snapshot, transport: { type: "stdio", command: "/usr/bin/node" } }, "api")).toThrow(/executable/);
  });
});

describe("configured snapshot execution", () => {
  it("launches a bundled executable with contained cwd, single-pass expansion and persistent data", async () => {
    const p = await paths();
    const executable = join(p.pluginRoot, "server with spaces.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import {readFileSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const counter = process.env.PLUGIN_DATA + '/counter';
let count = 0; try { count = Number(readFileSync(counter, 'utf8')); } catch {}
writeFileSync(counter, String(count + 1));
for await (const line of createInterface({input: process.stdin})) {
 const message = JSON.parse(line); if (message.id === undefined) continue;
 const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, serverInfo: {name:'config-test',version:'fixture'}, capabilities:{tools:{}} }
 : {tools:[{name:'observed',inputSchema:{type:'object'},description:JSON.stringify({cwd:process.cwd(),root:process.env.PLUGIN_ROOT,data:process.env.PLUGIN_DATA,configured:process.env.CONFIGURED,args:process.argv.slice(2)})}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result}) + '\\n');
}
`, { mode: 0o755 });
    vi.stubEnv("PLUGIN_ROOT", "ambient-root");
    vi.stubEnv("PLUGIN_DATA", "ambient-data");
    const document = config({ server: { type: "stdio", command: "./server with spaces.mjs", cwd: "${PLUGIN_DATA}", args: ["${PLUGIN_ROOT}", "${UNKNOWN}"], env: { CONFIGURED: "${PLUGIN_ROOT}|${PLUGIN_DATA}|${HOME}" } } });
    const first = await snapshotConfig(document, "server", { ...p, timeout: 2000 });
    const actualData = await realpath(p.pluginData);
    expect(JSON.parse(first.tools![0].description!)).toEqual({ cwd: actualData, root: p.pluginRoot, data: actualData, configured: `${p.pluginRoot}|${actualData}|\${HOME}`, args: [p.pluginRoot, "${UNKNOWN}"] });
    expect(first.transport).toEqual({ type: "stdio", command: "./server with spaces.mjs", cwd: "${PLUGIN_DATA}", args: ["${PLUGIN_ROOT}", "${UNKNOWN}"] });
    expect(JSON.stringify(first)).not.toContain("ambient-data");
    await snapshotConfig(document, "server", { ...p, timeout: 2000 });
    expect(await readFile(join(p.pluginData, "counter"), "utf8")).toBe("2");
  });

  it("defaults cwd to the resolved plugin root and leaves arguments opaque", async () => {
    const p = await paths();
    const transport = await resolveConfigServer(config({ server: { type: "stdio", command: "node", args: ["../../opaque", "${HOME}"] } }), "server", p);
    expect(transport).toMatchObject({ command: "node", cwd: p.pluginRoot, args: ["../../opaque", "${HOME}"] });
    await expect(resolveConfigServer(config({ server: { type: "stdio", command: "node" } }), "server", { pluginRoot: p.pluginRoot })).rejects.toThrow(/pluginData/);
  });

  it("contains real command and cwd paths, including symlinks and traversal", async () => {
    const p = await paths();
    await writeFile(join(temporary!, "outside"), "outside");
    await writeFile(join(p.pluginRoot, "inside"), "inside");
    await symlink(join(temporary!, "outside"), join(p.pluginRoot, "escape"));
    await symlink(join(p.pluginRoot, "inside"), join(p.pluginRoot, "allowed"));
    for (const server of [
      { type: "stdio", command: "./escape" },
      { type: "stdio", command: "./../outside" },
      { type: "stdio", command: "node", cwd: "./.." },
      { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/.." },
    ]) await expect(resolveConfigServer(config({ server }), "server", p)).rejects.toThrow(/escapes/);
    expect(await resolveConfigServer(config({ server: { type: "stdio", command: "./allowed" } }), "server", p)).toMatchObject({ command: join(p.pluginRoot, "inside") });
  });

  it("selects a valid sibling and never expands remote strings", async () => {
    const server = { type: "streamable-http", url: "https://example.com/${PLUGIN_ROOT}", headers: { "X-Tenant": "${PLUGIN_DATA}" } };
    const document = config({ server, invalid: { type: "unknown" } });
    expect(await resolveConfigServer(document, "server", { pluginRoot: "/unused" })).toEqual(server);
    await expect(resolveConfigServer(document, "invalid", { pluginRoot: "/unused" })).rejects.toThrow(/Unavailable/);
  });

  it("reports spawn failures without an uncaught process error", async () => {
    const p = await paths();
    await expect(snapshotConfig(config({ server: { type: "stdio", command: "missing-mcp-config-test-executable" } }), "server", { ...p, timeout: 1000 })).rejects.toThrow(/Could not start/);
  });

  it("validates, generates and snapshots through the packaged CLI without overwriting config", async () => {
    const p = await paths();
    const input = join(p.pluginRoot, "mcp.json");
    const output = join(p.pluginRoot, "snapshot.json");
    const script = resolve("test/fixtures/fake-stdio-server.mjs");
    const document = config({ server: { type: "stdio", command: "node", args: [script] } });
    await writeFile(input, JSON.stringify(document));
    const cli = resolve("dist/cli.js");
    expect((await run(process.execPath, [cli, "validate-config", input])).stdout).toContain("Valid Agent Plugins");
    await run(process.execPath, [cli, "snapshot", "--config", input, "--server", "server", "--plugin-data", p.pluginData, "-o", output]);
    const snapshot = JSON.parse(await readFile(output, "utf8"));
    expect(snapshot.tools).toHaveLength(3);
    expect(JSON.parse((await run(process.execPath, [cli, "generate", output, "--format", "agent-plugin", "--server", "server"])).stdout)).toEqual(document);
    await expect(run(process.execPath, [cli, "snapshot", "--config", input, "--server", "server", "-o", input])).rejects.toThrow(/must differ/);
    expect(JSON.parse(await readFile(input, "utf8"))).toEqual(document);
  });
});
