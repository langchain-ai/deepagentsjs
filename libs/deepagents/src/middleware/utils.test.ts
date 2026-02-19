import { describe, it, expect } from "vitest";
import { SystemMessage } from "@langchain/core/messages";
import {
  appendToSystemMessage,
  prependToSystemMessage,
  mergeMiddleware,
} from "./utils.js";
import { AgentMiddleware, MIDDLEWARE_BRAND } from "langchain";

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

describe("mergeMiddleware", () => {
  const createMockMiddleware = (name: string): AgentMiddleware => ({
    [MIDDLEWARE_BRAND]: true,
    name,
  });

  it("should return defaults when custom is empty", () => {
    const defaults = [createMockMiddleware("mw1"), createMockMiddleware("mw2")];
    const result = mergeMiddleware(defaults, []);
    expect(result).toEqual(defaults);
    expect(result).toHaveLength(2);
  });

  it("should return custom when defaults is empty", () => {
    const custom = [createMockMiddleware("mw1"), createMockMiddleware("mw2")];
    const result = mergeMiddleware([], custom);
    expect(result).toEqual(custom);
    expect(result).toHaveLength(2);
  });

  it("should return empty when both are empty", () => {
    expect(mergeMiddleware([], [])).toEqual([]);
  });

  it("should replace default with same-named custom in-place", () => {
    const mw1 = createMockMiddleware("mw1");
    const mw2 = createMockMiddleware("mw2");
    const mw3 = createMockMiddleware("mw3");
    const mw2Override = createMockMiddleware("mw2");

    const result = mergeMiddleware([mw1, mw2, mw3], [mw2Override]);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(mw1);
    expect(result[1]).toBe(mw2Override); // replaced in-place
    expect(result[2]).toBe(mw3);
  });

  it("should append custom middleware that has no default counterpart", () => {
    const mw1 = createMockMiddleware("mw1");
    const mw2 = createMockMiddleware("mw2");
    const mw4 = createMockMiddleware("mw4");

    const result = mergeMiddleware([mw1, mw2], [mw4]);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(mw1);
    expect(result[1]).toBe(mw2);
    expect(result[2]).toBe(mw4);
  });

  it("should handle mixed overrides and additions", () => {
    const mw1 = createMockMiddleware("mw1");
    const mw2 = createMockMiddleware("mw2");
    const mw3 = createMockMiddleware("mw3");
    const mw2Override = createMockMiddleware("mw2");
    const mw4 = createMockMiddleware("mw4");

    const result = mergeMiddleware([mw1, mw2, mw3], [mw2Override, mw4]);

    expect(result).toHaveLength(4);
    expect(result[0]).toBe(mw1);
    expect(result[1]).toBe(mw2Override);
    expect(result[2]).toBe(mw3);
    expect(result[3]).toBe(mw4);
  });

  it("should replace all defaults when all are overridden", () => {
    const mw1 = createMockMiddleware("mw1");
    const mw2 = createMockMiddleware("mw2");
    const mw1Override = createMockMiddleware("mw1");
    const mw2Override = createMockMiddleware("mw2");

    const result = mergeMiddleware([mw1, mw2], [mw1Override, mw2Override]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(mw1Override);
    expect(result[1]).toBe(mw2Override);
  });

  it("should preserve default order for non-overridden middleware", () => {
    const mw1 = createMockMiddleware("mw1");
    const mw2 = createMockMiddleware("mw2");
    const mw3 = createMockMiddleware("mw3");
    const mw1Override = createMockMiddleware("mw1");
    const mw3Override = createMockMiddleware("mw3");

    const result = mergeMiddleware([mw1, mw2, mw3], [mw3Override, mw1Override]);

    expect(result).toHaveLength(3);
    expect(result[0]).toBe(mw1Override);
    expect(result[1]).toBe(mw2);
    expect(result[2]).toBe(mw3Override);
  });

  it("should not mutate input arrays", () => {
    const defaults = [createMockMiddleware("mw1"), createMockMiddleware("mw2")];
    const custom = [createMockMiddleware("mw2"), createMockMiddleware("mw3")];
    const defaultsCopy = [...defaults];
    const customCopy = [...custom];

    mergeMiddleware(defaults, custom);

    expect(defaults).toEqual(defaultsCopy);
    expect(custom).toEqual(customCopy);
  });
});
