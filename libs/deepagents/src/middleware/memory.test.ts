import { describe, it, expect, vi } from "vitest";
import { createMemoryMiddleware } from "./memory.js";
import { createDeepAgent } from "../agent.js";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createFileData } from "../backends/utils.js";
import { createMockBackend } from "./test.js";

describe("createMemoryMiddleware", () => {
  describe("beforeAgent", () => {
    it("should load memory content from configured sources", async () => {
      const mockBackend = createMockBackend({
        files: {
          "~/.deepagents/AGENTS.md": "# User Memory\n\nThis is user memory.",
          "./.deepagents/AGENTS.md":
            "# Project Memory\n\nThis is project memory.",
        },
        directories: {
          "~/.deepagents/": [{ name: "AGENTS.md", type: "file" }],
          "./.deepagents/": [{ name: "AGENTS.md", type: "file" }],
        },
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
        files: {
          "~/.deepagents/AGENTS.md": "# User Memory",
        },
        directories: {
          "~/.deepagents/": [{ name: "AGENTS.md", type: "file" }],
        },
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
        files: {
          "~/.deepagents/AGENTS.md": "Should not load this",
        },
        directories: {
          "~/.deepagents/": [{ name: "AGENTS.md", type: "file" }],
        },
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
        files: {
          "/memory/AGENTS.md": "# Factory Memory",
        },
        directories: {
          "/memory/": [{ name: "AGENTS.md", type: "file" }],
        },
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
        systemMessage: new SystemMessage("Base prompt"),
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
      expect(modifiedRequest.systemMessage.text).toContain("<agent_memory>");
      expect(modifiedRequest.systemMessage.text).toContain("</agent_memory>");
      expect(modifiedRequest.systemMessage.text).toContain(
        "<memory_guidelines>",
      );
      expect(modifiedRequest.systemMessage.text).toContain(
        "User memory content",
      );
      expect(modifiedRequest.systemMessage.text).toContain(
        "Project memory content",
      );
      expect(modifiedRequest.systemMessage.text).toContain(
        "~/.deepagents/AGENTS.md",
      );
      expect(modifiedRequest.systemMessage.text).toContain(
        "./.deepagents/AGENTS.md",
      );
    });

    it("should show (No memory loaded) when no content", () => {
      const middleware = createMemoryMiddleware({
        backend: createMockBackend({}),
        sources: ["~/.deepagents/AGENTS.md"],
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request = {
        systemMessage: new SystemMessage("Base prompt"),
        state: { memoryContents: {} },
      };

      middleware.wrapModelCall!(request as any, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemMessage.text).toContain(
        "(No memory loaded)",
      );
    });

    it("should prepend memory section to existing system prompt", () => {
      const middleware = createMemoryMiddleware({
        backend: createMockBackend({}),
        sources: [],
      });

      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });
      const request = {
        systemMessage: new SystemMessage("Original system prompt content"),
        state: { memoryContents: {} },
      };

      middleware.wrapModelCall!(request as any, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      // Memory section should come before the original prompt
      const memoryIndex =
        modifiedRequest.systemMessage.text.indexOf("Agent Memory");
      const originalIndex = modifiedRequest.systemMessage.text.indexOf(
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
        systemMessage: new SystemMessage("Base prompt"),
        state: {},
      };

      middleware.wrapModelCall!(request as any, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemMessage.text).toContain(
        "(No memory loaded)",
      );
    });
  });

  describe("integration", () => {
    it("should work end-to-end: load memory and inject into prompt", async () => {
      const mockBackend = createMockBackend({
        files: {
          "~/.deepagents/AGENTS.md":
            "# User Agent Memory\n\nI prefer TypeScript.",
          "./project/AGENTS.md": "# Project Memory\n\nThis is a React project.",
        },
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
        systemMessage: new SystemMessage("You are a helpful assistant."),
        state: stateUpdate,
      };

      middleware.wrapModelCall!(request, mockHandler);

      const modifiedRequest = mockHandler.mock.calls[0][0];
      expect(modifiedRequest.systemMessage.text).toContain(
        "I prefer TypeScript",
      );
      expect(modifiedRequest.systemMessage.text).toContain(
        "This is a React project",
      );
      expect(modifiedRequest.systemMessage.text).toContain(
        "You are a helpful assistant",
      );
    });
  });
});

/**
 * StateBackend integration tests.
 *
 * These tests verify that memory is properly loaded from state.files and
 * injected into the system prompt when using createDeepAgent with StateBackend.
 */
describe("StateBackend integration with createDeepAgent", () => {
  const USER_MEMORY = `# User Memory

Remember: The secret code is ALPHA123.`;

  const PROJECT_MEMORY = `# Project Memory

This project uses React.`;

  /**
   * Helper to extract system prompt content from model invoke spy.
   * The system message can have content as string or array of content blocks.
   */
  function getSystemPromptFromSpy(
    invokeSpy: ReturnType<typeof vi.spyOn>,
  ): string {
    const lastCall = invokeSpy.mock.calls[invokeSpy.mock.calls.length - 1];
    const messages = lastCall?.[0] as BaseMessage[] | undefined;
    if (!messages) return "";
    const systemMessage = messages.find(SystemMessage.isInstance);
    if (!systemMessage) return "";
    return systemMessage.text;
  }

  it("should load memory from state.files and inject into system prompt", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const model = new FakeListChatModel({ responses: ["Done"] });
    const checkpointer = new MemorySaver();

    const agent = createDeepAgent({
      model: model as any,
      memory: ["/AGENTS.md"],
      checkpointer,
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("What do you remember?")],
        files: {
          "/AGENTS.md": createFileData(USER_MEMORY),
        },
      },
      {
        configurable: { thread_id: `test-memory-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    expect(invokeSpy).toHaveBeenCalled();
    const systemPrompt = getSystemPromptFromSpy(invokeSpy);

    expect(systemPrompt).toContain("ALPHA123");
    expect(systemPrompt).toContain("/AGENTS.md");
    invokeSpy.mockRestore();
  });

  it("should load multiple memory files from state.files", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const model = new FakeListChatModel({ responses: ["Done"] });
    const checkpointer = new MemorySaver();

    const agent = createDeepAgent({
      model: model as any,
      memory: ["/user/AGENTS.md", "/project/AGENTS.md"],
      checkpointer,
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("List all memory")],
        files: {
          "/user/AGENTS.md": createFileData(USER_MEMORY),
          "/project/AGENTS.md": createFileData(PROJECT_MEMORY),
        },
      },
      {
        configurable: { thread_id: `test-memory-multi-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    expect(invokeSpy).toHaveBeenCalled();
    const systemPrompt = getSystemPromptFromSpy(invokeSpy);

    expect(systemPrompt).toContain("ALPHA123");
    expect(systemPrompt).toContain("This project uses React.");
    invokeSpy.mockRestore();
  });

  it("should show no memory message when state.files is empty", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const model = new FakeListChatModel({ responses: ["Done"] });
    const checkpointer = new MemorySaver();

    const agent = createDeepAgent({
      model: model as any,
      memory: ["/AGENTS.md"],
      checkpointer,
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("Hello")],
        files: {},
      },
      {
        configurable: { thread_id: `test-memory-empty-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    expect(invokeSpy).toHaveBeenCalled();
    const systemPrompt = getSystemPromptFromSpy(invokeSpy);

    expect(systemPrompt).toContain("(No memory loaded)");
    invokeSpy.mockRestore();
  });

  it("should load memory from multiple sources via StateBackend", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const model = new FakeListChatModel({ responses: ["Done"] });
    const checkpointer = new MemorySaver();

    const agent = createDeepAgent({
      model: model as any,
      memory: ["/memory/user/AGENTS.md", "/memory/project/AGENTS.md"],
      checkpointer,
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("List memory")],
        files: {
          "/memory/user/AGENTS.md": createFileData(USER_MEMORY),
          "/memory/project/AGENTS.md": createFileData(PROJECT_MEMORY),
        },
      },
      {
        configurable: { thread_id: `test-memory-sources-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    expect(invokeSpy).toHaveBeenCalled();
    const systemPrompt = getSystemPromptFromSpy(invokeSpy);

    expect(systemPrompt).toContain("/memory/user/AGENTS.md");
    expect(systemPrompt).toContain("/memory/project/AGENTS.md");
    invokeSpy.mockRestore();
  });

  it("should include memory paths in the system prompt", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const model = new FakeListChatModel({ responses: ["Done"] });
    const checkpointer = new MemorySaver();

    const agent = createDeepAgent({
      model: model as any,
      memory: ["/AGENTS.md"],
      checkpointer,
    });

    await agent.invoke(
      {
        messages: [new HumanMessage("What memory do you have?")],
        files: {
          "/AGENTS.md": createFileData(USER_MEMORY),
        },
      },
      {
        configurable: { thread_id: `test-memory-paths-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    expect(invokeSpy).toHaveBeenCalled();
    const systemPrompt = getSystemPromptFromSpy(invokeSpy);

    expect(systemPrompt).toContain("/AGENTS.md");
    expect(systemPrompt).toContain("<memory_guidelines>");
    invokeSpy.mockRestore();
  });

  it("should handle empty memory directory gracefully", async () => {
    const invokeSpy = vi.spyOn(FakeListChatModel.prototype, "invoke");
    const model = new FakeListChatModel({ responses: ["Done"] });
    const checkpointer = new MemorySaver();

    const agent = createDeepAgent({
      model: model as any,
      memory: ["/memory/empty/AGENTS.md"],
      checkpointer,
    });

    await expect(
      agent.invoke(
        {
          messages: [new HumanMessage("Hello")],
          files: {},
        },
        {
          configurable: {
            thread_id: `test-memory-empty-graceful-${Date.now()}`,
          },
          recursionLimit: 50,
        },
      ),
    ).resolves.toBeDefined();

    expect(invokeSpy).toHaveBeenCalled();
    const systemPrompt = getSystemPromptFromSpy(invokeSpy);

    expect(systemPrompt).toContain("(No memory loaded)");
    invokeSpy.mockRestore();
  });
});
