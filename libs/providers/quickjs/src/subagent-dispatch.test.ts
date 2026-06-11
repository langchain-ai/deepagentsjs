import { describe, it, expect } from "vitest";
import { validateResponseSchema } from "./subagent-dispatch.js";

describe("validateResponseSchema", () => {
  it("accepts a simple valid schema", () => {
    expect(() =>
      validateResponseSchema({
        type: "object",
        properties: { name: { type: "string" } },
      }),
    ).not.toThrow();
  });

  it("rejects schema exceeding byte limit", () => {
    const huge: Record<string, unknown> = {
      type: "object",
      description: "x".repeat(4096),
    };
    expect(() => validateResponseSchema(huge)).toThrow("byte limit");
  });

  it("rejects schema exceeding max depth", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 7; i++) {
      schema = {
        type: "object",
        properties: { nested: schema },
      };
    }
    expect(() => validateResponseSchema(schema)).toThrow("nesting depth");
  });

  it("accepts schema at exactly max depth", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 5; i++) {
      schema = {
        type: "object",
        properties: { nested: schema },
      };
    }
    expect(() => validateResponseSchema(schema)).not.toThrow();
  });

  it("rejects schema exceeding max properties", () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 33; i++) {
      props[`f${i}`] = { type: "string" };
    }
    expect(() =>
      validateResponseSchema({ type: "object", properties: props }),
    ).toThrow("properties");
  });

  it("counts properties across nested levels", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 31 }, (_, i) => [`f${i}`, { type: "string" }]),
          ),
        },
      },
    };
    expect(() => validateResponseSchema(schema)).toThrow("properties");
  });

  it("traverses items for array schemas", () => {
    let inner: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 7; i++) {
      inner = { type: "array", items: inner };
    }
    expect(() => validateResponseSchema(inner)).toThrow("nesting depth");
  });
});
