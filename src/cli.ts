#!/usr/bin/env node

/**
 * mcp-parser CLI
 *
 * Usage:
 *   mcp-parser parse <file>          Parse and pretty-print an mcp.json
 *   mcp-parser validate <file>       Validate an mcp.json file
 *   mcp-parser snapshot [options]    Snapshot a running MCP server
 *   mcp-parser generate <file>       Generate docs/context output from an mcp.json
 */

import { readFile, writeFile } from "node:fs/promises";
import { parse } from "./parse.js";
import { validate } from "./validate.js";
import { snapshot } from "./snapshot.js";
import { generateLlmsTxt, generateLlmsFullTxt, generateMarkdown } from "./generate.js";

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case "parse":
      await cmdParse();
      break;
    case "validate":
      await cmdValidate();
      break;
    case "snapshot":
      await cmdSnapshot();
      break;
    case "generate":
      await cmdGenerate();
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`
mcp-parser - Snapshot, parse, validate, and document MCP servers

Usage:
  mcp-parser parse <file>                        Parse and print an mcp.json
  mcp-parser validate <file>                     Validate an mcp.json file
  mcp-parser snapshot <transport> [options]       Snapshot a running MCP server
  mcp-parser generate <file> [--format <fmt>]    Generate output from mcp.json

Transports:
  --stdio "<command>"     Spawn a process and communicate via stdin/stdout
  --sse <url>             Connect to an SSE endpoint
  --http <url>            Connect via streamable HTTP

Options:
  --output, -o <file>     Write output to file instead of stdout
  --format <fmt>          Output format: markdown (default), llms-txt, llms-full-txt
  --header <key:value>    Add HTTP header (SSE/HTTP transports, repeatable)
  --help, -h              Show this help message

Examples:
  mcp-parser validate ./mcp.json
  mcp-parser snapshot --stdio "node server.js" -o mcp.json
  mcp-parser snapshot --sse http://localhost:3000/sse -o mcp.json
  mcp-parser snapshot --http http://localhost:3000/mcp -o mcp.json
  mcp-parser generate ./mcp.json -o mcp.md
  mcp-parser generate ./mcp.json --format llms-txt -o llms.txt
`);
}

async function cmdParse(): Promise<void> {
  const file = args[1];
  if (!file) {
    console.error("Usage: mcp-parser parse <file>");
    process.exit(1);
  }

  const spec = await parse(file);
  const output = getOutputFlag();

  const json = JSON.stringify(spec, null, 2);
  if (output) {
    await writeFile(output, json + "\n");
    console.log(`Parsed spec written to ${output}`);
  } else {
    console.log(json);
  }
}

async function cmdValidate(): Promise<void> {
  const file = args[1];
  if (!file) {
    console.error("Usage: mcp-parser validate <file>");
    process.exit(1);
  }

  const spec = await parse(file);
  const result = validate(spec);

  if (result.diagnostics.length === 0) {
    console.log("Valid: no issues found.");
    return;
  }

  for (const d of result.diagnostics) {
    const prefix = d.severity === "error" ? "ERROR" : "WARN";
    const path = d.path ? ` ${d.path}:` : "";
    console.log(`  ${prefix}${path} ${d.message}`);
  }

  console.log("");
  console.log(
    result.valid
      ? `Valid with ${result.diagnostics.length} warning(s).`
      : `Invalid — ${result.diagnostics.filter((d) => d.severity === "error").length} error(s) found.`,
  );

  if (!result.valid) process.exit(1);
}

async function cmdSnapshot(): Promise<void> {
  const headers = parseHeaders();
  const output = getOutputFlag() ?? "mcp.json";

  let transport: Parameters<typeof snapshot>[0]["transport"];

  const stdioIdx = args.indexOf("--stdio");
  const sseIdx = args.indexOf("--sse");
  const httpIdx = args.indexOf("--http");

  if (stdioIdx !== -1 && args[stdioIdx + 1]) {
    const commandStr = args[stdioIdx + 1];
    const parts = commandStr.split(/\s+/);
    transport = { type: "stdio", command: parts[0], args: parts.slice(1) };
    console.log(`Connecting via stdio: ${commandStr}...`);
  } else if (sseIdx !== -1 && args[sseIdx + 1]) {
    transport = { type: "sse", url: args[sseIdx + 1], ...(Object.keys(headers).length && { headers }) };
    console.log(`Connecting via SSE: ${args[sseIdx + 1]}...`);
  } else if (httpIdx !== -1 && args[httpIdx + 1]) {
    transport = { type: "streamable-http", url: args[httpIdx + 1], ...(Object.keys(headers).length && { headers }) };
    console.log(`Connecting via HTTP: ${args[httpIdx + 1]}...`);
  } else {
    console.error("Usage: mcp-parser snapshot --stdio|--sse|--http <target> [-o output]");
    process.exit(1);
  }

  const spec = await snapshot({ transport });

  await writeFile(output, JSON.stringify(spec, null, 2) + "\n");
  console.log(`Snapshot written to ${output}`);
  console.log(`  Server: ${spec.server.name} v${spec.server.version}`);
  console.log(`  Tools: ${spec.tools?.length ?? 0}, Resources: ${spec.resources?.length ?? 0}, Prompts: ${spec.prompts?.length ?? 0}`);
}

async function cmdGenerate(): Promise<void> {
  const file = args[1];
  if (!file) {
    console.error("Usage: mcp-parser generate <file> [--format <fmt>]");
    process.exit(1);
  }

  const spec = await parse(file);
  const format = getFlagValue("--format") ?? "markdown";
  const output = getOutputFlag();

  let content: string;
  switch (format) {
    case "markdown":
      content = generateMarkdown(spec);
      break;
    case "llms-txt":
      content = generateLlmsTxt(spec);
      break;
    case "llms-full-txt":
      content = generateLlmsFullTxt(spec);
      break;
    default:
      console.error(`Unknown format: ${format}. Use: markdown, llms-txt, llms-full-txt`);
      process.exit(1);
  }

  if (output) {
    await writeFile(output, content);
    console.log(`Generated ${format} written to ${output}`);
  } else {
    console.log(content);
  }
}

function parseHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--header" && args[i + 1]) {
      const val = args[i + 1];
      const sep = val.indexOf(":");
      if (sep > 0) {
        headers[val.slice(0, sep).trim()] = val.slice(sep + 1).trim();
      }
      i++;
    }
  }
  return headers;
}

function getOutputFlag(): string | undefined {
  return getFlagValue("-o") ?? getFlagValue("--output");
}

function getFlagValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
