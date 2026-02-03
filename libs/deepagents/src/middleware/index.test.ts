import { describe, it, expect } from "vitest";
import { createAgent } from "langchain";
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
} from "../index.js";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { messagesStateReducer as addMessages } from "@langchain/langgraph";

import { SAMPLE_MODEL } from "../testing/utils.js";

describe("Middleware Integration", () => {
  it("should add filesystem middleware to agent", () => {
    const middleware = [createFilesystemMiddleware()];
    const agent = createAgent({
      model: SAMPLE_MODEL,
      middleware,
      tools: [],
    });
    const channels = Object.keys((agent as any).graph?.channels || {});
    expect(channels).toContain("files");
    const tools = (agent as any).graph?.nodes?.tools?.bound?.tools || [];
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("ls");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("edit_file");
  });

  it("should add subagent middleware to agent", () => {
    const middleware = [
      createSubAgentMiddleware({
        defaultModel: SAMPLE_MODEL,
        defaultTools: [],
        subagents: [],
      }),
    ];
    const agent = createAgent({
      model: SAMPLE_MODEL,
      middleware,
      tools: [],
    });

    const tools = (agent as any).graph?.nodes?.tools?.bound?.tools || [];
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("task");
  });

  it("should add multiple middleware to agent", () => {
    const middleware = [
      createFilesystemMiddleware(),
      createSubAgentMiddleware({
        defaultModel: SAMPLE_MODEL,
        defaultTools: [],
        subagents: [],
      }),
    ];
    const agent = createAgent({
      model: SAMPLE_MODEL,
      middleware,
      tools: [],
    });
    const channels = Object.keys((agent as any).graph?.channels || {});
    expect(channels).toContain("files");
    const tools = (agent as any).graph?.nodes?.tools?.bound?.tools || [];
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("ls");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("edit_file");
    expect(toolNames).toContain("task");
  });
});

describe("FilesystemMiddleware", () => {
  it("should initialize with default backend (StateBackend)", () => {
    const middleware = createFilesystemMiddleware();
    expect(middleware).toBeDefined();
    expect(middleware.name).toBe("FilesystemMiddleware");
    const tools = middleware.tools || [];
    expect(tools.length).toBeGreaterThanOrEqual(6); // ls, read, write, edit, glob, grep
    expect(tools.map((t) => t.name)).toContain("ls");
    expect(tools.map((t) => t.name)).toContain("read_file");
    expect(tools.map((t) => t.name)).toContain("write_file");
    expect(tools.map((t) => t.name)).toContain("edit_file");
    expect(tools.map((t) => t.name)).toContain("glob");
    expect(tools.map((t) => t.name)).toContain("grep");
  });

  it("should include execute tool in tools list", () => {
    const middleware = createFilesystemMiddleware();
    const tools = middleware.tools || [];
    expect(tools.map((t) => t.name)).toContain("execute");
  });

  it("should initialize with custom backend", () => {
    const middleware = createFilesystemMiddleware({
      backend: undefined, // Will use default StateBackend
    });
    expect(middleware).toBeDefined();
    expect(middleware.name).toBe("FilesystemMiddleware");
    const tools = middleware.tools || [];
    expect(tools.length).toBeGreaterThanOrEqual(6);
  });

  it("should use custom tool descriptions", () => {
    const customDesc = "Custom ls tool description";
    const middleware = createFilesystemMiddleware({
      customToolDescriptions: {
        ls: customDesc,
      },
    });
    expect(middleware).toBeDefined();
    const tools = middleware.tools || [];
    const lsTool = tools.find((t) => t.name === "ls");
    expect(lsTool).toBeDefined();
    expect(lsTool?.description).toBe(customDesc);
  });

  it("should use custom tool descriptions with backend factory", () => {
    const customDesc = "Custom ls tool description";
    const middleware = createFilesystemMiddleware({
      backend: undefined, // Will use default
      customToolDescriptions: {
        ls: customDesc,
      },
    });
    expect(middleware).toBeDefined();
    const tools = middleware.tools || [];
    const lsTool = tools.find((t) => t.name === "ls");
    expect(lsTool).toBeDefined();
    expect(lsTool?.description).toBe(customDesc);
  });
});

describe("SubAgentMiddleware", () => {
  it("should initialize with default settings", () => {
    const middleware = createSubAgentMiddleware({
      defaultModel: SAMPLE_MODEL,
    });
    expect(middleware).toBeDefined();
    expect(middleware.name).toBe("subAgentMiddleware");
    const tools = middleware.tools || [];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("task");
    expect(tools[0]?.description).toContain("general-purpose");
  });

  it("should initialize with default tools", () => {
    const middleware = createSubAgentMiddleware({
      defaultModel: SAMPLE_MODEL,
      defaultTools: [],
    });
    expect(middleware).toBeDefined();
    const tools = middleware.tools || [];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("task");
  });
});

describe("Execute Tool", () => {
  it("should include execute tool description", () => {
    const middleware = createFilesystemMiddleware();
    const tools = middleware.tools || [];
    const executeTool = tools.find((t) => t.name === "execute");
    expect(executeTool).toBeDefined();
    expect(executeTool?.description).toContain("sandbox");
    expect(executeTool?.description).toContain("command");
  });

  it("should export EXECUTE_TOOL_DESCRIPTION constant", async () => {
    const { EXECUTE_TOOL_DESCRIPTION } = await import("./fs.js");
    expect(EXECUTE_TOOL_DESCRIPTION).toBeDefined();
    expect(EXECUTE_TOOL_DESCRIPTION).toContain("sandbox");
  });

  it("should export EXECUTION_SYSTEM_PROMPT constant", async () => {
    const { EXECUTION_SYSTEM_PROMPT } = await import("./fs.js");
    expect(EXECUTION_SYSTEM_PROMPT).toBeDefined();
    expect(EXECUTION_SYSTEM_PROMPT).toContain("execute");
  });
});

describe("isSandboxBackend type guard", () => {
  it("should return true for backends with execute and id", async () => {
    const { isSandboxBackend } = await import("../backends/protocol.js");

    const mockSandbox = {
      execute: () => ({ output: "", exitCode: 0, truncated: false }),
      id: "test-sandbox",
      lsInfo: () => [],
      read: () => "",
      grepRaw: () => [],
      globInfo: () => [],
      write: () => ({}),
      edit: () => ({}),
      uploadFiles: () => [],
      downloadFiles: () => [],
    };

    expect(isSandboxBackend(mockSandbox)).toBe(true);
  });

  it("should return false for backends without execute", async () => {
    const { isSandboxBackend } = await import("../backends/protocol.js");
    const { StateBackend } = await import("../backends/state.js");

    const stateAndStore = { state: { files: {} }, store: undefined };
    const stateBackend = new StateBackend(stateAndStore);

    expect(isSandboxBackend(stateBackend)).toBe(false);
  });

  it("should return false for backends without id", async () => {
    const { isSandboxBackend } = await import("../backends/protocol.js");

    const mockBackend = {
      execute: () => ({ output: "", exitCode: 0, truncated: false }),
      // Missing id
      lsInfo: () => [],
      read: () => "",
      grepRaw: () => [],
      globInfo: () => [],
      write: () => ({}),
      edit: () => ({}),
      uploadFiles: () => [],
      downloadFiles: () => [],
    };

    expect(isSandboxBackend(mockBackend as any)).toBe(false);
  });
});

describe("PatchToolCallsMiddleware", () => {
  it("should pass through messages without tool calls", async () => {
    const inputMessages = [
      new SystemMessage({ content: "You are a helpful assistant.", id: "1" }),
      new HumanMessage({ content: "Hello, how are you?", id: "2" }),
    ];
    const middleware = createPatchToolCallsMiddleware();
    const beforeAgentHook = (middleware as any).beforeAgent;
    const stateUpdate = await beforeAgentHook({
      messages: inputMessages,
    });
    // No patching needed, so returns undefined (no state changes)
    expect(stateUpdate).toBeUndefined();
  });

  it("should return undefined when no ToolMessages present (normal pre-execution flow)", async () => {
    // Without any ToolMessages, this is considered normal pre-execution flow
    // The middleware should NOT patch in this case
    const inputMessages = [
      new SystemMessage({ content: "You are a helpful assistant.", id: "1" }),
      new HumanMessage({ content: "Hello, how are you?", id: "2" }),
      new AIMessage({
        content: "I'm doing well, thank you!",
        tool_calls: [
          {
            id: "123",
            name: "get_events_for_days",
            args: { date_str: "2025-01-01" },
          },
        ],
        id: "3",
      }),
      new HumanMessage({ content: "What is the weather in Tokyo?", id: "4" }),
    ];

    const middleware = createPatchToolCallsMiddleware();
    const beforeAgentHook = (middleware as any).beforeAgent;
    const stateUpdate = await beforeAgentHook({
      messages: inputMessages,
    });
    // No ToolMessages present, so no patching (normal flow)
    expect(stateUpdate).toBeUndefined();
  });

  it("should patch dangling tool call in HITL rejection scenario", async () => {
    // This represents HITL rejection: parallel tool calls where one got a response
    // but another is dangling (needs synthetic message)
    const inputMessages = [
      new SystemMessage({ content: "You are a helpful assistant.", id: "1" }),
      new HumanMessage({ content: "Hello, how are you?", id: "2" }),
      new AIMessage({
        content: "I'm doing well, thank you!",
        tool_calls: [
          {
            id: "123",
            name: "get_events_for_days",
            args: { date_str: "2025-01-01" },
          },
          {
            id: "456",
            name: "get_weather",
            args: { city: "Tokyo" },
          },
        ],
        id: "3",
      }),
      // Only one tool got a response (the other was rejected/cancelled)
      new ToolMessage({
        content: "Rejected by user",
        tool_call_id: "456",
        id: "4",
      }),
      new HumanMessage({ content: "What is the weather in Tokyo?", id: "5" }),
    ];

    const middleware = createPatchToolCallsMiddleware();
    const beforeAgentHook = (middleware as any).beforeAgent;
    const stateUpdate = await beforeAgentHook({
      messages: inputMessages,
    });
    expect(stateUpdate).toBeDefined();
    // RemoveMessage + 5 original + 1 synthetic = 7
    expect(stateUpdate.messages).toHaveLength(7);
    expect(stateUpdate.messages[0]._getType()).toBe("remove");

    // Find the synthetic ToolMessage for the dangling call
    const syntheticToolMsg = stateUpdate.messages.find(
      (m: any) =>
        ToolMessage.isInstance(m) &&
        m.tool_call_id === "123" &&
        typeof m.content === "string" &&
        m.content.includes("cancelled"),
    );
    expect(syntheticToolMsg).toBeDefined();
    expect((syntheticToolMsg as any).name).toBe("get_events_for_days");
  });

  it("should not patch when tool message exists", async () => {
    const inputMessages = [
      new SystemMessage({ content: "You are a helpful assistant.", id: "1" }),
      new HumanMessage({ content: "Hello, how are you?", id: "2" }),
      new AIMessage({
        content: "I'm doing well, thank you!",
        tool_calls: [
          {
            id: "123",
            name: "get_events_for_days",
            args: { date_str: "2025-01-01" },
          },
        ],
        id: "3",
      }),
      new ToolMessage({
        content: "I have no events for that date.",
        tool_call_id: "123",
        id: "4",
      }),
      new HumanMessage({ content: "What is the weather in Tokyo?", id: "5" }),
    ];

    const middleware = createPatchToolCallsMiddleware();
    const beforeAgentHook = (middleware as any).beforeAgent;
    const stateUpdate = await beforeAgentHook({
      messages: inputMessages,
    });

    // No patching needed (tool message exists), so returns undefined (no state changes)
    expect(stateUpdate).toBeUndefined();
  });

  it("should return undefined when multiple dangling calls but no ToolMessages", async () => {
    // Without any ToolMessages, this is normal pre-execution flow
    const inputMessages = [
      new SystemMessage({ content: "You are a helpful assistant.", id: "1" }),
      new HumanMessage({ content: "Hello, how are you?", id: "2" }),
      new AIMessage({
        content: "I'm doing well, thank you!",
        tool_calls: [
          {
            id: "123",
            name: "get_events_for_days",
            args: { date_str: "2025-01-01" },
          },
        ],
        id: "3",
      }),
      new HumanMessage({ content: "What is the weather in Tokyo?", id: "4" }),
      new AIMessage({
        content: "I'm doing well, thank you!",
        tool_calls: [
          {
            id: "456",
            name: "get_events_for_days",
            args: { date_str: "2025-01-01" },
          },
        ],
        id: "5",
      }),
      new HumanMessage({ content: "What is the weather in Tokyo?", id: "6" }),
    ];
    const middleware = createPatchToolCallsMiddleware();
    const beforeAgentHook = (middleware as any).beforeAgent;
    const stateUpdate = await beforeAgentHook({
      messages: inputMessages,
    });

    // No ToolMessages present, so no patching (normal flow)
    expect(stateUpdate).toBeUndefined();
  });

  it("should NOT patch second AIMessage when its tool calls have no response", async () => {
    // This tests that we only patch when an AIMessage has PARTIAL responses
    // The second AIMessage has no responses for any of its tool_calls,
    // so it should not be patched (even though another AIMessage has responses)
    const inputMessages = [
      new SystemMessage({ content: "You are a helpful assistant.", id: "1" }),
      new HumanMessage({ content: "Hello, how are you?", id: "2" }),
      new AIMessage({
        content: "I'm doing well, thank you!",
        tool_calls: [
          {
            id: "123",
            name: "get_events_for_days",
            args: { date_str: "2025-01-01" },
          },
        ],
        id: "3",
      }),
      // First AIMessage's call got a response (complete)
      new ToolMessage({
        content: "Events for that day",
        tool_call_id: "123",
        id: "3a",
      }),
      new HumanMessage({ content: "What is the weather in Tokyo?", id: "4" }),
      new AIMessage({
        content: "I'm doing well, thank you!",
        tool_calls: [
          {
            id: "456",
            name: "get_weather",
            args: { city: "Tokyo" },
          },
        ],
        id: "5",
      }),
      // Second AIMessage's call has no response yet (normal pre-execution)
      new HumanMessage({ content: "What is the weather in Tokyo?", id: "6" }),
    ];
    const middleware = createPatchToolCallsMiddleware();
    const beforeAgentHook = (middleware as any).beforeAgent;
    const stateUpdate = await beforeAgentHook({
      messages: inputMessages,
    });

    // Second AIMessage has no partial responses - this is normal flow
    // Only patch when an AIMessage has PARTIAL responses (HITL rejection scenario)
    expect(stateUpdate).toBeUndefined();
  });
});
