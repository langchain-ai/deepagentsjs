/**
 * Unit tests for authentication utilities.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthToken } from "./auth.js";

describe("getAuthToken", () => {
  // Store original env vars
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment for each test
    vi.resetModules();
    process.env = { ...originalEnv };
    // Clear any auth-related env vars
    delete process.env.DENO_DEPLOY_TOKEN;
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe("explicit token in options", () => {
    it("should return provided token directly", () => {
      const token = getAuthToken({ token: "my-explicit-token" });
      expect(token).toBe("my-explicit-token");
    });

    it("should prefer explicit token over environment variables", () => {
      process.env.DENO_DEPLOY_TOKEN = "env-token";

      const token = getAuthToken({ token: "explicit-token" });
      expect(token).toBe("explicit-token");
    });
  });

  describe("DENO_DEPLOY_TOKEN environment variable", () => {
    it("should use DENO_DEPLOY_TOKEN when no explicit token provided", () => {
      process.env.DENO_DEPLOY_TOKEN = "token-from-env";

      const token = getAuthToken();
      expect(token).toBe("token-from-env");
    });

    it("should use DENO_DEPLOY_TOKEN with empty options", () => {
      process.env.DENO_DEPLOY_TOKEN = "deno-token";

      const token = getAuthToken({});
      expect(token).toBe("deno-token");
    });

    it("should use DENO_DEPLOY_TOKEN when options.token is undefined", () => {
      process.env.DENO_DEPLOY_TOKEN = "deno-token";

      const token = getAuthToken({ token: undefined });
      expect(token).toBe("deno-token");
    });
  });

  describe("error handling", () => {
    it("should throw when no token is available", () => {
      expect(() => getAuthToken()).toThrow(
        "Deno Deploy authentication required",
      );
    });

    it("should throw with descriptive error message", () => {
      expect(() => getAuthToken()).toThrow("DENO_DEPLOY_TOKEN");
    });

    it("should throw when options provided but no token", () => {
      expect(() => getAuthToken({})).toThrow(
        "Deno Deploy authentication required",
      );
    });
  });

  describe("edge cases", () => {
    it("should handle empty string token in options as falsy", () => {
      process.env.DENO_DEPLOY_TOKEN = "env-token";

      // Empty string is falsy, should fall back to env var
      const token = getAuthToken({ token: "" });
      // Note: Depending on implementation, this might use "" or fall back
      // Current implementation: empty string is falsy, so falls back to env
      expect(token).toBe("env-token");
    });

    it("should handle undefined explicitly", () => {
      process.env.DENO_DEPLOY_TOKEN = "deno-token";

      const token = getAuthToken(undefined);
      expect(token).toBe("deno-token");
    });
  });
});
