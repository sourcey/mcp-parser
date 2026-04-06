import { describe, it, expect } from "vitest";
import type { McpSpec } from "mcp-schema";
import { validate } from "../src/validate.js";

function makeSpec(overrides: Partial<McpSpec> = {}): McpSpec {
  return {
    mcpSpec: "0.1.0",
    server: { name: "test", version: "1.0.0" },
    description: "A test server",
    ...overrides,
  };
}

describe("validate", () => {
  it("passes a valid spec", () => {
    const result = validate(
      makeSpec({
        tools: [
          {
            name: "foo",
            description: "Does foo",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("warns on empty spec (no tools/resources/prompts)", () => {
    const result = validate(makeSpec());
    expect(result.valid).toBe(true);
    expect(result.diagnostics.some((d) => d.severity === "warning")).toBe(true);
  });

  it("warns on missing server description", () => {
    const result = validate(
      makeSpec({
        description: undefined,
        tools: [
          {
            name: "foo",
            description: "x",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );
    const descWarning = result.diagnostics.find(
      (d) => d.path === "description",
    );
    expect(descWarning).toBeDefined();
    expect(descWarning!.severity).toBe("warning");
  });

  // Tools
  describe("tools", () => {
    it("errors on missing tool name", () => {
      const result = validate(
        makeSpec({
          tools: [
            { name: "", description: "x", inputSchema: { type: "object" } },
          ],
        }),
      );
      expect(result.valid).toBe(false);
    });

    it("errors on duplicate tool names", () => {
      const result = validate(
        makeSpec({
          tools: [
            { name: "foo", description: "x", inputSchema: { type: "object" } },
            { name: "foo", description: "y", inputSchema: { type: "object" } },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(
        result.diagnostics.some((d) => d.message.includes("Duplicate")),
      ).toBe(true);
    });

    it("errors on missing inputSchema", () => {
      const result = validate(
        makeSpec({
          tools: [
            { name: "foo", description: "x" } as any,
          ],
        }),
      );
      expect(result.valid).toBe(false);
    });

    it("errors on non-object inputSchema type", () => {
      const result = validate(
        makeSpec({
          tools: [
            {
              name: "foo",
              description: "x",
              inputSchema: { type: "string" } as any,
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
    });

    it("warns on missing tool description", () => {
      const result = validate(
        makeSpec({
          tools: [{ name: "foo", inputSchema: { type: "object" } }],
        }),
      );
      expect(result.valid).toBe(true);
      expect(
        result.diagnostics.some(
          (d) => d.severity === "warning" && d.path.includes("description"),
        ),
      ).toBe(true);
    });

    it("errors when required references non-existent property", () => {
      const result = validate(
        makeSpec({
          tools: [
            {
              name: "foo",
              description: "x",
              inputSchema: {
                type: "object",
                properties: { a: { type: "string" } },
                required: ["a", "b"],
              },
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(
        result.diagnostics.some((d) => d.message.includes('"b"')),
      ).toBe(true);
    });

    it("warns on non-object outputSchema type", () => {
      const result = validate(
        makeSpec({
          tools: [
            {
              name: "foo",
              description: "x",
              inputSchema: { type: "object" },
              outputSchema: { type: "string" },
            },
          ],
        }),
      );
      expect(result.valid).toBe(true);
      expect(
        result.diagnostics.some((d) => d.message.includes("outputSchema")),
      ).toBe(true);
    });

    it("warns on uppercase tool name", () => {
      const result = validate(
        makeSpec({
          tools: [
            {
              name: "GetWeather",
              description: "x",
              inputSchema: { type: "object" },
            },
          ],
        }),
      );
      expect(
        result.diagnostics.some((d) => d.message.includes("uppercase")),
      ).toBe(true);
    });

    it("errors on tool name with whitespace", () => {
      const result = validate(
        makeSpec({
          tools: [
            {
              name: "get weather",
              description: "x",
              inputSchema: { type: "object" },
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(
        result.diagnostics.some((d) => d.message.includes("whitespace")),
      ).toBe(true);
    });
  });

  // Resources
  describe("resources", () => {
    it("errors on missing resource URI", () => {
      const result = validate(
        makeSpec({
          resources: [{ uri: "", name: "foo", description: "x" }],
        }),
      );
      expect(result.valid).toBe(false);
    });

    it("errors on duplicate resource URIs", () => {
      const result = validate(
        makeSpec({
          resources: [
            { uri: "test://a", name: "A", description: "x" },
            { uri: "test://a", name: "B", description: "y" },
          ],
        }),
      );
      expect(result.valid).toBe(false);
    });

    it("errors on missing resource name", () => {
      const result = validate(
        makeSpec({
          resources: [{ uri: "test://a", name: "", description: "x" }],
        }),
      );
      expect(result.valid).toBe(false);
    });

    it("warns on missing resource description", () => {
      const result = validate(
        makeSpec({
          resources: [{ uri: "test://a", name: "A" }],
        }),
      );
      expect(result.valid).toBe(true);
      expect(
        result.diagnostics.some((d) => d.severity === "warning"),
      ).toBe(true);
    });

    it("warns on resource URI without scheme", () => {
      const result = validate(
        makeSpec({
          resources: [{ uri: "/no-scheme", name: "A", description: "x" }],
        }),
      );
      expect(
        result.diagnostics.some((d) => d.message.includes("no scheme")),
      ).toBe(true);
    });
  });

  // Resource templates
  describe("resource templates", () => {
    it("errors on missing uriTemplate", () => {
      const result = validate(
        makeSpec({
          resourceTemplates: [
            { uriTemplate: "", name: "T", description: "x" } as any,
          ],
        }),
      );
      expect(result.valid).toBe(false);
    });

    it("errors on duplicate uriTemplates", () => {
      const result = validate(
        makeSpec({
          resourceTemplates: [
            { uriTemplate: "test://{id}", name: "A", description: "x" },
            { uriTemplate: "test://{id}", name: "B", description: "y" },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(
        result.diagnostics.some((d) => d.message.includes("Duplicate")),
      ).toBe(true);
    });

    it("warns on uriTemplate without variables", () => {
      const result = validate(
        makeSpec({
          resourceTemplates: [
            { uriTemplate: "test://static", name: "A", description: "x" },
          ],
        }),
      );
      expect(
        result.diagnostics.some((d) => d.message.includes("no template variables")),
      ).toBe(true);
    });

    it("errors on missing resource template name", () => {
      const result = validate(
        makeSpec({
          resourceTemplates: [
            { uriTemplate: "test://{id}", name: "", description: "x" } as any,
          ],
        }),
      );
      expect(result.valid).toBe(false);
    });

    it("warns on missing resource template description", () => {
      const result = validate(
        makeSpec({
          resourceTemplates: [
            { uriTemplate: "test://{id}", name: "A" },
          ],
        }),
      );
      expect(
        result.diagnostics.some((d) => d.severity === "warning" && d.message.includes("description")),
      ).toBe(true);
    });
  });

  // Prompts
  describe("prompts", () => {
    it("errors on missing prompt name", () => {
      const result = validate(
        makeSpec({
          prompts: [{ name: "", description: "x" }],
        }),
      );
      expect(result.valid).toBe(false);
    });

    it("errors on duplicate prompt names", () => {
      const result = validate(
        makeSpec({
          prompts: [
            { name: "foo", description: "x" },
            { name: "foo", description: "y" },
          ],
        }),
      );
      expect(result.valid).toBe(false);
    });

    it("warns on missing prompt description", () => {
      const result = validate(
        makeSpec({
          prompts: [{ name: "foo" }],
        }),
      );
      expect(result.valid).toBe(true);
    });

    it("errors on duplicate prompt argument names", () => {
      const result = validate(
        makeSpec({
          prompts: [
            {
              name: "foo",
              description: "x",
              arguments: [
                { name: "a", required: true },
                { name: "a", required: false },
              ],
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
    });

    it("errors on missing prompt argument name", () => {
      const result = validate(
        makeSpec({
          prompts: [
            {
              name: "foo",
              description: "x",
              arguments: [{ name: "", required: true }],
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
    });

    it("warns on missing prompt argument description", () => {
      const result = validate(
        makeSpec({
          prompts: [
            {
              name: "foo",
              description: "x",
              arguments: [{ name: "input", required: true }],
            },
          ],
        }),
      );
      expect(
        result.diagnostics.some(
          (d) => d.severity === "warning" && d.message.includes("argument") && d.message.includes("description"),
        ),
      ).toBe(true);
    });
  });
});
