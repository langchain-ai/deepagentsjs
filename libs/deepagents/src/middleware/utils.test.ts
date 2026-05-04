import { describe, it, expect } from "vitest";
import { SystemMessage } from "@langchain/core/messages";
import {
  appendToSystemMessage,
  normalizeSchema,
  prependToSystemMessage,
} from "./utils.js";

describe("appendToSystemMessage", () => {
  it("should create a new SystemMessage when original is null", () => {
    const result = appendToSystemMessage(null, "Hello world");
    expect(result).toBeInstanceOf(SystemMessage);
    expect(result.content).toBe("Hello world");
  });

  it("should create a new SystemMessage when original is undefined", () => {
    const result = appendToSystemMessage(undefined, "Hello world");
    expect(result).toBeInstanceOf(SystemMessage);
    expect(result.content).toBe("Hello world");
  });

  it("should append text to string content with double newline", () => {
    const original = new SystemMessage({
      content: "You are a helpful assistant.",
    });
    const result = appendToSystemMessage(original, "Always be concise.");
    expect(result.content).toBe(
      "You are a helpful assistant.\n\nAlways be concise.",
    );
  });

  it("should handle empty original content", () => {
    const original = new SystemMessage({ content: "" });
    const result = appendToSystemMessage(original, "New content");
    expect(result.content).toBe("New content");
  });

  it("should handle array content by appending as text block", () => {
    const original = new SystemMessage({
      content: [{ type: "text", text: "Original content" }],
    });
    const result = appendToSystemMessage(original, "Appended content");
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content as any[]).length).toBe(2);
  });

  it("should handle empty array content", () => {
    const original = new SystemMessage({ content: [] });
    const result = appendToSystemMessage(original, "New content");
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content as any[])[0]).toEqual({
      type: "text",
      text: "New content",
    });
  });
});

describe("normalizeSchema", () => {
  it("adds additionalProperties: false to a top-level object", () => {
    const result = normalizeSchema({
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
    });
    expect(result.additionalProperties).toBe(false);
  });

  it("preserves an existing additionalProperties: false", () => {
    const result = normalizeSchema({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    expect(result.additionalProperties).toBe(false);
  });

  it("recurses into nested object properties", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        counts: {
          type: "object",
          properties: { a: { type: "number" } },
          required: ["a"],
        },
      },
      required: ["counts"],
    };
    const result = normalizeSchema(schema);
    const counts = (result.properties as Record<string, unknown>)
      .counts as Record<string, unknown>;
    expect(counts.additionalProperties).toBe(false);
  });

  it("recurses into array items", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    };
    const result = normalizeSchema(schema);
    const items = result.items as Record<string, unknown>;
    expect(items.additionalProperties).toBe(false);
  });

  it("handles deeply nested objects", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              counts: {
                type: "object",
                properties: { a: { type: "number" } },
              },
            },
          },
        },
      },
    };
    const result = normalizeSchema(schema);
    const items = (
      (result.properties as Record<string, unknown>).results as Record<
        string,
        unknown
      >
    ).items as Record<string, unknown>;
    const counts = (items.properties as Record<string, unknown>)
      .counts as Record<string, unknown>;
    expect(counts.additionalProperties).toBe(false);
  });

  it("passes through non-object/array types unchanged", () => {
    const schema = { type: "string" };
    expect(normalizeSchema(schema)).toEqual({ type: "string" });
  });

  it("preserves minItems on array types", () => {
    expect(
      normalizeSchema({ type: "array", minItems: 6, items: { type: "string" } })
        .minItems,
    ).toBe(6);
    expect(
      normalizeSchema({ type: "array", minItems: 0, items: { type: "string" } })
        .minItems,
    ).toBe(0);
    expect(
      normalizeSchema({ type: "array", minItems: 1, items: { type: "string" } })
        .minItems,
    ).toBe(1);
  });

  it("preserves maxItems on array types", () => {
    expect(
      normalizeSchema({
        type: "array",
        maxItems: 10,
        items: { type: "string" },
      }).maxItems,
    ).toBe(10);
  });
});

describe("prependToSystemMessage", () => {
  it("should create a new SystemMessage when original is null", () => {
    const result = prependToSystemMessage(null, "Hello world");
    expect(result).toBeInstanceOf(SystemMessage);
    expect(result.content).toBe("Hello world");
  });

  it("should create a new SystemMessage when original is undefined", () => {
    const result = prependToSystemMessage(undefined, "Hello world");
    expect(result).toBeInstanceOf(SystemMessage);
    expect(result.content).toBe("Hello world");
  });

  it("should prepend text to string content with double newline", () => {
    const original = new SystemMessage({ content: "Always be concise." });
    const result = prependToSystemMessage(
      original,
      "You are a helpful assistant.",
    );
    expect(result.content).toBe(
      "You are a helpful assistant.\n\nAlways be concise.",
    );
  });

  it("should handle empty original content", () => {
    const original = new SystemMessage({ content: "" });
    const result = prependToSystemMessage(original, "New content");
    expect(result.content).toBe("New content");
  });

  it("should handle array content by prepending as text block", () => {
    const original = new SystemMessage({
      content: [{ type: "text", text: "Original content" }],
    });
    const result = prependToSystemMessage(original, "Prepended content");
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content as any[]).length).toBe(2);
    expect((result.content as any[])[0]).toEqual({
      type: "text",
      text: "Prepended content\n\n",
    });
  });
});
