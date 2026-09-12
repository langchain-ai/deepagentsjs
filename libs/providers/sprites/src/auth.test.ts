import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { getAuthToken, getAuthBaseURL, getAuthCredentials } from "./auth.js";

describe("auth", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SPRITES_TOKEN;
    delete process.env.SPRITES_API_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("getAuthToken", () => {
    it("should use explicit token from options", () => {
      expect(getAuthToken({ token: "explicit-token" })).toBe("explicit-token");
    });

    it("should prefer explicit token over environment variable", () => {
      process.env.SPRITES_TOKEN = "env-token";
      expect(getAuthToken({ token: "explicit-token" })).toBe("explicit-token");
    });

    it("should fall back to SPRITES_TOKEN environment variable", () => {
      process.env.SPRITES_TOKEN = "env-token";
      expect(getAuthToken()).toBe("env-token");
    });

    it("should throw a descriptive error when no token is available", () => {
      expect(() => getAuthToken()).toThrow("Sprites authentication required");
      expect(() => getAuthToken()).toThrow("SPRITES_TOKEN");
    });

    it("should ignore empty explicit token", () => {
      process.env.SPRITES_TOKEN = "env-token";
      expect(getAuthToken({ token: "" })).toBe("env-token");
    });
  });

  describe("getAuthBaseURL", () => {
    it("should use explicit baseURL from options", () => {
      expect(getAuthBaseURL({ baseURL: "https://example.com" })).toBe(
        "https://example.com",
      );
    });

    it("should fall back to SPRITES_API_URL environment variable", () => {
      process.env.SPRITES_API_URL = "https://env.example.com";
      expect(getAuthBaseURL()).toBe("https://env.example.com");
    });

    it("should default to the public Sprites API", () => {
      expect(getAuthBaseURL()).toBe("https://api.sprites.dev");
    });

    it("should prefer explicit baseURL over environment variable", () => {
      process.env.SPRITES_API_URL = "https://env.example.com";
      expect(getAuthBaseURL({ baseURL: "https://explicit.example.com" })).toBe(
        "https://explicit.example.com",
      );
    });
  });

  describe("getAuthCredentials", () => {
    it("should return complete credentials", () => {
      const credentials = getAuthCredentials({
        token: "my-token",
        baseURL: "https://example.com",
      });

      expect(credentials).toEqual({
        token: "my-token",
        baseURL: "https://example.com",
      });
    });

    it("should resolve from environment variables", () => {
      process.env.SPRITES_TOKEN = "env-token";

      const credentials = getAuthCredentials();

      expect(credentials).toEqual({
        token: "env-token",
        baseURL: "https://api.sprites.dev",
      });
    });

    it("should throw when no token is available", () => {
      expect(() => getAuthCredentials()).toThrow(
        "Sprites authentication required",
      );
    });
  });
});
