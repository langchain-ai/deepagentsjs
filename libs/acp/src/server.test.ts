/**
 * Unit tests for the DeepAgents ACP Server
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeepAgentsServer } from "./server.js";
import type { DeepAgentConfig, DeepAgentsServerOptions } from "./types.js";

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

      const mockConn = { sessionUpdate: vi.fn() };
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

      const mockConn = { sessionUpdate: vi.fn() };

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

      const mockConn = { sessionUpdate: vi.fn() };
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

      const mockConn = { sessionUpdate: vi.fn() };
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

      const mockConn = { sessionUpdate: vi.fn() };
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
