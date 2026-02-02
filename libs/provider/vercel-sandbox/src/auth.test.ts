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
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL_ACCESS_TOKEN;
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe("explicit token in options", () => {
    it("should return provided token directly", () => {
      const token = getAuthToken({ type: "oidc", token: "my-explicit-token" });
      expect(token).toBe("my-explicit-token");
    });

    it("should prefer explicit token over environment variables", () => {
      process.env.VERCEL_OIDC_TOKEN = "env-oidc-token";
      process.env.VERCEL_ACCESS_TOKEN = "env-access-token";

      const token = getAuthToken({ type: "oidc", token: "explicit-token" });
      expect(token).toBe("explicit-token");
    });

    it("should work with access_token type", () => {
      const token = getAuthToken({
        type: "access_token",
        token: "my-access-token",
      });
      expect(token).toBe("my-access-token");
    });
  });

  describe("VERCEL_OIDC_TOKEN environment variable", () => {
    it("should use VERCEL_OIDC_TOKEN when no explicit token provided", () => {
      process.env.VERCEL_OIDC_TOKEN = "oidc-from-env";

      const token = getAuthToken();
      expect(token).toBe("oidc-from-env");
    });

    it("should use VERCEL_OIDC_TOKEN with type-only options", () => {
      process.env.VERCEL_OIDC_TOKEN = "oidc-token";

      const token = getAuthToken({ type: "oidc" });
      expect(token).toBe("oidc-token");
    });

    it("should use VERCEL_OIDC_TOKEN when options.token is undefined", () => {
      process.env.VERCEL_OIDC_TOKEN = "oidc-token";

      const token = getAuthToken({ type: "oidc" });
      expect(token).toBe("oidc-token");
    });

    it("should prefer VERCEL_OIDC_TOKEN over VERCEL_ACCESS_TOKEN", () => {
      process.env.VERCEL_OIDC_TOKEN = "oidc-token";
      process.env.VERCEL_ACCESS_TOKEN = "access-token";

      const token = getAuthToken();
      expect(token).toBe("oidc-token");
    });
  });

  describe("VERCEL_ACCESS_TOKEN fallback", () => {
    it("should use VERCEL_ACCESS_TOKEN when VERCEL_OIDC_TOKEN not set", () => {
      process.env.VERCEL_ACCESS_TOKEN = "access-token-fallback";

      const token = getAuthToken();
      expect(token).toBe("access-token-fallback");
    });

    it("should use VERCEL_ACCESS_TOKEN with type-only options", () => {
      process.env.VERCEL_ACCESS_TOKEN = "access-token";

      const token = getAuthToken({ type: "access_token" });
      expect(token).toBe("access-token");
    });
  });

  describe("error handling", () => {
    it("should throw when no token is available", () => {
      expect(() => getAuthToken()).toThrow("Vercel authentication required");
    });

    it("should throw with descriptive error message", () => {
      expect(() => getAuthToken()).toThrow("VERCEL_OIDC_TOKEN");
      expect(() => getAuthToken()).toThrow("VERCEL_ACCESS_TOKEN");
    });

    it("should throw when options provided but no token", () => {
      expect(() => getAuthToken({ type: "oidc" })).toThrow(
        "Vercel authentication required",
      );
    });

    it("should throw when type-only options provided without env vars", () => {
      expect(() => getAuthToken({ type: "oidc" })).toThrow(
        "Vercel authentication required",
      );
    });
  });

  describe("edge cases", () => {
    it("should handle empty string token in options as falsy", () => {
      process.env.VERCEL_OIDC_TOKEN = "env-token";

      // Empty string is falsy, should fall back to env var
      const token = getAuthToken({ type: "oidc", token: "" });
      // Note: Depending on implementation, this might use "" or fall back
      // Current implementation: empty string is falsy, so falls back to env
      expect(token).toBe("env-token");
    });

    it("should handle undefined explicitly", () => {
      process.env.VERCEL_ACCESS_TOKEN = "access-token";

      const token = getAuthToken(undefined);
      expect(token).toBe("access-token");
    });
  });
});
