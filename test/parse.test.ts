import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { parse, parseString, McpParseError } from "../src/parse.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/weather-server.json");

describe("parse", () => {
  it("parses a valid mcp.json file", async () => {
    const spec = await parse(FIXTURE);
    expect(spec.mcpSpec).toBe("0.1.0");
    expect(spec.server.name).toBe("weather-server");
    expect(spec.server.version).toBe("1.2.0");
    expect(spec.tools).toHaveLength(3);
    expect(spec.resources).toHaveLength(2);
    expect(spec.prompts).toHaveLength(1);
  });

  it("throws on missing file", async () => {
    await expect(parse("/nonexistent/mcp.json")).rejects.toThrow();
  });
});

describe("parseString", () => {
  it("parses a minimal spec", () => {
    const spec = parseString(
      JSON.stringify({
        mcpSpec: "0.1.0",
        server: { name: "test", version: "1.0.0" },
      }),
    );
    expect(spec.mcpSpec).toBe("0.1.0");
    expect(spec.server.name).toBe("test");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseString("not json")).toThrow();
  });

  it("throws on non-object JSON", () => {
    expect(() => parseString('"string"')).toThrow(McpParseError);
    expect(() => parseString("42")).toThrow(McpParseError);
    expect(() => parseString("null")).toThrow(McpParseError);
  });

  it("throws on missing mcpSpec field", () => {
    expect(() =>
      parseString(JSON.stringify({ server: { name: "x", version: "1.0.0" } })),
    ).toThrow(McpParseError);
  });

  it("throws on missing server field", () => {
    expect(() => parseString(JSON.stringify({ mcpSpec: "0.1.0" }))).toThrow(
      McpParseError,
    );
  });

  it("throws on invalid server (missing name)", () => {
    expect(() =>
      parseString(
        JSON.stringify({ mcpSpec: "0.1.0", server: { version: "1.0.0" } }),
      ),
    ).toThrow(McpParseError);
  });

  it("throws on invalid server (missing version)", () => {
    expect(() =>
      parseString(
        JSON.stringify({ mcpSpec: "0.1.0", server: { name: "x" } }),
      ),
    ).toThrow(McpParseError);
  });
});

describe("$ref dereferencing", () => {
  it("resolves $ref pointers from $defs", () => {
    const spec = parseString(
      JSON.stringify({
        mcpSpec: "0.1.0",
        server: { name: "test", version: "1.0.0" },
        $defs: {
          Location: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lng: { type: "number" },
            },
          },
        },
        tools: [
          {
            name: "locate",
            inputSchema: {
              type: "object",
              properties: {
                location: { $ref: "#/$defs/Location" },
              },
            },
          },
        ],
      }),
    );

    const locationProp = spec.tools![0].inputSchema.properties!.location;
    expect(locationProp).not.toHaveProperty("$ref");
    expect(locationProp).toHaveProperty("type", "object");
    expect(locationProp).toHaveProperty("properties");
  });

  it("skips dereferencing when disabled", () => {
    const spec = parseString(
      JSON.stringify({
        mcpSpec: "0.1.0",
        server: { name: "test", version: "1.0.0" },
        $defs: {
          Foo: { type: "string" },
        },
        tools: [
          {
            name: "bar",
            inputSchema: {
              type: "object",
              properties: {
                foo: { $ref: "#/$defs/Foo" },
              },
            },
          },
        ],
      }),
      { dereference: false },
    );

    const fooProp = spec.tools![0].inputSchema.properties!.foo;
    expect(fooProp).toHaveProperty("$ref", "#/$defs/Foo");
  });

  it("leaves unresolvable $refs untouched", () => {
    const spec = parseString(
      JSON.stringify({
        mcpSpec: "0.1.0",
        server: { name: "test", version: "1.0.0" },
        $defs: {},
        tools: [
          {
            name: "bar",
            inputSchema: {
              type: "object",
              properties: {
                foo: { $ref: "#/$defs/Missing" },
              },
            },
          },
        ],
      }),
    );

    const fooProp = spec.tools![0].inputSchema.properties!.foo;
    expect(fooProp).toHaveProperty("$ref", "#/$defs/Missing");
  });
});
