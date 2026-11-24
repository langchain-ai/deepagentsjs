/**
 * Unit tests for the DeepAgents ACP Server
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AgentSideConnection,
  RequestPermissionResponse as PermissionAnswer,
} from "@agentclientprotocol/sdk";
import { DeepAgentsServer, type ActivePrompt } from "./server.js";
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
    ls = vi.fn();
    read = vi.fn();
    write = vi.fn();
    edit = vi.fn();
    grep = vi.fn();
    glob = vi.fn();
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
      // ACP spec: default authMethods for registry compliance
      expect(result.authMethods).toBeDefined();
      expect(Array.isArray(result.authMethods)).toBe(true);
      expect(result.authMethods.length).toBe(3);
      expect(
        result.authMethods.find((m: any) => m.type === "env_var"),
      ).toBeDefined();
      expect(
        result.authMethods.find((m: any) => m.id === "deepagents-setup"),
      ).toBeDefined();
    });

    it("should use custom authMethods when provided", async () => {
      const customAuth = [
        {
          id: "my-login",
          name: "My Login",
          type: "terminal" as const,
          args: ["--login"],
        },
      ];

      const server = new DeepAgentsServer({
        agents: { name: "test" },
        authMethods: customAuth,
      });

      const serverAny = server as unknown as {
        handleInitialize: (
          params: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };

      const result: any = await serverAny.handleInitialize({
        clientInfo: { name: "test-client", version: "1.0.0" },
        protocolVersion: 1,
      });

      expect(result.authMethods).toEqual(customAuth);
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
      handleToolMessage: (message: unknown, prompt: unknown) => Promise<void>;
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

function activePrompt({
  session,
  conn,
}: {
  session: SessionState;
  /** A mock with whichever of these the test needs. */
  conn: Partial<
    Pick<AgentSideConnection, "sessionUpdate" | "requestPermission">
  >;
}): ActivePrompt {
  return {
    session,
    conn: conn as AgentSideConnection,
    activeToolCalls: new Map<string, ToolCallInfo>(),
    announced: new Set<string>(),
    signal: undefined,
    abort: vi.fn(),
    permissionQueue: Promise.resolve(),
  };
}

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
      handleAIMessage: (message: unknown, prompt: unknown) => Promise<void>;
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
      fakeAIMessage as any,
      activePrompt({ session, conn: mockConn }),
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
      handleAIMessage: (message: unknown, prompt: unknown) => Promise<void>;
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
      fakeAIMessage as any,
      activePrompt({ session, conn: mockConn }),
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

  it("should reject when the permission request fails", async () => {
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

    expect(result).toBe("reject");
  });

  it("should reject when the client does not support permission requests", async () => {
    const { serverAny } = createServerWithSession();
    const methodNotFound = Object.assign(
      new Error("Method not found: session/request_permission"),
      { code: -32601 },
    );
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockRejectedValue(methodNotFound),
    };

    const { sessionId } = await serverAny.handleNewSession({}, mockConn);
    const session = serverAny.sessions.get(sessionId)!;

    const result = await serverAny.requestToolPermission(
      session,
      mockConn,
      sampleToolCall,
    );

    expect(result).toBe("reject");
    expect(session.permissionDecisions?.get("write_file")).toBeUndefined();
  });

  it("should reject an option that was not offered", async () => {
    const { serverAny } = createServerWithSession();
    const mockConn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: "selected", optionId: "something-else" },
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

describe("Tool permission gate (runs before the tool)", () => {
  type Middleware = {
    wrapToolCall: (
      request: unknown,
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };

  async function setup(
    requestPermission: AgentSideConnection["requestPermission"],
  ) {
    const server = new DeepAgentsServer({ agents: { name: "test-agent" } });
    const serverAny = server as unknown as {
      handleNewSession: (
        params: Record<string, unknown>,
        conn: unknown,
      ) => Promise<{ sessionId: string }>;
      sessions: Map<string, SessionState>;
      activePrompts: Map<string, ActivePrompt>;
      createToolPermissionMiddleware: () => Middleware;
      handleAIMessage: (message: unknown, prompt: unknown) => Promise<void>;
    };
    const conn = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission,
    };
    const { sessionId } = await serverAny.handleNewSession({}, conn);
    const session = serverAny.sessions.get(sessionId)!;
    const prompt = activePrompt({ session, conn });
    serverAny.activePrompts.set(session.threadId, prompt);
    const middleware = serverAny.createToolPermissionMiddleware();
    const request = (id = "call_1", name = "write_file") => ({
      toolCall: { id, name, args: { file_path: "/tmp/x", content: "y" } },
      runtime: { configurable: { thread_id: session.threadId } },
    });
    return { serverAny, conn, session, prompt, middleware, request };
  }

  const toolResult = { content: "ran" };

  it("does not run the tool until the user allows it", async () => {
    let answer!: (value: PermissionAnswer) => void;
    const requestPermission = vi.fn(
      () => new Promise<PermissionAnswer>((resolve) => (answer = resolve)),
    );
    const { middleware, request } = await setup(requestPermission);
    const handler = vi.fn().mockResolvedValue(toolResult);

    const pending = middleware.wrapToolCall(request(), handler);
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalled());
    expect(handler).not.toHaveBeenCalled();

    answer({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await expect(pending).resolves.toBe(toolResult);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("reports the result of an allowed call from the gate itself", async () => {
    const { middleware, request, prompt, conn } = await setup(
      vi.fn().mockResolvedValue({
        outcome: { outcome: "selected", optionId: "allow-once" },
      }),
    );
    const { ToolMessage } = await import("@langchain/core/messages");
    const { Command } = await import("@langchain/langgraph");
    const message = (id: string) =>
      new ToolMessage({ content: "ok", tool_call_id: id, name: "write_file" });

    await middleware.wrapToolCall(request("call_1"), async () =>
      message("call_1"),
    );
    await middleware.wrapToolCall(
      request("call_2"),
      async () => new Command({ update: { messages: [message("call_2")] } }),
    );

    const completed = conn.sessionUpdate.mock.calls
      .map((c: any) => c[0].update)
      .filter((u: any) => u.status === "completed")
      .map((u: any) => u.toolCallId);
    expect(completed).toEqual(["call_1", "call_2"]);
    expect(prompt.activeToolCalls.size).toBe(0);
  });

  it("does not run a rejected tool and ends the turn", async () => {
    const { middleware, request, prompt } = await setup(
      vi.fn().mockResolvedValue({
        outcome: { outcome: "selected", optionId: "reject-once" },
      }),
    );
    const handler = vi.fn().mockResolvedValue(toolResult);

    const result = (await middleware.wrapToolCall(request(), handler)) as {
      status: string;
      tool_call_id: string;
      content: string;
    };

    expect(handler).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.tool_call_id).toBe("call_1");
    expect(result.content).toContain("rejected");
    expect(prompt.abort).toHaveBeenCalled();
  });

  it("does not run the tool when the client cannot ask the user", async () => {
    const { middleware, request, conn } = await setup(
      vi
        .fn()
        .mockRejectedValue(
          new Error("Method not found: session/request_permission"),
        ),
    );
    const handler = vi.fn().mockResolvedValue(toolResult);

    const result = (await middleware.wrapToolCall(request(), handler)) as {
      status: string;
    };

    expect(handler).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    const updates = conn.sessionUpdate.mock.calls.map(
      (c: any) => c[0].update.status,
    );
    expect(updates).toContain("failed");
  });

  it("does not run the tool when the user cancels", async () => {
    const { middleware, request } = await setup(
      vi.fn().mockResolvedValue({ outcome: { outcome: "cancelled" } }),
    );
    const handler = vi.fn().mockResolvedValue(toolResult);

    await middleware.wrapToolCall(request(), handler);

    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a tool call made outside an active prompt", async () => {
    const requestPermission = vi.fn();
    const { middleware, request, serverAny, session } =
      await setup(requestPermission);
    serverAny.activePrompts.delete(session.threadId);
    const handler = vi.fn().mockResolvedValue(toolResult);

    const result = (await middleware.wrapToolCall(request(), handler)) as {
      status: string;
    };

    expect(handler).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
  });

  it("asks for parallel tool calls one at a time and stops after a reject", async () => {
    const answers: Array<(value: PermissionAnswer) => void> = [];
    const requestPermission = vi.fn(
      () => new Promise<PermissionAnswer>((resolve) => answers.push(resolve)),
    );
    const { middleware, request, prompt } = await setup(requestPermission);
    prompt.abort = vi.fn(() => controller.abort());
    const controller = new AbortController();
    prompt.signal = controller.signal;
    const handler = vi.fn().mockResolvedValue(toolResult);

    const first = middleware.wrapToolCall(request("call_1"), handler);
    const second = middleware.wrapToolCall(request("call_2"), handler);
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));

    answers[0]({ outcome: { outcome: "selected", optionId: "reject-once" } });
    await first;
    await second;

    // The second call is never put to the user once the turn was rejected.
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not run the tool when the turn is cancelled while the dialog is open", async () => {
    let answer!: (value: PermissionAnswer) => void;
    const requestPermission = vi.fn(
      () => new Promise<PermissionAnswer>((resolve) => (answer = resolve)),
    );
    const { middleware, request, prompt } = await setup(requestPermission);
    const controller = new AbortController();
    prompt.signal = controller.signal;
    const handler = vi.fn().mockResolvedValue(toolResult);

    const pending = middleware.wrapToolCall(request(), handler);
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalled());
    controller.abort();
    answer({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await pending;

    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the tool without asking after the user chose always allow", async () => {
    const requestPermission = vi.fn().mockResolvedValue({
      outcome: { outcome: "selected", optionId: "allow-always" },
    });
    const { middleware, request } = await setup(requestPermission);
    const handler = vi.fn().mockResolvedValue(toolResult);

    await middleware.wrapToolCall(request("call_1"), handler);
    await middleware.wrapToolCall(request("call_2"), handler);

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("refuses a tool call that carries no thread id", async () => {
    const requestPermission = vi.fn();
    const { middleware, request } = await setup(requestPermission);
    const handler = vi.fn().mockResolvedValue(toolResult);

    await middleware.wrapToolCall(
      { ...request(), runtime: undefined },
      handler,
    );
    await middleware.wrapToolCall({ ...request(), runtime: {} }, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("only announces tool calls from the stream, without asking", async () => {
    const requestPermission = vi.fn();
    const { serverAny, prompt, conn } = await setup(requestPermission);

    await serverAny.handleAIMessage(
      {
        content: "",
        tool_calls: [{ id: "call_1", name: "write_file", args: {} }],
      },
      prompt,
    );
    await serverAny.handleAIMessage(
      {
        content: "",
        tool_calls: [{ id: "call_1", name: "write_file", args: {} }],
      },
      prompt,
    );

    expect(requestPermission).not.toHaveBeenCalled();
    const toolCallNotices = conn.sessionUpdate.mock.calls.filter(
      (c: any) => c[0].update.sessionUpdate === "tool_call",
    );
    expect(toolCallNotices).toHaveLength(1);
  });

  it("is installed in front of every agent's tools", async () => {
    const { createDeepAgent } = await import("deepagents");
    const server = new DeepAgentsServer({ agents: { name: "test-agent" } });
    (server as unknown as { createAgent: (n: string) => void }).createAgent(
      "test-agent",
    );
    const params = vi.mocked(createDeepAgent).mock.calls.at(-1)![0] as {
      middleware: Array<{ name: string }>;
    };
    expect(params.middleware[0].name).toBe("ACPToolPermissionMiddleware");
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
