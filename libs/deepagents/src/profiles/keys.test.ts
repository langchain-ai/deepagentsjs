import { describe, it, expect } from "vitest";
import { validateProfileKey } from "./keys.js";

describe("validateProfileKey", () => {
  it("returns a valid provider-only key unchanged", () => {
    expect(validateProfileKey("anthropic")).toBe("anthropic");
  });

  it("returns a valid provider:model key unchanged", () => {
    expect(validateProfileKey("anthropic:claude-opus-4-7")).toBe(
      "anthropic:claude-opus-4-7",
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(validateProfileKey("  openai  ")).toBe("openai");
    expect(validateProfileKey("\tanthropic:claude-opus-4-7\n")).toBe(
      "anthropic:claude-opus-4-7",
    );
  });

  it("throws on empty string", () => {
    expect(() => validateProfileKey("")).toThrow("non-empty");
  });

  it("throws on whitespace-only string", () => {
    expect(() => validateProfileKey("   ")).toThrow("non-empty");
  });

  it("throws when more than one colon is present", () => {
    expect(() => validateProfileKey("a:b:c")).toThrow('more than one ":"');
  });

  it("throws when provider half is empty", () => {
    expect(() => validateProfileKey(":model")).toThrow(
      "empty provider or model",
    );
  });

  it("throws when model half is empty", () => {
    expect(() => validateProfileKey("provider:")).toThrow(
      "empty provider or model",
    );
  });

  it("throws when both halves are empty", () => {
    expect(() => validateProfileKey(":")).toThrow("empty provider or model");
  });
});
