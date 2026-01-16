import { describe, it, expect, vi } from "vitest";
import { createMemoryMiddleware } from "./memory.js";
import type {
  BackendProtocol,
  FileDownloadResponse,
} from "../backends/protocol.js";

// Mock backend that returns specified files
function createMockBackend(
  files: Record<string, string | null>,
): BackendProtocol {
  return {
    async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
      return paths.map((path) => {
        const content = files[path];
        if (content === null || content === undefined) {
          return { path, error: "file_not_found", content: null };
        }
        return {
          path,
          content: new TextEncoder().encode(content),
          error: null,
        };
      });
    },
    // Implement other required methods as stubs
    listDir: vi.fn(),
    readFiles: vi.fn(),
    writeFile: vi.fn(),
    editFile: vi.fn(),
    grep: vi.fn(),
  } as unknown as BackendProtocol;
}

describe("createMemoryMiddleware", () => {
  describe("beforeAgent", () => {
    it("should load memory content from configured sources", async () => {
      const mockBackend = createMockBackend({
        "~/.deepagents/AGENTS.md": "# User Memory\n\nThis is user memory.",
        "./.deepagents/AGENTS.md":
          "# Project Memory\n\nThis is project memory.",
      });

      const middleware = createMemoryMiddleware({
        backend: mockBackend,
        sources: ["~/.deepagents/AGENTS.md", "./.deepagents/AGENTS.md"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(result).toBeDefined();
      expect(result?.memoryContents).toEqual({
        "~/.deepagents/AGENTS.md": "# User Memory\n\nThis is user memory.",
        "./.deepagents/AGENTS.md":
          "# Project Memory\n\nThis is project memory.",
      });
    });

    it("should skip missing files gracefully", async () => {
      const mockBackend = createMockBackend({
        "~/.deepagents/AGENTS.md": "# User Memory",
        // Project file doesn't exist
      });

      const middleware = createMemoryMiddleware({
        backend: mockBackend,
        sources: ["~/.deepagents/AGENTS.md", "./.deepagents/AGENTS.md"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(result).toBeDefined();
      expect(result?.memoryContents).toEqual({
        "~/.deepagents/AGENTS.md": "# User Memory",
      });
    });

    it("should return empty object when no files exist", async () => {
      const mockBackend = createMockBackend({});

      const middleware = createMemoryMiddleware({
        backend: mockBackend,
        sources: ["~/.deepagents/AGENTS.md"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(result).toBeDefined();
      expect(result?.memoryContents).toEqual({});
    });

    it("should skip loading if memoryContents already in state", async () => {
      const mockBackend = createMockBackend({
        "~/.deepagents/AGENTS.md": "Should not load this",
      });

      const middleware = createMemoryMiddleware({
        backend: mockBackend,
        sources: ["~/.deepagents/AGENTS.md"],
      });

      const existingContents = { cached: "content" };
      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({
        memoryContents: existingContents,
      });

      // Should return undefined since already loaded
      expect(result).toBeUndefined();
    });

    it("should work with backend factory function", async () => {
      const mockBackend = createMockBackend({
        "/memory/AGENTS.md": "# Factory Memory",
      });

      const backendFactory = vi.fn().mockReturnValue(mockBackend);

      const middleware = createMemoryMiddleware({
        backend: backendFactory,
        sources: ["/memory/AGENTS.md"],
      });

      // @ts-expect-error - typing issue in LangChain
      const result = await middleware.beforeAgent?.({});

      expect(backendFactory).toHaveBeenCalled();
      expect(result?.memoryContents).toEqual({
        "/memory/AGENTS.md": "# Factory Memory",
      });
    });
  });

  describe("wrapModelCall", () => {
    it("should inject memory content into system prompt", () => {
      const middleware = createMemoryMiddleware({
        backend: createMockBackend({}),
        sources: ["~/.deepagents/AGENTS.md", "./.deepagents/AGENTS.md"],
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request = {
        systemPrompt: "Base prompt",
        state: {
          memoryContents: {
            "~/.deepagents/AGENTS.md": "User memory content",
            "./.deepagents/AGENTS.md": "Project memory content",
          },
        },
      };

      middleware.wrapModelCall!(request as any, mockHandler);

      expect(mockHandler).toHaveBeenCalled();
      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemPrompt).toContain("Agent Memory");
      expect(modifiedRequest.systemPrompt).toContain("User memory content");
      expect(modifiedRequest.systemPrompt).toContain("Project memory content");
      expect(modifiedRequest.systemPrompt).toContain("~/.deepagents/AGENTS.md");
      expect(modifiedRequest.systemPrompt).toContain("./.deepagents/AGENTS.md");
    });

    it("should show (No memory loaded) when no content", () => {
      const middleware = createMemoryMiddleware({
        backend: createMockBackend({}),
        sources: ["~/.deepagents/AGENTS.md"],
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request = {
        systemPrompt: "Base prompt",
        state: { memoryContents: {} },
      };

      middleware.wrapModelCall!(request as any, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemPrompt).toContain("(No memory loaded)");
    });

    it("should prepend memory section to existing system prompt", () => {
      const middleware = createMemoryMiddleware({
        backend: createMockBackend({}),
        sources: [],
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request = {
        systemPrompt: "Original system prompt content",
        state: { memoryContents: {} },
      };

      middleware.wrapModelCall!(request as any, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      // Memory section should come before the original prompt
      const memoryIndex = modifiedRequest.systemPrompt.indexOf("Agent Memory");
      const originalIndex = modifiedRequest.systemPrompt.indexOf(
        "Original system prompt content",
      );
      expect(memoryIndex).toBeLessThan(originalIndex);
    });

    it("should work when state has no memoryContents", () => {
      const middleware = createMemoryMiddleware({
        backend: createMockBackend({}),
        sources: ["~/.deepagents/AGENTS.md"],
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request = {
        systemPrompt: "Base prompt",
        state: {},
      };

      middleware.wrapModelCall!(request as any, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemPrompt).toContain("(No memory loaded)");
    });
  });

  describe("integration", () => {
    it("should work end-to-end: load memory and inject into prompt", async () => {
      const mockBackend = createMockBackend({
        "~/.deepagents/AGENTS.md":
          "# User Agent Memory\n\nI prefer TypeScript.",
        "./project/AGENTS.md": "# Project Memory\n\nThis is a React project.",
      });

      const middleware = createMemoryMiddleware({
        backend: mockBackend,
        sources: ["~/.deepagents/AGENTS.md", "./project/AGENTS.md"],
      });

      // Step 1: Load memory
      // @ts-expect-error - typing issue in LangChain
      const stateUpdate = await middleware.beforeAgent?.({});
      expect(stateUpdate?.memoryContents).toBeDefined();

      // Step 2: Use loaded memory in wrapModelCall
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request: any = {
        systemPrompt: "You are a helpful assistant.",
        state: stateUpdate,
      };

      middleware.wrapModelCall!(request, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemPrompt).toContain("I prefer TypeScript");
      expect(modifiedRequest.systemPrompt).toContain("This is a React project");
      expect(modifiedRequest.systemPrompt).toContain(
        "You are a helpful assistant",
      );
    });
  });
});
