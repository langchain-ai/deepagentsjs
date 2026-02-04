import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LangSmithSandbox, LangSmithSandboxError } from "./index.js";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("LangSmithSandbox", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    mockFetch.mockReset();
    process.env = { ...originalEnv };
    process.env.LANGSMITH_API_KEY = "test-api-key";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("constructor", () => {
    it("should create instance with required options", () => {
      const sandbox = new LangSmithSandbox({ templateName: "default" });
      expect(sandbox).toBeInstanceOf(LangSmithSandbox);
      expect(sandbox.id).toMatch(/^langsmith-sandbox-\d+$/);
      expect(sandbox.isRunning).toBe(false);
    });

    it("should accept all options", () => {
      const sandbox = new LangSmithSandbox({
        templateName: "custom",
        name: "my-sandbox",
        waitForReady: true,
        timeout: 120,
        region: "eu",
        auth: { apiKey: "custom-key" },
      });
      expect(sandbox).toBeInstanceOf(LangSmithSandbox);
    });
  });

  describe("initialize", () => {
    it("should create sandbox via API", async () => {
      const mockResponse = {
        id: "sandbox-123",
        name: "test-sandbox",
        template_name: "default",
        dataplane_url: "https://dataplane.example.com",
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const sandbox = new LangSmithSandbox({ templateName: "default" });
      await sandbox.initialize();

      expect(sandbox.id).toBe("sandbox-123");
      expect(sandbox.name).toBe("test-sandbox");
      expect(sandbox.dataplaneUrl).toBe("https://dataplane.example.com");
      expect(sandbox.isRunning).toBe(true);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.host.langchain.com/v2/sandboxes/boxes",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "X-Api-Key": "test-api-key",
          }),
          body: expect.stringContaining('"template_name":"default"'),
        }),
      );
    });

    it("should use EU region when specified", async () => {
      const mockResponse = {
        id: "sandbox-123",
        name: "test-sandbox",
        template_name: "default",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const sandbox = new LangSmithSandbox({
        templateName: "default",
        region: "eu",
      });
      await sandbox.initialize();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://eu.api.host.langchain.com/v2/sandboxes/boxes",
        expect.anything(),
      );
    });

    it("should throw ALREADY_INITIALIZED if called twice", async () => {
      const mockResponse = {
        id: "sandbox-123",
        name: "test-sandbox",
        template_name: "default",
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const sandbox = new LangSmithSandbox({ templateName: "default" });
      await sandbox.initialize();

      await expect(sandbox.initialize()).rejects.toThrow(LangSmithSandboxError);
      await expect(sandbox.initialize()).rejects.toMatchObject({
        code: "ALREADY_INITIALIZED",
      });
    });

    it("should throw SANDBOX_CREATION_FAILED on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: () =>
          Promise.resolve({
            detail: { error: "BadRequest", message: "Invalid template" },
          }),
      });

      const sandbox = new LangSmithSandbox({ templateName: "invalid" });

      await expect(sandbox.initialize()).rejects.toThrow(LangSmithSandboxError);
      await expect(
        new LangSmithSandbox({ templateName: "invalid" }).initialize(),
      ).rejects.toMatchObject({
        code: "SANDBOX_CREATION_FAILED",
      });
    });

    it("should throw IMAGE_PULL_FAILED on image pull error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        json: () =>
          Promise.resolve({
            detail: { error: "ImagePull", message: "Failed to pull image" },
          }),
      });

      const sandbox = new LangSmithSandbox({ templateName: "default" });

      await expect(sandbox.initialize()).rejects.toMatchObject({
        code: "IMAGE_PULL_FAILED",
      });
    });

    it("should throw AUTHENTICATION_FAILED when no API key", async () => {
      delete process.env.LANGSMITH_API_KEY;
      delete process.env.LANGCHAIN_API_KEY;

      const sandbox = new LangSmithSandbox({ templateName: "default" });

      await expect(sandbox.initialize()).rejects.toThrow(LangSmithSandboxError);
      await expect(
        new LangSmithSandbox({ templateName: "default" }).initialize(),
      ).rejects.toMatchObject({
        code: "AUTHENTICATION_FAILED",
      });
    });
  });

  describe("execute", () => {
    it("should throw NOT_INITIALIZED if not initialized", async () => {
      const sandbox = new LangSmithSandbox({ templateName: "default" });

      await expect(sandbox.execute("echo hello")).rejects.toThrow(
        LangSmithSandboxError,
      );
      await expect(sandbox.execute("echo hello")).rejects.toMatchObject({
        code: "NOT_INITIALIZED",
      });
    });

    it("should execute command via data plane", async () => {
      // Mock initialization
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "sandbox-123",
            name: "test-sandbox",
            template_name: "default",
            dataplane_url: "https://dataplane.example.com",
          }),
      });

      // Mock execute
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            stdout: "hello world\n",
            stderr: "",
            exit_code: 0,
            truncated: false,
          }),
      });

      const sandbox = new LangSmithSandbox({ templateName: "default" });
      await sandbox.initialize();

      const result = await sandbox.execute("echo hello world");

      expect(result.output).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(false);

      expect(mockFetch).toHaveBeenLastCalledWith(
        "https://dataplane.example.com/execute",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "X-Api-Key": "test-api-key",
          }),
          body: expect.stringContaining('"command":"echo hello world"'),
        }),
      );
    });

    it("should throw COMMAND_FAILED on execution error", async () => {
      // Mock initialization
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "sandbox-123",
            name: "test-sandbox",
            template_name: "default",
            dataplane_url: "https://dataplane.example.com",
          }),
      });

      // Mock failed execute
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve("Command failed"),
      });

      const sandbox = new LangSmithSandbox({ templateName: "default" });
      await sandbox.initialize();

      await expect(sandbox.execute("bad command")).rejects.toMatchObject({
        code: "COMMAND_FAILED",
      });
    });
  });

  describe("close", () => {
    it("should delete sandbox via API", async () => {
      // Mock initialization
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "sandbox-123",
            name: "test-sandbox",
            template_name: "default",
          }),
      });

      // Mock delete
      mockFetch.mockResolvedValueOnce({
        ok: true,
      });

      const sandbox = new LangSmithSandbox({ templateName: "default" });
      await sandbox.initialize();
      await sandbox.close();

      expect(sandbox.isRunning).toBe(false);
      expect(mockFetch).toHaveBeenLastCalledWith(
        "https://api.host.langchain.com/v2/sandboxes/boxes/test-sandbox",
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({
            "X-Api-Key": "test-api-key",
          }),
        }),
      );
    });

    it("should be idempotent", async () => {
      // Mock initialization
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "sandbox-123",
            name: "test-sandbox",
            template_name: "default",
          }),
      });

      // Mock delete
      mockFetch.mockResolvedValueOnce({
        ok: true,
      });

      const sandbox = new LangSmithSandbox({ templateName: "default" });
      await sandbox.initialize();
      await sandbox.close();
      await sandbox.close(); // Should not throw

      // Only called twice: once for create, once for delete
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("static create", () => {
    it("should create and initialize sandbox", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "sandbox-123",
            name: "test-sandbox",
            template_name: "default",
            dataplane_url: "https://dataplane.example.com",
          }),
      });

      const sandbox = await LangSmithSandbox.create({ templateName: "default" });

      expect(sandbox.isRunning).toBe(true);
      expect(sandbox.id).toBe("sandbox-123");
    });
  });

  describe("static connect", () => {
    it("should connect to existing sandbox", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "sandbox-123",
            name: "existing-sandbox",
            template_name: "default",
            dataplane_url: "https://dataplane.example.com",
          }),
      });

      const sandbox = await LangSmithSandbox.connect("existing-sandbox");

      expect(sandbox.isRunning).toBe(true);
      expect(sandbox.name).toBe("existing-sandbox");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.host.langchain.com/v2/sandboxes/boxes/existing-sandbox",
        expect.objectContaining({
          method: "GET",
        }),
      );
    });

    it("should throw SANDBOX_NOT_FOUND for missing sandbox", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(
        LangSmithSandbox.connect("missing-sandbox"),
      ).rejects.toMatchObject({
        code: "SANDBOX_NOT_FOUND",
      });
    });
  });

  describe("static list", () => {
    it("should list all sandboxes", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            sandboxes: [
              { id: "sb-1", name: "sandbox-1", template_name: "default" },
              { id: "sb-2", name: "sandbox-2", template_name: "custom" },
            ],
          }),
      });

      const sandboxes = await LangSmithSandbox.list();

      expect(sandboxes).toHaveLength(2);
      expect(sandboxes[0].name).toBe("sandbox-1");
      expect(sandboxes[1].name).toBe("sandbox-2");
    });
  });
});

describe("LangSmithSandboxError", () => {
  it("should create error with message and code", () => {
    const error = new LangSmithSandboxError(
      "Test error",
      "SANDBOX_CREATION_FAILED",
    );

    expect(error.message).toBe("Test error");
    expect(error.code).toBe("SANDBOX_CREATION_FAILED");
    expect(error.name).toBe("LangSmithSandboxError");
    expect(error.cause).toBeUndefined();
  });

  it("should create error with cause", () => {
    const cause = new Error("Original error");
    const error = new LangSmithSandboxError(
      "Wrapped error",
      "API_ERROR",
      cause,
    );

    expect(error.cause).toBe(cause);
  });

  it("should be instanceof Error", () => {
    const error = new LangSmithSandboxError("Test", "NOT_INITIALIZED");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(LangSmithSandboxError);
  });
});
