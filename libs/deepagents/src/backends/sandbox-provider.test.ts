/**
 * Tests for SandboxProvider protocol and related types.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type {
  SandboxBackendProtocol,
  SandboxInfo,
  SandboxListResponse,
  SandboxListOptions,
  SandboxGetOrCreateOptions,
  SandboxDeleteOptions,
  SandboxProvider,
  ExecuteResponse,
  FileDownloadResponse,
  FileUploadResponse,
} from "./protocol.js";
import { BaseSandbox } from "./sandbox.js";

// ============================================================================
// Mock Implementations for Testing
// ============================================================================

/**
 * Example typed metadata for sandboxes.
 */
interface MockMetadata {
  status: "running" | "stopped";
  template: string;
}

/**
 * Mock implementation of SandboxBackendProtocol for testing.
 */
class MockSandboxBackend extends BaseSandbox {
  readonly id: string;

  constructor(sandboxId: string) {
    super();
    this.id = sandboxId;
  }

  execute(command: string): ExecuteResponse {
    return {
      output: `Got: ${command}`,
      exitCode: 0,
      truncated: false,
    };
  }

  uploadFiles(files: Array<[string, Uint8Array]>): FileUploadResponse[] {
    return files.map(([path]) => ({ path, error: null }));
  }

  downloadFiles(paths: string[]): FileDownloadResponse[] {
    return paths.map((path) => ({
      path,
      content: new Uint8Array([109, 111, 99, 107]), // "mock"
      error: null,
    }));
  }
}

/**
 * Mock provider implementation for testing.
 *
 * Demonstrates how to implement the SandboxProvider interface
 * with custom kwargs types and typed metadata.
 */
class MockSandboxProvider implements SandboxProvider<MockMetadata> {
  sandboxes: Map<string, MockMetadata> = new Map([
    ["sb_001", { status: "running", template: "node-20" }],
    ["sb_002", { status: "stopped", template: "python-3.11" }],
  ]);

  async list(
    options?: SandboxListOptions & {
      status?: "running" | "stopped";
      templateId?: string;
    },
  ): Promise<SandboxListResponse<MockMetadata>> {
    void options?.cursor; // Unused in simple implementation

    const items: SandboxInfo<MockMetadata>[] = [];

    for (const [sandboxId, metadata] of this.sandboxes) {
      // Apply status filter
      if (options?.status && metadata.status !== options.status) {
        continue;
      }
      // Apply template filter
      if (options?.templateId && metadata.template !== options.templateId) {
        continue;
      }

      items.push({
        sandboxId,
        metadata,
      });
    }

    return {
      items,
      cursor: null, // Simple implementation without pagination
    };
  }

  async getOrCreate(
    options?: SandboxGetOrCreateOptions & {
      templateId?: string;
      timeoutMinutes?: number;
    },
  ): Promise<SandboxBackendProtocol> {
    void options?.timeoutMinutes; // Unused in simple implementation

    if (options?.sandboxId) {
      // Get existing sandbox
      if (!this.sandboxes.has(options.sandboxId)) {
        throw new Error(`Sandbox ${options.sandboxId} not found`);
      }
      return new MockSandboxBackend(options.sandboxId);
    }

    // Create new sandbox
    const newId = `sb_${String(this.sandboxes.size + 1).padStart(3, "0")}`;
    this.sandboxes.set(newId, {
      status: "running",
      template: options?.templateId ?? "default",
    });
    return new MockSandboxBackend(newId);
  }

  async delete(
    options: SandboxDeleteOptions & { force?: boolean },
  ): Promise<void> {
    void options.force; // Unused in simple implementation

    // Idempotent - silently succeed if sandbox doesn't exist
    if (this.sandboxes.has(options.sandboxId)) {
      this.sandboxes.delete(options.sandboxId);
    }
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("SandboxProvider Types", () => {
  describe("SandboxInfo", () => {
    it("should have correct structure with typed metadata", () => {
      const info: SandboxInfo<MockMetadata> = {
        sandboxId: "sb_123",
        metadata: { status: "running", template: "node-20" },
      };

      expect(info.sandboxId).toBe("sb_123");
      expect(info.metadata).toBeDefined();
      expect(info.metadata?.status).toBe("running");
      expect(info.metadata?.template).toBe("node-20");
    });

    it("should allow optional metadata", () => {
      const info: SandboxInfo<MockMetadata> = {
        sandboxId: "sb_456",
      };

      expect(info.sandboxId).toBe("sb_456");
      expect(info.metadata).toBeUndefined();
    });

    it("should work with default Record metadata type", () => {
      const info: SandboxInfo = {
        sandboxId: "sb_789",
        metadata: { custom: "value", count: 42 },
      };

      expect(info.sandboxId).toBe("sb_789");
      expect(info.metadata?.custom).toBe("value");
    });
  });

  describe("SandboxListResponse", () => {
    it("should have correct structure", () => {
      const response: SandboxListResponse<MockMetadata> = {
        items: [
          {
            sandboxId: "sb_001",
            metadata: { status: "running", template: "node-20" },
          },
          { sandboxId: "sb_002" }, // metadata is optional
        ],
        cursor: "next_page_token",
      };

      expect(response.items).toHaveLength(2);
      expect(response.cursor).toBe("next_page_token");
    });

    it("should allow null cursor for last page", () => {
      const response: SandboxListResponse<MockMetadata> = {
        items: [{ sandboxId: "sb_001" }],
        cursor: null,
      };

      expect(response.cursor).toBeNull();
    });

    it("should allow empty items array", () => {
      const response: SandboxListResponse = {
        items: [],
        cursor: null,
      };

      expect(response.items).toHaveLength(0);
    });
  });
});

describe("MockSandboxProvider", () => {
  let provider: MockSandboxProvider;

  beforeEach(() => {
    provider = new MockSandboxProvider();
  });

  describe("list", () => {
    it("should list all sandboxes", async () => {
      const result = await provider.list();

      expect(result.items).toHaveLength(2);
      expect(result.cursor).toBeNull();
    });

    it("should filter by status", async () => {
      const result = await provider.list({ status: "running" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sandboxId).toBe("sb_001");
    });

    it("should filter by template", async () => {
      const result = await provider.list({ templateId: "python-3.11" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sandboxId).toBe("sb_002");
    });

    it("should return empty list when no matches", async () => {
      const result = await provider.list({ templateId: "nonexistent" });

      expect(result.items).toHaveLength(0);
    });
  });

  describe("getOrCreate", () => {
    it("should get existing sandbox by ID", async () => {
      const sandbox = await provider.getOrCreate({ sandboxId: "sb_001" });

      expect(sandbox.id).toBe("sb_001");
    });

    it("should create new sandbox when sandboxId is undefined", async () => {
      const sandbox = await provider.getOrCreate({
        templateId: "node-20",
        timeoutMinutes: 60,
      });

      expect(sandbox.id).toBe("sb_003");
      expect(provider.sandboxes.has("sb_003")).toBe(true);
    });

    it("should create new sandbox when no options provided", async () => {
      const sandbox = await provider.getOrCreate();

      expect(sandbox.id).toBe("sb_003");
    });

    it("should throw error for non-existent sandbox ID", async () => {
      await expect(
        provider.getOrCreate({ sandboxId: "sb_999" }),
      ).rejects.toThrow("Sandbox sb_999 not found");
    });

    it("should return functional sandbox backend", async () => {
      const sandbox = await provider.getOrCreate({ sandboxId: "sb_001" });
      const result = await sandbox.execute("echo hello");

      expect(result.output).toBe("Got: echo hello");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("delete", () => {
    it("should delete existing sandbox", async () => {
      expect(provider.sandboxes.has("sb_001")).toBe(true);

      await provider.delete({ sandboxId: "sb_001" });

      expect(provider.sandboxes.has("sb_001")).toBe(false);
    });

    it("should be idempotent - no error on non-existent sandbox", async () => {
      // Delete non-existent sandbox - should not throw
      await expect(
        provider.delete({ sandboxId: "sb_999" }),
      ).resolves.toBeUndefined();
    });

    it("should be idempotent - safe to delete twice", async () => {
      await provider.delete({ sandboxId: "sb_001" });
      // Second delete should succeed silently
      await expect(
        provider.delete({ sandboxId: "sb_001" }),
      ).resolves.toBeUndefined();

      expect(provider.sandboxes.has("sb_001")).toBe(false);
    });
  });

  describe("protocol compliance", () => {
    it("should satisfy SandboxProvider interface", async () => {
      // Type assertion to verify protocol compliance
      const _provider: SandboxProvider<MockMetadata> = provider;

      // Should be able to call protocol methods
      const listResult = await _provider.list();
      expect(typeof listResult).toBe("object");
      expect("items" in listResult).toBe(true);
      expect("cursor" in listResult).toBe(true);

      const sandbox = await _provider.getOrCreate();
      expect(typeof sandbox.id).toBe("string");
      expect(typeof sandbox.execute).toBe("function");

      await _provider.delete({ sandboxId: sandbox.id });
    });
  });
});
