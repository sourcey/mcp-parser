import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { parse } from "../src/parse.js";
import {
  generateLlmsTxt,
  generateLlmsFullTxt,
  generateMarkdown,
} from "../src/generate.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/weather-server.json");

describe("generateLlmsTxt", () => {
  it("generates a valid llms.txt", async () => {
    const spec = await parse(FIXTURE);
    const txt = generateLlmsTxt(spec);

    expect(txt).toContain("# weather-server");
    expect(txt).toContain("> Real-time weather data");
    expect(txt).toContain("## Tools");
    expect(txt).toContain("- get_weather:");
    expect(txt).toContain("- get_forecast:");
    expect(txt).toContain("- set_alert:");
    expect(txt).toContain("## Resources");
    expect(txt).toContain("Supported Cities");
    expect(txt).toContain("## Resource Templates");
    expect(txt).toContain("## Prompts");
    expect(txt).toContain("weather_report");
  });

  it("includes links when baseUrl is provided", async () => {
    const spec = await parse(FIXTURE);
    const txt = generateLlmsTxt(spec, "https://docs.example.com");

    expect(txt).toContain("[get_weather](https://docs.example.com/tools/get-weather.html)");
  });

  it("handles a minimal spec without crashing", () => {
    const txt = generateLlmsTxt({
      mcpSpec: "0.1.0",
      server: { name: "empty", version: "0.0.1" },
    });

    expect(txt).toContain("# empty");
    expect(txt).not.toContain("## Tools");
  });
});

describe("generateLlmsFullTxt", () => {
  it("generates full reference with parameter tables", async () => {
    const spec = await parse(FIXTURE);
    const txt = generateLlmsFullTxt(spec);

    expect(txt).toContain("# weather-server");
    expect(txt).toContain("Version: 1.2.0");
    expect(txt).toContain("### get_weather");
    expect(txt).toContain("**Parameters:**");
    expect(txt).toContain("| `city` |");
    expect(txt).toContain("| `units` |");
    expect(txt).toContain("`read-only`");
    expect(txt).toContain("`open-world`");
    expect(txt).toContain("**Returns:**");
    expect(txt).toContain("### set_alert");
    expect(txt).toContain("`idempotent`");
    expect(txt).toContain("### Supported Cities");
    expect(txt).toContain("URI: `weather://cities`");
    expect(txt).toContain("### weather_report");
    expect(txt).toContain("**Arguments:**");
  });

  it("handles tools with no annotations", () => {
    const txt = generateLlmsFullTxt({
      mcpSpec: "0.1.0",
      server: { name: "bare", version: "1.0.0" },
      tools: [
        {
          name: "plain",
          description: "No annotations",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(txt).toContain("### plain");
    expect(txt).not.toContain("`read-only`");
  });
});

describe("generateMarkdown", () => {
  it("produces the same output as generateLlmsFullTxt", async () => {
    const spec = await parse(FIXTURE);
    expect(generateMarkdown(spec)).toBe(generateLlmsFullTxt(spec));
  });
});
