import { describe, it, expect } from "vitest";
import { SystemMessage } from "@langchain/core/messages";
import {
  appendToSystemMessage,
  prependToSystemMessage,
  wasAborted,
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

describe("wasAborted", () => {
  it("is true for any error once the run's signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();

    expect(wasAborted(new Error("connection closed"), controller.signal)).toBe(
      true,
    );
  });

  it("is true for an error named AbortError without a signal", () => {
    const abortError = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });

    expect(wasAborted(abortError, undefined)).toBe(true);
  });

  it("is false for a request timeout while the run's signal is live", () => {
    const timeout = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );

    expect(wasAborted(timeout, new AbortController().signal)).toBe(false);
  });

  it("is false for an ordinary error without a signal", () => {
    expect(wasAborted(new Error("connection closed"), undefined)).toBe(false);
  });
});
