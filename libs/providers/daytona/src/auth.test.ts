import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getAuthApiKey,
  getAuthApiUrl,
  getAuthCredentials,
} from "./auth.js";

describe("auth", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all relevant env vars before each test
    delete process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_URL;
    delete process.env.DAYTONA_TARGET;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe("getAuthApiKey", () => {
    it("should return explicit API key from options", () => {
      const apiKey = getAuthApiKey({ apiKey: "my-explicit-key" });
      expect(apiKey).toBe("my-explicit-key");
    });

    it("should return DAYTONA_API_KEY from environment", () => {
      process.env.DAYTONA_API_KEY = "env-api-key";
      const apiKey = getAuthApiKey();
      expect(apiKey).toBe("env-api-key");
    });

    it("should prefer explicit API key over environment variable", () => {
      process.env.DAYTONA_API_KEY = "env-api-key";
      const apiKey = getAuthApiKey({ apiKey: "explicit-key" });
      expect(apiKey).toBe("explicit-key");
    });

    it("should throw error when no API key is available", () => {
      expect(() => getAuthApiKey()).toThrow(
        "Daytona authentication required",
      );
    });

    it("should provide helpful error message with setup instructions", () => {
      expect(() => getAuthApiKey()).toThrow(/DAYTONA_API_KEY/);
      expect(() => getAuthApiKey()).toThrow(/auth: { apiKey:/);
    });
  });

  describe("getAuthApiUrl", () => {
    it("should return explicit API URL from options", () => {
      const apiUrl = getAuthApiUrl({ apiUrl: "https://custom.api.io" });
      expect(apiUrl).toBe("https://custom.api.io");
    });

    it("should return DAYTONA_API_URL from environment", () => {
      process.env.DAYTONA_API_URL = "https://env.api.io";
      const apiUrl = getAuthApiUrl();
      expect(apiUrl).toBe("https://env.api.io");
    });

    it("should prefer explicit API URL over environment variable", () => {
      process.env.DAYTONA_API_URL = "https://env.api.io";
      const apiUrl = getAuthApiUrl({ apiUrl: "https://explicit.api.io" });
      expect(apiUrl).toBe("https://explicit.api.io");
    });

    it("should return default URL when no URL is configured", () => {
      const apiUrl = getAuthApiUrl();
      expect(apiUrl).toBe("https://app.daytona.io/api");
    });
  });

  describe("getAuthCredentials", () => {
    it("should return complete credentials object", () => {
      process.env.DAYTONA_API_KEY = "test-api-key";

      const credentials = getAuthCredentials();
      expect(credentials).toEqual({
        apiKey: "test-api-key",
        apiUrl: "https://app.daytona.io/api",
        target: undefined,
      });
    });

    it("should include target from options", () => {
      process.env.DAYTONA_API_KEY = "test-api-key";

      const credentials = getAuthCredentials(undefined, "eu");
      expect(credentials.target).toBe("eu");
    });

    it("should include target from environment", () => {
      process.env.DAYTONA_API_KEY = "test-api-key";
      process.env.DAYTONA_TARGET = "us";

      const credentials = getAuthCredentials();
      expect(credentials.target).toBe("us");
    });

    it("should prefer target from options over environment", () => {
      process.env.DAYTONA_API_KEY = "test-api-key";
      process.env.DAYTONA_TARGET = "us";

      const credentials = getAuthCredentials(undefined, "eu");
      expect(credentials.target).toBe("eu");
    });

    it("should use all values from options", () => {
      const credentials = getAuthCredentials(
        {
          apiKey: "explicit-api-key",
          apiUrl: "https://custom.api.io",
        },
        "eu",
      );

      expect(credentials).toEqual({
        apiKey: "explicit-api-key",
        apiUrl: "https://custom.api.io",
        target: "eu",
      });
    });
  });
});
