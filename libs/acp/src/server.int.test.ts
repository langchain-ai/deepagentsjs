/**
 * Integration tests for the DeepAgents ACP Server
 *
 * These tests verify the full ACP protocol flow with a real DeepAgent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeepAgentsServer } from "./server.js";
import { generateSessionId } from "./adapter.js";
import type { DeepAgentConfig, SessionState } from "./types.js";

// These tests use the actual deepagents library but mock the LLM
vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({
      content: "I can help with that!",
      tool_calls: [],
    }),
    bindTools: vi.fn().mockReturnThis(),
  })),
}));

describe("DeepAgentsServer Integration", () => {
  let server: DeepAgentsServer;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (server) {
      server.stop();
    }
  });

  describe("Session Management", () => {
    it("should create and track sessions", async () => {
      server = new DeepAgentsServer({
        agents: {
          name: "test-agent",
          description: "Test agent for integration tests",
        },
        debug: false,
      });

      // Access internal state
      const serverAny = server as unknown as {
        handleNewSession: (
          params: Record<string, unknown>,
          conn: unknown,
        ) => Promise<{ sessionId: string }>;
        sessions: Map<string, SessionState>;
      };

      const mockConn = { sessionUpdate: vi.fn() };

      // Create first session
      const result1 = await serverAny.handleNewSession({}, mockConn);
      expect(result1.sessionId).toBeDefined();

      // Create second session
      const result2 = await serverAny.handleNewSession({}, mockConn);
      expect(result2.sessionId).toBeDefined();
      expect(result2.sessionId).not.toBe(result1.sessionId);

      // Both sessions should exist
      expect(serverAny.sessions.size).toBe(2);
    });

    it("should load existing session", async () => {
      server = new DeepAgentsServer({
        agents: {
          name: "test-agent",
        },
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
        sessions: Map<string, SessionState>;
      };

      const mockConn = { sessionUpdate: vi.fn() };

      // Create a session
      const { sessionId } = await serverAny.handleNewSession({}, mockConn);

      // Try to load it
      const loadResult = await serverAny.handleLoadSession(
        { sessionId },
        mockConn,
      );

      // ACP spec: LoadSessionResponse returns modes, not sessionId
      expect(loadResult.modes).toBeDefined();
      expect(loadResult.modes.availableModes).toBeDefined();
    });

    it("should throw when loading unknown session", async () => {
      server = new DeepAgentsServer({
        agents: {
          name: "test-agent",
        },
      });

      const serverAny = server as unknown as {
        handleLoadSession: (
          params: Record<string, unknown>,
          conn: unknown,
        ) => Promise<{ sessionId: string }>;
      };

      const mockConn = { sessionUpdate: vi.fn() };

      // Try to load a non-existent session - should throw
      await expect(
        serverAny.handleLoadSession({ sessionId: "non-existent" }, mockConn),
      ).rejects.toThrow("Session not found");
    });
  });

  describe("Mode Handling", () => {
    it("should support agent mode by default", async () => {
      server = new DeepAgentsServer({
        agents: {
          name: "test-agent",
        },
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

      const agentMode = result.modes.availableModes.find(
        (m) => m.id === "agent",
      );
      expect(agentMode).toBeDefined();
      expect(agentMode?.name).toBe("Agent Mode");
    });

    it("should support plan mode", async () => {
      server = new DeepAgentsServer({
        agents: {
          name: "test-agent",
        },
      });

      const serverAny = server as unknown as {
        handleNewSession: (
          params: Record<string, unknown>,
          conn: unknown,
        ) => Promise<{ modes: { availableModes: Array<{ id: string }> } }>;
      };

      const mockConn = { sessionUpdate: vi.fn() };
      const result = await serverAny.handleNewSession({}, mockConn);

      const planMode = result.modes.availableModes.find((m) => m.id === "plan");
      expect(planMode).toBeDefined();
    });

    it("should update session mode when set", async () => {
      server = new DeepAgentsServer({
        agents: {
          name: "test-agent",
        },
      });

      const serverAny = server as unknown as {
        handleNewSession: (
          params: Record<string, unknown>,
          conn: unknown,
        ) => Promise<{ sessionId: string }>;
        handleSetSessionMode: (
          params: Record<string, unknown>,
        ) => Promise<void>;
        sessions: Map<string, SessionState>;
      };

      const mockConn = { sessionUpdate: vi.fn() };
      const { sessionId } = await serverAny.handleNewSession({}, mockConn);

      // Set to plan mode
      await serverAny.handleSetSessionMode({
        sessionId,
        mode: "plan",
      });

      const session = serverAny.sessions.get(sessionId);
      expect(session?.mode).toBe("plan");

      // Set back to agent mode
      await serverAny.handleSetSessionMode({
        sessionId,
        mode: "agent",
      });

      const updatedSession = serverAny.sessions.get(sessionId);
      expect(updatedSession?.mode).toBe("agent");
    });
  });

  describe("Multi-Agent Support", () => {
    it("should route sessions to correct agent", async () => {
      server = new DeepAgentsServer({
        agents: [
          { name: "coding-agent", description: "For coding tasks" },
          { name: "writing-agent", description: "For writing tasks" },
        ],
      });

      const serverAny = server as unknown as {
        handleNewSession: (
          params: Record<string, unknown>,
          conn: unknown,
        ) => Promise<{ sessionId: string }>;
        sessions: Map<string, SessionState>;
      };

      const mockConn = { sessionUpdate: vi.fn() };

      // Create session with specific agent
      const { sessionId } = await serverAny.handleNewSession(
        { configOptions: { agent: "writing-agent" } },
        mockConn,
      );

      const session = serverAny.sessions.get(sessionId);
      expect(session?.agentName).toBe("writing-agent");
    });

    it("should use first agent as default", async () => {
      server = new DeepAgentsServer({
        agents: [{ name: "first-agent" }, { name: "second-agent" }],
      });

      const serverAny = server as unknown as {
        handleNewSession: (
          params: Record<string, unknown>,
          conn: unknown,
        ) => Promise<{ sessionId: string }>;
        sessions: Map<string, SessionState>;
      };

      const mockConn = { sessionUpdate: vi.fn() };

      const { sessionId } = await serverAny.handleNewSession({}, mockConn);

      const session = serverAny.sessions.get(sessionId);
      expect(session?.agentName).toBe("first-agent");
    });
  });

  describe("Cancel Handling", () => {
    it("should abort active prompt when cancelled", async () => {
      server = new DeepAgentsServer({
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

      // Simulate an active prompt
      const controller = new AbortController();
      serverAny.currentPromptAbortController = controller;

      expect(controller.signal.aborted).toBe(false);

      // Cancel the prompt
      await serverAny.handleCancel({ sessionId });

      expect(controller.signal.aborted).toBe(true);
    });

    it("should handle multiple cancels gracefully", async () => {
      server = new DeepAgentsServer({
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

      const controller = new AbortController();
      serverAny.currentPromptAbortController = controller;

      // First cancel
      await serverAny.handleCancel({ sessionId });
      expect(controller.signal.aborted).toBe(true);

      // Second cancel should not throw
      await expect(
        serverAny.handleCancel({ sessionId }),
      ).resolves.not.toThrow();
    });
  });

  describe("Initialize Response", () => {
    it("should return correct capabilities", async () => {
      server = new DeepAgentsServer({
        agents: { name: "test-agent" },
        serverName: "test-server",
        serverVersion: "1.2.3",
      });

      const serverAny = server as unknown as {
        handleInitialize: (params: Record<string, unknown>) => Promise<{
          agentInfo: { name: string; version: string };
          agentCapabilities: {
            loadSession: boolean;
            promptCapabilities: { image: boolean };
          };
        }>;
      };

      const result = await serverAny.handleInitialize({
        protocolVersion: 1,
        clientInfo: { name: "test-client", version: "1.0.0" },
      });

      // ACP spec: agentInfo contains name and version
      expect(result.agentInfo).toBeDefined();
      expect(result.agentInfo.name).toBe("test-server");
      expect(result.agentInfo.version).toBe("1.2.3");
      // ACP spec: agentCapabilities
      expect(result.agentCapabilities).toBeDefined();
      expect(result.agentCapabilities.loadSession).toBe(true);
      expect(result.agentCapabilities.promptCapabilities).toBeDefined();
      expect(result.agentCapabilities.promptCapabilities.image).toBe(true);
    });
  });
});

describe("generateSessionId", () => {
  it("should generate unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateSessionId());
    }
    expect(ids.size).toBe(100);
  });

  it("should generate IDs with correct format", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^sess_[a-f0-9]{16}$/);
  });
});
