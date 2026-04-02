#!/usr/bin/env node

/**
 * mcp-parser CLI
 *
 * Usage:
 *   mcp-parser parse <file>          Parse and pretty-print an mcp.json
 *   mcp-parser validate <file>       Validate an mcp.json file
 *   mcp-parser snapshot [options]    Snapshot a running MCP server
 *   mcp-parser generate <file>       Generate llms.txt from an mcp.json
 */

import { readFile, writeFile } from "node:fs/promises";
import { parse } from "./parse.js";
import { validate } from "./validate.js";
import { snapshot } from "./snapshot.js";
import { generateLlmsTxt, generateLlmsFullTxt } from "./generate.js";

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
mcp-parser — Parse, validate, and snapshot MCP servers

Usage:
  mcp-parser parse <file>                        Parse and print an mcp.json
  mcp-parser validate <file>                     Validate an mcp.json file
  mcp-parser snapshot --stdio <command> [args]    Snapshot a running MCP server
  mcp-parser generate <file> [--format <fmt>]     Generate output from mcp.json

Options:
  --output, -o <file>     Write output to file instead of stdout
  --format <fmt>          Output format: llms-txt (default), llms-full-txt
  --help, -h              Show this help message

Examples:
  mcp-parser validate ./mcp.json
  mcp-parser snapshot --stdio "node server.js" -o mcp.json
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
    console.log("Valid — no issues found.");
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
  const stdioIdx = args.indexOf("--stdio");
  if (stdioIdx === -1 || !args[stdioIdx + 1]) {
    console.error('Usage: mcp-parser snapshot --stdio "<command>" [args] -o <output>');
    process.exit(1);
  }

  const commandStr = args[stdioIdx + 1];
  const parts = commandStr.split(/\s+/);
  const cmd = parts[0];
  const cmdArgs = parts.slice(1);

  const output = getOutputFlag() ?? "mcp.json";

  console.log(`Connecting to ${commandStr}...`);

  const spec = await snapshot({
    transport: { type: "stdio", command: cmd, args: cmdArgs },
  });

  await writeFile(output, JSON.stringify(spec, null, 2) + "\n");
  console.log(`Snapshot written to ${output}`);
  console.log(
    `  Server: ${spec.server.name} v${spec.server.version}`,
  );
  console.log(
    `  Tools: ${spec.tools?.length ?? 0}, Resources: ${spec.resources?.length ?? 0}, Prompts: ${spec.prompts?.length ?? 0}`,
  );
}

async function cmdGenerate(): Promise<void> {
  const file = args[1];
  if (!file) {
    console.error("Usage: mcp-parser generate <file> [--format <fmt>]");
    process.exit(1);
  }

  const spec = await parse(file);
  const format = getFlagValue("--format") ?? "llms-txt";
  const output = getOutputFlag();

  let content: string;
  switch (format) {
    case "llms-txt":
      content = generateLlmsTxt(spec);
      break;
    case "llms-full-txt":
      content = generateLlmsFullTxt(spec);
      break;
    default:
      console.error(`Unknown format: ${format}. Use: llms-txt, llms-full-txt`);
      process.exit(1);
  }

  if (output) {
    await writeFile(output, content);
    console.log(`Generated ${format} written to ${output}`);
  } else {
    console.log(content);
  }
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
