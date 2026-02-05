/**
 * Unit tests for Modal authentication utilities.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthCredentials } from "./auth.js";

describe("getAuthCredentials", () => {
  // Store original env vars
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment to clean state
    vi.resetModules();
    process.env = { ...originalEnv };
    // Clear Modal token env vars
    delete process.env.MODAL_TOKEN_ID;
    delete process.env.MODAL_TOKEN_SECRET;
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe("with explicit options", () => {
    it("should return credentials from options", () => {
      const result = getAuthCredentials({
        tokenId: "my-token-id",
        tokenSecret: "my-token-secret",
      });

      expect(result).toEqual({
        tokenId: "my-token-id",
        tokenSecret: "my-token-secret",
      });
    });

    it("should prefer explicit options over environment variables", () => {
      process.env.MODAL_TOKEN_ID = "env-token-id";
      process.env.MODAL_TOKEN_SECRET = "env-token-secret";

      const result = getAuthCredentials({
        tokenId: "explicit-token-id",
        tokenSecret: "explicit-token-secret",
      });

      expect(result).toEqual({
        tokenId: "explicit-token-id",
        tokenSecret: "explicit-token-secret",
      });
    });
  });

  describe("with environment variables", () => {
    it("should return credentials from environment variables", () => {
      process.env.MODAL_TOKEN_ID = "env-token-id";
      process.env.MODAL_TOKEN_SECRET = "env-token-secret";

      const result = getAuthCredentials();

      expect(result).toEqual({
        tokenId: "env-token-id",
        tokenSecret: "env-token-secret",
      });
    });

    it("should work with undefined options", () => {
      process.env.MODAL_TOKEN_ID = "env-token-id";
      process.env.MODAL_TOKEN_SECRET = "env-token-secret";

      const result = getAuthCredentials(undefined);

      expect(result).toEqual({
        tokenId: "env-token-id",
        tokenSecret: "env-token-secret",
      });
    });

    it("should work with empty options object", () => {
      process.env.MODAL_TOKEN_ID = "env-token-id";
      process.env.MODAL_TOKEN_SECRET = "env-token-secret";

      const result = getAuthCredentials({});

      expect(result).toEqual({
        tokenId: "env-token-id",
        tokenSecret: "env-token-secret",
      });
    });
  });

  describe("with mixed sources", () => {
    it("should use explicit tokenId and env tokenSecret", () => {
      process.env.MODAL_TOKEN_SECRET = "env-token-secret";

      const result = getAuthCredentials({
        tokenId: "explicit-token-id",
      });

      expect(result).toEqual({
        tokenId: "explicit-token-id",
        tokenSecret: "env-token-secret",
      });
    });

    it("should use env tokenId and explicit tokenSecret", () => {
      process.env.MODAL_TOKEN_ID = "env-token-id";

      const result = getAuthCredentials({
        tokenSecret: "explicit-token-secret",
      });

      expect(result).toEqual({
        tokenId: "env-token-id",
        tokenSecret: "explicit-token-secret",
      });
    });
  });

  describe("error handling", () => {
    it("should throw error when both credentials are missing", () => {
      expect(() => getAuthCredentials()).toThrow("Modal authentication required");
      expect(() => getAuthCredentials()).toThrow(
        "Missing: MODAL_TOKEN_ID, MODAL_TOKEN_SECRET",
      );
    });

    it("should throw error when only tokenId is missing", () => {
      process.env.MODAL_TOKEN_SECRET = "env-token-secret";

      expect(() => getAuthCredentials()).toThrow("Modal authentication required");
      // Should only list MODAL_TOKEN_ID in the Missing: section
      expect(() => getAuthCredentials()).toThrow("Missing: MODAL_TOKEN_ID.");
    });

    it("should throw error when only tokenSecret is missing", () => {
      process.env.MODAL_TOKEN_ID = "env-token-id";

      expect(() => getAuthCredentials()).toThrow("Modal authentication required");
      // Should only list MODAL_TOKEN_SECRET in the Missing: section
      expect(() => getAuthCredentials()).toThrow("Missing: MODAL_TOKEN_SECRET.");
    });

    it("should throw error with empty string tokenId", () => {
      process.env.MODAL_TOKEN_SECRET = "env-token-secret";

      expect(() => getAuthCredentials({ tokenId: "" })).toThrow(
        "Missing: MODAL_TOKEN_ID",
      );
    });

    it("should throw error with empty string tokenSecret", () => {
      process.env.MODAL_TOKEN_ID = "env-token-id";

      expect(() => getAuthCredentials({ tokenSecret: "" })).toThrow(
        "Missing: MODAL_TOKEN_SECRET",
      );
    });

    it("should include setup instructions in error message", () => {
      expect(() => getAuthCredentials()).toThrow(
        "https://modal.com/settings/tokens",
      );
      expect(() => getAuthCredentials()).toThrow(
        "export MODAL_TOKEN_ID=your_token_id",
      );
    });
  });
});
