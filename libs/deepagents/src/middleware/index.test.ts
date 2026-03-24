import { describe, it, expect } from "vitest";
import { createAgent } from "langchain";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import { messagesStateReducer as addMessages } from "@langchain/langgraph";
import {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
} from "../index.js";

import { SAMPLE_MODEL } from "../testing/utils.js";
import {
  isSandboxBackend,
  type SandboxBackendProtocol,
} from "../backends/protocol.js";

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
    const lsTool = tools.find((t: StructuredTool) => t.name === "ls");
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
    const lsTool = tools.find((t: StructuredTool) => t.name === "ls");
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
    const executeTool = tools.find((t: StructuredTool) => t.name === "execute");
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
    } as unknown as SandboxBackendProtocol;

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
    expect(stateUpdate).toBeUndefined();
  });

  it("should patch a single missing tool call", async () => {
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
    expect(stateUpdate).toBeDefined();
    expect(stateUpdate.messages).toHaveLength(6);
    expect(stateUpdate.messages[0]._getType()).toBe("remove");
    expect(stateUpdate.messages[1]).toBe(inputMessages[0]);
    expect(stateUpdate.messages[2]).toBe(inputMessages[1]);
    expect(stateUpdate.messages[3]).toBe(inputMessages[2]);
    expect(stateUpdate.messages[4]._getType()).toBe("tool");
    expect((stateUpdate.messages[4] as any).tool_call_id).toBe("123");
    expect((stateUpdate.messages[4] as any).name).toBe("get_events_for_days");
    expect((stateUpdate.messages[4] as any).content).toContain("cancelled");
    expect(stateUpdate.messages[5]).toBe(inputMessages[3]);

    const updatedMessages = addMessages(inputMessages, stateUpdate.messages);
    expect(updatedMessages).toHaveLength(5);
    expect(updatedMessages[0]).toBe(inputMessages[0]);
    expect(updatedMessages[1]).toBe(inputMessages[1]);
    expect(updatedMessages[2]).toBe(inputMessages[2]);
    expect(updatedMessages[3]._getType()).toBe("tool");
    expect((updatedMessages[3] as any).tool_call_id).toBe("123");
    expect(updatedMessages[4]).toBe(inputMessages[3]);
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

    expect(stateUpdate).toBeUndefined();
  });

  it("should patch multiple missing tool calls", async () => {
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

    expect(stateUpdate).toBeDefined();
    expect(stateUpdate.messages).toHaveLength(9);
    expect(stateUpdate.messages[0]._getType()).toBe("remove");
    expect(stateUpdate.messages[1]).toBe(inputMessages[0]);
    expect(stateUpdate.messages[2]).toBe(inputMessages[1]);
    expect(stateUpdate.messages[3]).toBe(inputMessages[2]);
    expect(stateUpdate.messages[4]._getType()).toBe("tool");
    expect((stateUpdate.messages[4] as any).tool_call_id).toBe("123");
    expect(stateUpdate.messages[5]).toBe(inputMessages[3]);
    expect(stateUpdate.messages[6]).toBe(inputMessages[4]);
    expect(stateUpdate.messages[7]._getType()).toBe("tool");
    expect((stateUpdate.messages[7] as any).tool_call_id).toBe("456");
    expect(stateUpdate.messages[8]).toBe(inputMessages[5]);

    const updatedMessages = addMessages(inputMessages, stateUpdate.messages);
    expect(updatedMessages).toHaveLength(8);
    expect(updatedMessages[0]).toBe(inputMessages[0]);
    expect(updatedMessages[1]).toBe(inputMessages[1]);
    expect(updatedMessages[2]).toBe(inputMessages[2]);
    expect(updatedMessages[3].type).toBe("tool");
    expect((updatedMessages[3] as any).tool_call_id).toBe("123");
    expect(updatedMessages[4]).toBe(inputMessages[3]);
    expect(updatedMessages[5]).toBe(inputMessages[4]);
    expect(updatedMessages[6].type).toBe("tool");
    expect((updatedMessages[6] as any).tool_call_id).toBe("456");
    expect(updatedMessages[7]).toBe(inputMessages[5]);
  });
});
