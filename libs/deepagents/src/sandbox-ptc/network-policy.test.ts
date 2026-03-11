import { describe, it, expect } from "vitest";

import { findMatchingRule, summarizePolicy } from "./network-policy.js";
import type { NetworkPolicy } from "./types.js";

const basePolicy: NetworkPolicy = {
  allowed: {
    "google.com": {},
    "api.google.com/v1": {
      headers: { "X-Api-Key": "key-123" },
      methods: ["GET", "POST"],
      maxResponseBytes: 5 * 1024 * 1024,
      timeoutMs: 10_000,
    },
    "api.google.com": {},
  },
  blocked: ["169.254.169.254", "api.google.com/v2"],
  defaultHeaders: { "User-Agent": "DeepAgent/1.0" },
  defaultMaxResponseBytes: 10 * 1024 * 1024,
  defaultTimeoutMs: 30_000,
};

describe("findMatchingRule", () => {
  it("should allow requests to a whitelisted host", () => {
    const result = findMatchingRule("https://google.com/search?q=hello", "GET", basePolicy);
    expect(result.allowed).toBe(true);
  });

  it("should reject requests to a non-whitelisted host", () => {
    const result = findMatchingRule("https://evil.com/steal", "GET", basePolicy);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("not in allowed list");
    }
  });

  it("should block requests matching the blocked list", () => {
    const result = findMatchingRule("http://169.254.169.254/latest/meta-data/", "GET", basePolicy);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("Blocked by policy");
    }
  });

  it("should block path-specific blocked entries", () => {
    const result = findMatchingRule("https://api.google.com/v2/translate", "GET", basePolicy);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("Blocked by policy");
    }
  });

  it("should match the most specific allowed rule", () => {
    const result = findMatchingRule("https://api.google.com/v1/search", "GET", basePolicy);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.mergedHeaders["X-Api-Key"]).toBe("key-123");
      expect(result.maxResponseBytes).toBe(5 * 1024 * 1024);
      expect(result.timeoutMs).toBe(10_000);
    }
  });

  it("should fall back to less specific rule when path doesn't match", () => {
    const result = findMatchingRule("https://api.google.com/v3/other", "GET", basePolicy);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.mergedHeaders["X-Api-Key"]).toBeUndefined();
      expect(result.maxResponseBytes).toBe(10 * 1024 * 1024);
    }
  });

  it("should merge defaultHeaders with rule headers", () => {
    const result = findMatchingRule("https://api.google.com/v1/search", "GET", basePolicy);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.mergedHeaders["User-Agent"]).toBe("DeepAgent/1.0");
      expect(result.mergedHeaders["X-Api-Key"]).toBe("key-123");
    }
  });

  it("should enforce method restrictions", () => {
    const getResult = findMatchingRule("https://api.google.com/v1/search", "GET", basePolicy);
    expect(getResult.allowed).toBe(true);

    const deleteResult = findMatchingRule("https://api.google.com/v1/search", "DELETE", basePolicy);
    expect(deleteResult.allowed).toBe(false);
    if (!deleteResult.allowed) {
      expect(deleteResult.reason).toContain("Method DELETE not allowed");
    }
  });

  it("should allow all methods when no restriction is set", () => {
    const result = findMatchingRule("https://google.com/anything", "DELETE", basePolicy);
    expect(result.allowed).toBe(true);
  });

  it("should reject invalid URLs", () => {
    const result = findMatchingRule("not-a-url", "GET", basePolicy);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("Invalid URL");
    }
  });

  it("should use defaults when no per-rule overrides exist", () => {
    const result = findMatchingRule("https://google.com/test", "GET", basePolicy);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.maxResponseBytes).toBe(10 * 1024 * 1024);
      expect(result.timeoutMs).toBe(30_000);
    }
  });
});

describe("summarizePolicy", () => {
  it("should list allowed origins and blocked entries", () => {
    const summary = summarizePolicy(basePolicy);
    expect(summary).toContain("google.com");
    expect(summary).toContain("api.google.com/v1");
    expect(summary).toContain("169.254.169.254");
    expect(summary).toContain("api.google.com/v2");
  });
});
