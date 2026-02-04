import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthApiKey, getAuthCredentials } from "./auth.js";

describe("auth", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clear environment variables before each test
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.LANGSMITH_API_KEY;
    delete process.env.LANGCHAIN_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getAuthApiKey", () => {
    it("should return explicit API key from options", () => {
      const apiKey = getAuthApiKey({ apiKey: "explicit-key" });
      expect(apiKey).toBe("explicit-key");
    });

    it("should prefer explicit API key over environment variables", () => {
      process.env.LANGSMITH_API_KEY = "env-key";
      const apiKey = getAuthApiKey({ apiKey: "explicit-key" });
      expect(apiKey).toBe("explicit-key");
    });

    it("should return LANGSMITH_API_KEY from environment", () => {
      process.env.LANGSMITH_API_KEY = "langsmith-key";
      const apiKey = getAuthApiKey();
      expect(apiKey).toBe("langsmith-key");
    });

    it("should return LANGCHAIN_API_KEY as fallback", () => {
      process.env.LANGCHAIN_API_KEY = "langchain-key";
      const apiKey = getAuthApiKey();
      expect(apiKey).toBe("langchain-key");
    });

    it("should prefer LANGSMITH_API_KEY over LANGCHAIN_API_KEY", () => {
      process.env.LANGSMITH_API_KEY = "langsmith-key";
      process.env.LANGCHAIN_API_KEY = "langchain-key";
      const apiKey = getAuthApiKey();
      expect(apiKey).toBe("langsmith-key");
    });

    it("should throw error when no API key is available", () => {
      expect(() => getAuthApiKey()).toThrow(
        "LangSmith authentication required",
      );
    });

    it("should throw error with helpful message", () => {
      expect(() => getAuthApiKey()).toThrow("LANGSMITH_API_KEY");
    });
  });

  describe("getAuthCredentials", () => {
    it("should return credentials object with API key", () => {
      process.env.LANGSMITH_API_KEY = "test-key";
      const credentials = getAuthCredentials();
      expect(credentials).toEqual({ apiKey: "test-key" });
    });

    it("should pass options to getAuthApiKey", () => {
      const credentials = getAuthCredentials({ apiKey: "explicit-key" });
      expect(credentials).toEqual({ apiKey: "explicit-key" });
    });
  });
});
