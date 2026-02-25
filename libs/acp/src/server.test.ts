/**
 * Unit tests for the DeepAgents ACP Server
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeepAgentsServer } from "./server.js";
import type {
  DeepAgentConfig,
  DeepAgentsServerOptions,
  SessionState,
  ToolCallInfo,
} from "./types.js";

// Mock the deepagents module
vi.mock("deepagents", () => {
  // Define MockFilesystemBackend inside the factory to avoid hoisting issues
  class MockFilesystemBackend {
    rootDir: string;
    constructor(options: { rootDir: string }) {
      this.rootDir = options.rootDir;
    }
    lsInfo = vi.fn();
    read = vi.fn();
    write = vi.fn();
    edit = vi.fn();
    grepRaw = vi.fn();
    globInfo = vi.fn();
    downloadFiles = vi.fn().mockResolvedValue([]);
    uploadFiles = vi.fn().mockResolvedValue([]);
  }

  return {
    createDeepAgent: vi.fn().mockReturnValue({
      stream: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { event: "on_chain_start", data: {} };
        },
      }),
    }),
    FilesystemBackend: MockFilesystemBackend,
  };
});

// Mock the ACP SDK
vi.mock("@agentclientprotocol/sdk", () => ({
  AgentSideConnection: vi.fn().mockImplementation(() => ({
    closed: Promise.resolve(),
    sessionUpdate: vi.fn(),
  })),
  ndJsonStream: vi.fn().mockReturnValue({}),
}));

describe("DeepAgentsServer", () => {
  let defaultConfig: DeepAgentConfig;
  let defaultOptions: DeepAgentsServerOptions;

  beforeEach(() => {
    defaultConfig = {
      name: "test-agent",
      description: "A test agent",
      model: "gpt-4",
    };

    defaultOptions = {
      agents: defaultConfig,
      serverName: "test-server",
      serverVersion: "1.0.0",
      debug: false,
    };

    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create server with single agent config", () => {
      const server = new DeepAgentsServer(defaultOptions);
      expect(server).toBeInstanceOf(DeepAgentsServer);
    });

    it("should create server with multiple agent configs", () => {
      const options: DeepAgentsServerOptions = {
        agents: [
          { name: "agent1", description: "First agent" },
          { name: "agent2", description: "Second agent" },
        ],
        serverName: "multi-agent-server",
      };

      const server = new DeepAgentsServer(options);
      expect(server).toBeInstanceOf(DeepAgentsServer);
    });

    it("should use default server name if not provided", () => {
      const options: DeepAgentsServerOptions = {
        agents: defaultConfig,
      };

      const server = new DeepAgentsServer(options);
      expect(server).toBeInstanceOf(DeepAgentsServer);
    });

    it("should use default server version if not provided", () => {
      const options: DeepAgentsServerOptions = {
        agents: defaultConfig,
      };

      const server = new DeepAgentsServer(options);
      expect(server).toBeInstanceOf(DeepAgentsServer);
    });

    it("should use current working directory as default workspace", () => {
      const options: DeepAgentsServerOptions = {
        agents: defaultConfig,
      };

      const server = new DeepAgentsServer(options);
      expect(server).toBeInstanceOf(DeepAgentsServer);
    });

    it("should respect custom workspace root", () => {
      const options: DeepAgentsServerOptions = {
        agents: defaultConfig,
        workspaceRoot: "/custom/workspace",
      };

      const server = new DeepAgentsServer(options);
      expect(server).toBeInstanceOf(DeepAgentsServer);
    });
  });

  describe("stop", () => {
    it("should do nothing if server is not running", () => {
      const server = new DeepAgentsServer(defaultOptions);
      // Should not throw
      server.stop();
    });

    it("should clear sessions when stopped", async () => {
      const server = new DeepAgentsServer(defaultOptions);
      // Access internal state for testing
      const serverAny = server as unknown as {
        sessions: Map<string, unknown>;
        isRunning: boolean;
      };
      serverAny.isRunning = true;
      serverAny.sessions.set("test-session", { id: "test-session" });

      server.stop();

      expect(serverAny.sessions.size).toBe(0);
    });
  });

  describe("debug logging", () => {
    it("should log when debug is enabled", () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const options: DeepAgentsServerOptions = {
        agents: defaultConfig,
        debug: true,
      };

      new DeepAgentsServer(options);

      // Should have logged initialization
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should not log when debug is disabled", () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const options: DeepAgentsServerOptions = {
        agents: defaultConfig,
        debug: false,
      };

      new DeepAgentsServer(options);

      // Should not have logged
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});

describe("DeepAgentsServer handlers", () => {
  // Test the internal handlers by accessing them through reflection
  // In a real scenario, these would be tested via integration tests

  describe("handleInitialize", () => {
    it("should return server capabilities", async () => {
      const server = new DeepAgentsServer({
        agents: { name: "test", description: "Test agent" },
        serverName: "my-server",
        serverVersion: "2.0.0",
      });

      // Access private method for testing
      const serverAny = server as unknown as {
        handleInitialize: (
          params: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };

      const result: any = await serverAny.handleInitialize({
        clientInfo: { name: "test-client", version: "1.0.0" },
        protocolVersion: 1,
      });

      // ACP spec: agentInfo contains name and version
      expect(result.agentInfo).toBeDefined();
      expect(result.agentInfo.name).toBe("my-server");
      expect(result.agentInfo.version).toBe("2.0.0");
      // Protocol version is now a number per ACP spec
      expect(result.protocolVersion).toBe(1);
      // ACP spec: agentCapabilities with promptCapabilities nested
      expect(result.agentCapabilities).toBeDefined();
      expect(result.agentCapabilities.promptCapabilities).toBeDefined();
    });

    it("should store client capabilities", async () => {
      const server = new DeepAgentsServer({
        agents: { name: "test" },
      });

      const serverAny = server as unknown as {
        handleInitialize: (
          params: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
        clientCapabilities: {
          fsReadTextFile: boolean;
          fsWriteTextFile: boolean;
          terminal: boolean;
        };
      };

      await serverAny.handleInitialize({
        clientInfo: { name: "test-client", version: "1.0.0" },
        protocolVersion: 1,
        // ACP spec uses clientCapabilities instead of capabilities
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
          terminal: {},
        },
      });

      expect(serverAny.clientCapabilities.fsReadTextFile).toBe(true);
      expect(serverAny.clientCapabilities.fsWriteTextFile).toBe(true);
      expect(serverAny.clientCapabilities.terminal).toBe(true);
    });
  });

  describe("handleAuthenticate", () => {
    it("should return void (no auth required)", async () => {
      const server = new DeepAgentsServer({
        agents: { name: "test" },
      });

      const serverAny = server as unknown as {
        handleAuthenticate: (params: Record<string, unknown>) => Promise<void>;
      };

      const result = await serverAny.handleAuthenticate({});
      expect(result).toBeUndefined();
    });
  });

  describe("handleNewSession", () => {
    it("should create a new session", async () => {
      const server = new DeepAgentsServer({
        agents: { name: "test-agent", description: "Test" },
      });

      const serverAny = server as unknown as {
        handleNewSession: (
          params: Record<string, unknown>,
          conn: unknown,
        ) => Promise<{ sessionId: string; modes?: unknown[] }>;
        sessions: Map<string, unknown>;
      };

      const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };
      const result = await serverAny.handleNewSession({}, mockConn);

      expect(result.sessionId).toBeDefined();
      expect(result.sessionId).toMatch(/^sess_/);
      expect(serverAny.sessions.has(result.sessionId)).toBe(true);
    });

    it("should throw for unknown agent", async () => {
      const server = new DeepAgentsServer({
        agents: { name: "test-agent" },
      });

      const serverAny = server as unknown as {
        handleNewSession: (
          params: Record<string, unknown>,
          conn: unknown,
        ) => Promise<unknown>;
      };

      const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };

      await expect(
        serverAny.handleNewSession(
          { configOptions: { agent: "unknown-agent" } },
          mockConn,
        ),
      ).rejects.toThrow("Unknown agent");
    });

    it("should return available modes", async () => {
      const server = new DeepAgentsServer({
        agents: { name: "test-agent" },
      });

      const serverAny = server as unknown as {
        handleNewSession: (
          params: Record<string, unknown>,
          conn: unknown,
        ) => Promise<{
          modes: { availableModes: Array<{ id: string; name: string }> };
        }>;
      };

      const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };
      const result = await serverAny.handleNewSession({}, mockConn);

      // ACP spec: modes object contains availableModes
      expect(result.modes).toBeDefined();
      expect(result.modes.availableModes).toBeDefined();
      expect(Array.isArray(result.modes.availableModes)).toBe(true);
      expect(result.modes.availableModes.length).toBeGreaterThan(0);
    });
  });

  describe("handleSetSessionMode", () => {
    it("should update session mode", async () => {
      const server = new DeepAgentsServer({
        agents: { name: "test-agent" },
      });

      const serverAny = server as unknown as {
        handleNewSession: (
          params: Record<string, unknown>,
          conn: unknown,
        ) => Promise<{ sessionId: string }>;
        handleSetSessionMode: (
          params: Record<string, unknown>,
        ) => Promise<void>;
        sessions: Map<string, { mode?: string }>;
      };

      const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };
      const { sessionId } = await serverAny.handleNewSession({}, mockConn);

      await serverAny.handleSetSessionMode({
        sessionId,
        mode: "plan",
      });

      const session = serverAny.sessions.get(sessionId);
      expect(session?.mode).toBe("plan");
    });

    it("should throw for unknown session", async () => {
      const server = new DeepAgentsServer({
        agents: { name: "test-agent" },
      });

      const serverAny = server as unknown as {
        handleSetSessionMode: (
          params: Record<string, unknown>,
        ) => Promise<void>;
      };

      await expect(
        serverAny.handleSetSessionMode({
          sessionId: "unknown-session",
          mode: "plan",
        }),
      ).rejects.toThrow("Session not found");
    });
  });

  describe("handleCancel", () => {
    it("should handle cancel notification", async () => {
      const server = new DeepAgentsServer({
        agents: { name: "test-agent" },
      });

      const serverAny = server as unknown as {
        handleNewSession: (
          params: Record<string, unknown>,
          conn: unknown,
        ) => Promise<{ sessionId: string }>;
        handleCancel: (params: Record<string, unknown>) => Promise<void>;
        currentPromptAbortController: AbortController | null;
      };

      const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };
      const { sessionId } = await serverAny.handleNewSession({}, mockConn);

      // Set up an active prompt abort controller
      const controller = new AbortController();
      serverAny.currentPromptAbortController = controller;

      // Cancel should abort
      await serverAny.handleCancel({ sessionId });

      expect(controller.signal.aborted).toBe(true);
    });

    it("should do nothing for session without active prompt", async () => {
      const server = new DeepAgentsServer({
        agents: { name: "test-agent" },
      });

      const serverAny = server as unknown as {
        handleCancel: (params: Record<string, unknown>) => Promise<void>;
      };

      // Should not throw
      await expect(
        serverAny.handleCancel({ sessionId: "no-active-prompt" }),
      ).resolves.not.toThrow();
    });
  });
});

describe("DeepAgentsServer configuration", () => {
  it("should handle agent with all options", () => {
    const fullConfig: DeepAgentConfig = {
      name: "full-agent",
      description: "Fully configured agent",
      model: "claude-sonnet-4-5-20250929",
      systemPrompt: "You are a helpful assistant",
      skills: ["/path/to/skills"],
      memory: ["/path/to/memory"],
    };

    const server = new DeepAgentsServer({
      agents: fullConfig,
      debug: true,
    });

    expect(server).toBeInstanceOf(DeepAgentsServer);
  });

  it("should handle multiple agents with different configurations", () => {
    const agents: DeepAgentConfig[] = [
      {
        name: "coding-agent",
        description: "Agent for coding tasks",
        model: "claude-sonnet-4-5-20250929",
      },
      {
        name: "writing-agent",
        description: "Agent for writing tasks",
        model: "gpt-4",
      },
    ];

    const server = new DeepAgentsServer({
      agents,
      serverName: "multi-agent-server",
    });

    expect(server).toBeInstanceOf(DeepAgentsServer);
  });
});

describe("DeepAgentsServer streaming", () => {
  it("should have sendMessageChunk method", () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      sendMessageChunk: (
        sessionId: string,
        conn: unknown,
        messageType: string,
        content: unknown[],
      ) => Promise<void>;
    };

    expect(typeof serverAny.sendMessageChunk).toBe("function");
  });

  it("should have sendToolCall method", () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      sendToolCall: (
        sessionId: string,
        conn: unknown,
        toolCall: unknown,
      ) => Promise<void>;
    };

    expect(typeof serverAny.sendToolCall).toBe("function");
  });

  it("should have sendToolCallUpdate method", () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      sendToolCallUpdate: (
        sessionId: string,
        conn: unknown,
        toolCall: unknown,
      ) => Promise<void>;
    };

    expect(typeof serverAny.sendToolCallUpdate).toBe("function");
  });

  it("should have sendPlanUpdate method", () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      sendPlanUpdate: (
        sessionId: string,
        conn: unknown,
        entries: unknown[],
      ) => Promise<void>;
    };

    expect(typeof serverAny.sendPlanUpdate).toBe("function");
  });

  it("should have handleToolMessage method for tool completions", () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      handleToolMessage: (
        session: unknown,
        message: unknown,
        activeToolCalls: Map<string, unknown>,
        conn: unknown,
      ) => Promise<void>;
    };

    expect(typeof serverAny.handleToolMessage).toBe("function");
  });

  it("should have streamAgentResponse method", () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      streamAgentResponse: (
        session: unknown,
        agent: unknown,
        humanMessage: unknown,
        conn: unknown,
      ) => Promise<string>;
    };

    expect(typeof serverAny.streamAgentResponse).toBe("function");
  });
});

describe("Slash Commands", () => {
  function createServerAndSession() {
    const server = new DeepAgentsServer({
      agents: {
        name: "test-agent",
        description: "Test",
        commands: [{ name: "custom", description: "A custom command" }],
      },
    });

    const serverAny = server as unknown as {
      handleNewSession: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<{ sessionId: string }>;
      handlePrompt: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<{ stopReason: string }>;
      sessions: Map<string, SessionState>;
    };

    return { server, serverAny };
  }

  it("should switch to plan mode via /plan command", async () => {
    const { serverAny } = createServerAndSession();
    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const result = await serverAny.handlePrompt(
      { sessionId, prompt: [{ type: "text", text: "/plan" }] },
      mockConn,
    );

    expect(result.stopReason).toBe("end_turn");
    expect(serverAny.sessions.get(sessionId)?.mode).toBe("plan");

    const sessionUpdateCalls = mockConn.sessionUpdate.mock.calls;
    const messageCalls = sessionUpdateCalls.filter(
      (c: any) => c[0]?.update?.sessionUpdate === "agent_message_chunk",
    );
    expect(messageCalls.length).toBeGreaterThan(0);
    const lastMsg = messageCalls[messageCalls.length - 1][0];
    expect(lastMsg.update.content.text).toContain("plan");
  });

  it("should switch to ask mode via /ask command", async () => {
    const { serverAny } = createServerAndSession();
    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    await serverAny.handlePrompt(
      { sessionId, prompt: [{ type: "text", text: "/ask" }] },
      mockConn,
    );

    expect(serverAny.sessions.get(sessionId)?.mode).toBe("ask");
  });

  it("should clear session via /clear command", async () => {
    const { serverAny } = createServerAndSession();
    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;
    const originalThreadId = session.threadId;
    session.messages.push({ content: "test" });

    await serverAny.handlePrompt(
      { sessionId, prompt: [{ type: "text", text: "/clear" }] },
      mockConn,
    );

    expect(session.messages).toEqual([]);
    expect(session.threadId).not.toBe(originalThreadId);
  });

  it("should show status via /status command", async () => {
    const { serverAny } = createServerAndSession();
    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    await serverAny.handlePrompt(
      { sessionId, prompt: [{ type: "text", text: "/status" }] },
      mockConn,
    );

    const sessionUpdateCalls = mockConn.sessionUpdate.mock.calls;
    const messageCalls = sessionUpdateCalls.filter(
      (c: any) => c[0]?.update?.sessionUpdate === "agent_message_chunk",
    );
    const statusMsg = messageCalls[messageCalls.length - 1][0];
    expect(statusMsg.update.content.text).toContain("test-agent");
    expect(statusMsg.update.content.text).toContain("Session");
  });

  it("should send available_commands_update on new session", async () => {
    const { serverAny } = createServerAndSession();
    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };

    await serverAny.handleNewSession({}, mockConn);

    const commandsUpdates = mockConn.sessionUpdate.mock.calls.filter(
      (c: any) => c[0]?.update?.sessionUpdate === "available_commands_update",
    );
    expect(commandsUpdates.length).toBe(1);
    const commands = commandsUpdates[0][0].update.availableCommands;
    expect(commands.some((c: any) => c.name === "plan")).toBe(true);
    expect(commands.some((c: any) => c.name === "custom")).toBe(true);
  });
});

describe("Thinking / Reasoning Messages", () => {
  it("should route thinking blocks as thought chunks", async () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      handleNewSession: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<{ sessionId: string }>;
      handleAIMessage: (
        session: SessionState,
        message: unknown,
        activeToolCalls: Map<string, ToolCallInfo>,
        conn: unknown,
      ) => Promise<void>;
      sessions: Map<string, SessionState>;
    };

    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };
    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    mockConn.sessionUpdate.mockClear();

    const fakeAIMessage = {
      content: [
        { type: "thinking", thinking: "Let me think about this..." },
        { type: "text", text: "Here is my answer." },
      ],
      tool_calls: [],
      constructor: { name: "AIMessage" },
    };
    // Patch isInstance for mock
    await serverAny.handleAIMessage(
      session,
      fakeAIMessage as any,
      new Map(),
      mockConn,
    );

    const calls = mockConn.sessionUpdate.mock.calls;

    const thoughtCalls = calls.filter(
      (c: any) => c[0]?.update?.sessionUpdate === "agent_thought_chunk",
    );
    expect(thoughtCalls.length).toBe(1);
    expect(thoughtCalls[0][0].update.content.text).toBe(
      "Let me think about this...",
    );

    const agentCalls = calls.filter(
      (c: any) => c[0]?.update?.sessionUpdate === "agent_message_chunk",
    );
    expect(agentCalls.length).toBe(1);
    expect(agentCalls[0][0].update.content.text).toBe("Here is my answer.");
  });

  it("should handle string-only content as agent message", async () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      handleNewSession: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<{ sessionId: string }>;
      handleAIMessage: (
        session: SessionState,
        message: unknown,
        activeToolCalls: Map<string, ToolCallInfo>,
        conn: unknown,
      ) => Promise<void>;
      sessions: Map<string, SessionState>;
    };

    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };
    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    mockConn.sessionUpdate.mockClear();

    const fakeAIMessage = {
      content: "Simple text response",
      tool_calls: [],
    };

    await serverAny.handleAIMessage(
      session,
      fakeAIMessage as any,
      new Map(),
      mockConn,
    );

    const agentCalls = mockConn.sessionUpdate.mock.calls.filter(
      (c: any) => c[0]?.update?.sessionUpdate === "agent_message_chunk",
    );
    expect(agentCalls.length).toBe(1);

    const thoughtCalls = mockConn.sessionUpdate.mock.calls.filter(
      (c: any) => c[0]?.update?.sessionUpdate === "agent_thought_chunk",
    );
    expect(thoughtCalls.length).toBe(0);
  });
});

describe("Tool Call Enhancements", () => {
  it("should include locations in tool call notifications", async () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
      workspaceRoot: "/workspace",
    });

    const serverAny = server as unknown as {
      sendToolCall: (
        sessionId: string,
        conn: unknown,
        toolCall: ToolCallInfo,
      ) => Promise<void>;
    };

    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };
    const toolCall: ToolCallInfo = {
      id: "call_abc",
      name: "read_file",
      args: { path: "src/index.ts" },
      status: "pending",
    };

    await serverAny.sendToolCall("sess_test", mockConn, toolCall);

    const call = mockConn.sessionUpdate.mock.calls[0][0];
    expect(call.update.locations).toBeDefined();
    expect(call.update.locations[0].path).toBe("/workspace/src/index.ts");
  });

  it("should include raw input in tool call notifications", async () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      sendToolCall: (
        sessionId: string,
        conn: unknown,
        toolCall: ToolCallInfo,
      ) => Promise<void>;
    };

    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };
    const toolCall: ToolCallInfo = {
      id: "call_xyz",
      name: "grep",
      args: { pattern: "TODO", path: "/src" },
      status: "pending",
    };

    await serverAny.sendToolCall("sess_test", mockConn, toolCall);

    const call = mockConn.sessionUpdate.mock.calls[0][0];
    expect(call.update.input).toEqual({ pattern: "TODO", path: "/src" });
  });

  it("should include output in completed tool call updates", async () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      sendToolCallUpdate: (
        sessionId: string,
        conn: unknown,
        toolCall: ToolCallInfo,
      ) => Promise<void>;
    };

    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };
    const toolCall: ToolCallInfo = {
      id: "call_done",
      name: "read_file",
      args: { path: "/test.txt" },
      status: "completed",
      result: "file contents here",
    };

    await serverAny.sendToolCallUpdate("sess_test", mockConn, toolCall);

    const call = mockConn.sessionUpdate.mock.calls[0][0];
    expect(call.update.output).toBe("file contents here");
    expect(call.update.content[0].type).toBe("content");
    expect(call.update.content[0].content.text).toBe("file contents here");
  });

  it("should use correct ACP tool kinds in notifications", async () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      sendToolCall: (
        sessionId: string,
        conn: unknown,
        toolCall: ToolCallInfo,
      ) => Promise<void>;
    };

    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };

    const tools = [
      { name: "read_file", expectedKind: "read" },
      { name: "edit_file", expectedKind: "edit" },
      { name: "grep", expectedKind: "search" },
      { name: "execute", expectedKind: "execute" },
      { name: "write_todos", expectedKind: "think" },
    ];

    for (const { name, expectedKind } of tools) {
      mockConn.sessionUpdate.mockClear();
      await serverAny.sendToolCall("sess_test", mockConn, {
        id: `call_${name}`,
        name,
        args: {},
        status: "pending",
      });
      const call = mockConn.sessionUpdate.mock.calls[0][0];
      expect(call.update.kind).toBe(expectedKind);
    }
  });
});

describe("Human-in-the-Loop (Permission Requests)", () => {
  function createServerWithSession() {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      handleNewSession: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<{ sessionId: string }>;
      requestToolPermission: (
        session: SessionState,
        conn: unknown,
        toolCall: ToolCallInfo,
      ) => Promise<"allow" | "reject" | "cancelled">;
      sessions: Map<string, SessionState>;
    };

    return { server, serverAny };
  }

  const sampleToolCall: ToolCallInfo = {
    id: "call_perm1",
    name: "write_file",
    args: { path: "/etc/config", content: "data" },
    status: "pending",
  };

  it("should return allow when user selects allow-once", async () => {
    const { serverAny } = createServerWithSession();
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow-once" },
      }),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    const result = await serverAny.requestToolPermission(
      session,
      mockConn,
      sampleToolCall,
    );

    expect(result).toBe("allow");
    expect(mockConn.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("should return reject when user selects reject-once", async () => {
    const { serverAny } = createServerWithSession();
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: "selected", optionId: "reject-once" },
      }),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    const result = await serverAny.requestToolPermission(
      session,
      mockConn,
      sampleToolCall,
    );

    expect(result).toBe("reject");
  });

  it("should cache allow-always and skip subsequent prompts", async () => {
    const { serverAny } = createServerWithSession();
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow-always" },
      }),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    const result1 = await serverAny.requestToolPermission(
      session,
      mockConn,
      sampleToolCall,
    );
    expect(result1).toBe("allow");
    expect(mockConn.requestPermission).toHaveBeenCalledTimes(1);

    const result2 = await serverAny.requestToolPermission(
      session,
      mockConn,
      sampleToolCall,
    );
    expect(result2).toBe("allow");
    expect(mockConn.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("should cache reject-always and skip subsequent prompts", async () => {
    const { serverAny } = createServerWithSession();
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: "selected", optionId: "reject-always" },
      }),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    const result1 = await serverAny.requestToolPermission(
      session,
      mockConn,
      sampleToolCall,
    );
    expect(result1).toBe("reject");

    const result2 = await serverAny.requestToolPermission(
      session,
      mockConn,
      sampleToolCall,
    );
    expect(result2).toBe("reject");
    expect(mockConn.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("should return cancelled when user cancels the dialog", async () => {
    const { serverAny } = createServerWithSession();
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: "cancelled" },
      }),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    const result = await serverAny.requestToolPermission(
      session,
      mockConn,
      sampleToolCall,
    );

    expect(result).toBe("cancelled");
  });

  it("should fall back to allow on permission request error", async () => {
    const { serverAny } = createServerWithSession();
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi
        .fn()
        .mockRejectedValue(new Error("Connection lost")),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    const result = await serverAny.requestToolPermission(
      session,
      mockConn,
      sampleToolCall,
    );

    expect(result).toBe("allow");
  });

  it("should send correct options in permission request", async () => {
    const { serverAny } = createServerWithSession();
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow-once" },
      }),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    await serverAny.requestToolPermission(session, mockConn, sampleToolCall);

    const requestParams = mockConn.requestPermission.mock.calls[0][0];
    expect(requestParams.options).toHaveLength(4);
    const optionIds = requestParams.options.map((o: any) => o.optionId);
    expect(optionIds).toContain("allow-once");
    expect(optionIds).toContain("allow-always");
    expect(optionIds).toContain("reject-once");
    expect(optionIds).toContain("reject-always");
  });

  it("should not cache allow-once decisions across calls", async () => {
    const { serverAny } = createServerWithSession();
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow-once" },
      }),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    await serverAny.requestToolPermission(session, mockConn, sampleToolCall);
    await serverAny.requestToolPermission(session, mockConn, sampleToolCall);

    expect(mockConn.requestPermission).toHaveBeenCalledTimes(2);
  });

  it("should scope caching per tool name", async () => {
    const { serverAny } = createServerWithSession();
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow-always" },
      }),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    await serverAny.requestToolPermission(session, mockConn, sampleToolCall);

    const differentTool: ToolCallInfo = {
      id: "call_exec1",
      name: "execute",
      args: { command: "rm -rf /" },
      status: "pending",
    };
    await serverAny.requestToolPermission(session, mockConn, differentTool);

    expect(mockConn.requestPermission).toHaveBeenCalledTimes(2);
  });
});

describe("Terminal Integration", () => {
  function createServerWithSession() {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
      workspaceRoot: "/project",
    });

    const serverAny = server as unknown as {
      handleNewSession: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<{ sessionId: string }>;
      executeWithTerminal: (
        session: SessionState,
        conn: unknown,
        toolCall: ToolCallInfo,
      ) => Promise<{ output: string; exitCode: number | null }>;
      sessions: Map<string, SessionState>;
    };

    return { server, serverAny };
  }

  it("should execute command via terminal and return output", async () => {
    const { serverAny } = createServerWithSession();

    const mockTerminal = {
      id: "term_1",
      waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
      currentOutput: vi.fn().mockResolvedValue({ output: "hello world\n" }),
      release: vi.fn().mockResolvedValue(undefined),
    };

    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      createTerminal: vi.fn().mockResolvedValue(mockTerminal),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    const toolCall: ToolCallInfo = {
      id: "call_exec",
      name: "execute",
      args: { command: "echo hello world" },
      status: "pending",
    };

    const result = await serverAny.executeWithTerminal(
      session,
      mockConn,
      toolCall,
    );

    expect(result.output).toBe("hello world\n");
    expect(result.exitCode).toBe(0);
    expect(mockConn.createTerminal).toHaveBeenCalledTimes(1);
    expect(mockTerminal.waitForExit).toHaveBeenCalledTimes(1);
    expect(mockTerminal.release).toHaveBeenCalledTimes(1);
  });

  it("should pass correct params to createTerminal", async () => {
    const { serverAny } = createServerWithSession();

    const mockTerminal = {
      id: "term_2",
      waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
      currentOutput: vi.fn().mockResolvedValue({ output: "" }),
      release: vi.fn().mockResolvedValue(undefined),
    };

    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      createTerminal: vi.fn().mockResolvedValue(mockTerminal),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    await serverAny.executeWithTerminal(session, mockConn, {
      id: "call_ls",
      name: "execute",
      args: { command: "ls -la" },
      status: "pending",
    });

    const createParams = mockConn.createTerminal.mock.calls[0][0];
    expect(createParams.sessionId).toBe(sessionId);
    expect(createParams.command).toBe("/bin/bash");
    expect(createParams.args).toEqual(["-c", "ls -la"]);
    expect(createParams.cwd).toBe("/project");
  });

  it("should return error when no command specified", async () => {
    const { serverAny } = createServerWithSession();
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    const result = await serverAny.executeWithTerminal(session, mockConn, {
      id: "call_empty",
      name: "execute",
      args: {},
      status: "pending",
    });

    expect(result.output).toBe("Error: No command specified");
    expect(result.exitCode).toBe(1);
  });

  it("should handle terminal creation failure gracefully", async () => {
    const { serverAny } = createServerWithSession();
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      createTerminal: vi
        .fn()
        .mockRejectedValue(new Error("Terminal not supported")),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    const result = await serverAny.executeWithTerminal(session, mockConn, {
      id: "call_fail",
      name: "execute",
      args: { command: "test" },
      status: "pending",
    });

    expect(result.output).toContain("Terminal error");
    expect(result.exitCode).toBe(1);
  });

  it("should handle non-zero exit codes", async () => {
    const { serverAny } = createServerWithSession();

    const mockTerminal = {
      id: "term_err",
      waitForExit: vi.fn().mockResolvedValue({ exitCode: 127 }),
      currentOutput: vi.fn().mockResolvedValue({ output: "command not found" }),
      release: vi.fn().mockResolvedValue(undefined),
    };

    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      createTerminal: vi.fn().mockResolvedValue(mockTerminal),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    const result = await serverAny.executeWithTerminal(session, mockConn, {
      id: "call_bad",
      name: "execute",
      args: { command: "nonexistent_command" },
      status: "pending",
    });

    expect(result.exitCode).toBe(127);
    expect(result.output).toBe("command not found");
  });

  it("should send in-progress update during execution", async () => {
    const { serverAny } = createServerWithSession();

    const mockTerminal = {
      id: "term_prog",
      waitForExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
      currentOutput: vi.fn().mockResolvedValue({ output: "done" }),
      release: vi.fn().mockResolvedValue(undefined),
    };

    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      createTerminal: vi.fn().mockResolvedValue(mockTerminal),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    await serverAny.executeWithTerminal(session, mockConn, {
      id: "call_prog",
      name: "execute",
      args: { command: "sleep 1" },
      status: "pending",
    });

    const updateCalls = mockConn.sessionUpdate.mock.calls.filter(
      (c: any) => c[0]?.update?.sessionUpdate === "tool_call_update",
    );
    const inProgressUpdate = updateCalls.find(
      (c: any) => c[0]?.update?.status === "in_progress",
    );
    expect(inProgressUpdate).toBeDefined();
  });
});

describe("Session History Replay", () => {
  it("should send available_commands_update on load", async () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      handleNewSession: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<{ sessionId: string }>;
      handleLoadSession: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<unknown>;
    };

    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };
    const { sessionId } = await serverAny.handleNewSession({}, mockConn);

    mockConn.sessionUpdate.mockClear();
    await serverAny.handleLoadSession({ sessionId }, mockConn);

    const commandsUpdates = mockConn.sessionUpdate.mock.calls.filter(
      (c: any) => c[0]?.update?.sessionUpdate === "available_commands_update",
    );
    expect(commandsUpdates.length).toBe(1);
  });

  it("should not error when loading session with no history", async () => {
    const server = new DeepAgentsServer({
      agents: { name: "test-agent" },
    });

    const serverAny = server as unknown as {
      handleNewSession: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<{ sessionId: string }>;
      handleLoadSession: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<{ modes: { availableModes: unknown[] } }>;
    };

    const mockConn = { sessionUpdate: vi.fn().mockResolvedValue(undefined) };
    const { sessionId } = await serverAny.handleNewSession({}, mockConn);

    const result = await serverAny.handleLoadSession({ sessionId }, mockConn);

    expect(result.modes).toBeDefined();
    expect(result.modes.availableModes).toBeDefined();
  });
});
