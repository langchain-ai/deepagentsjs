import { describe, it, expect, vi } from "vitest";
import { ReactAgent, StructuredTool } from "langchain";

import type {
  SessionHandle,
  SessionSnapshot,
  SessionEventPage,
  SessionUpdatePage,
} from "./types.js";
import { createObserveTool, createSteerTool } from "./tool.js";
import { createCompanionAgent } from "./agent.js";

function makeMockSession(
  overrides: Partial<SessionHandle> = {},
): SessionHandle {
  const defaultSnapshot: SessionSnapshot = {
    session: {
      sessionId: "s1",
      running: true,
      activeThreadId: "t1",
      updatedAt: new Date().toISOString(),
    },
    threads: [
      {
        threadId: "t1",
        agentKind: "root",
        status: "running",
        latestStep: 3,
        latestSummary: "Working on feature X",
      },
    ],
    todos: [{ content: "Implement auth", status: "in_progress" }],
    files: [{ path: "/src/auth.ts", operation: "edit" }],
  };

  const defaultEventPage: SessionEventPage = {
    events: [
      {
        id: "evt-1",
        sessionId: "s1",
        threadId: "t1",
        type: "model_response",
        timestamp: new Date().toISOString(),
        step: 3,
        summary: "Refactored auth module",
      },
    ],
    nextCursor: undefined,
  };

  const defaultUpdatePage: SessionUpdatePage = {
    updates: [],
    nextCursor: undefined,
  };

  return {
    getSnapshot: vi.fn().mockResolvedValue(defaultSnapshot),
    getEvents: vi.fn().mockResolvedValue(defaultEventPage),
    send: vi.fn().mockResolvedValue({
      commandId: "cmd-123",
      status: "queued" as const,
    }),
    poll: vi.fn().mockResolvedValue(defaultUpdatePage),
    subscribe: vi.fn().mockReturnValue(() => {}),
    attachACPClient: vi.fn(),
    ...overrides,
  };
}

describe("observe_agent tool", () => {
  it("returns structured snapshot and events from session handle", async () => {
    const session = makeMockSession();
    const observeTool = createObserveTool(session);

    const result = await observeTool.invoke({
      focus: "auth progress",
      scope: "all",
    });

    const parsed = JSON.parse(result);
    expect(parsed.focus).toBe("auth progress");
    expect(parsed.snapshot.session.sessionId).toBe("s1");
    expect(parsed.snapshot.session.running).toBe(true);
    expect(parsed.snapshot.threads).toHaveLength(1);
    expect(parsed.snapshot.todos).toHaveLength(1);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].summary).toBe("Refactored auth module");
    expect(parsed.nextCursor).toBeNull();
  });

  it("passes scope to getSnapshot", async () => {
    const session = makeMockSession();
    const observeTool = createObserveTool(session);

    await observeTool.invoke({ scope: "active" });

    expect(session.getSnapshot).toHaveBeenCalledWith({ scope: "active" });
  });

  it("passes pagination params to getEvents", async () => {
    const session = makeMockSession();
    const observeTool = createObserveTool(session);

    await observeTool.invoke({
      after: "cursor-1",
      limit: 5,
      threadId: "t2",
    });

    expect(session.getEvents).toHaveBeenCalledWith({
      after: "cursor-1",
      limit: 5,
      threadId: "t2",
    });
  });

  it("works with no input parameters", async () => {
    const session = makeMockSession();
    const observeTool = createObserveTool(session);

    const result = await observeTool.invoke({});

    const parsed = JSON.parse(result);
    expect(parsed.focus).toBeNull();
    expect(parsed.snapshot).toBeDefined();
    expect(parsed.events).toBeDefined();
  });

  it("includes nextCursor when session returns one", async () => {
    const session = makeMockSession({
      getEvents: vi.fn().mockResolvedValue({
        events: [],
        nextCursor: "event-00000005",
      }),
    });
    const observeTool = createObserveTool(session);

    const result = await observeTool.invoke({});
    const parsed = JSON.parse(result);
    expect(parsed.nextCursor).toBe("event-00000005");
  });

  it("has correct tool name and description", () => {
    const session = makeMockSession();
    const observeTool = createObserveTool(session);

    expect(observeTool.name).toBe("observe_agent");
    expect(observeTool.description).toContain("current state");
  });
});

describe("steer_agent tool", () => {
  it("queues a command via session.send()", async () => {
    const session = makeMockSession();
    const steerTool = createSteerTool(session);

    const result = await steerTool.invoke({
      kind: "reminder",
      payload: { text: "Don't forget to add tests" },
    });

    const parsed = JSON.parse(result);
    expect(parsed.commandId).toBe("cmd-123");
    expect(parsed.status).toBe("queued");

    expect(session.send).toHaveBeenCalledWith({
      kind: "reminder",
      target: "active",
      createdBy: "companion",
      payload: { text: "Don't forget to add tests" },
    });
  });

  it("passes explicit target when provided", async () => {
    const session = makeMockSession();
    const steerTool = createSteerTool(session);

    await steerTool.invoke({
      kind: "message",
      target: "root",
      payload: { text: "Focus on performance" },
    });

    expect(session.send).toHaveBeenCalledWith(
      expect.objectContaining({ target: "root" }),
    );
  });

  it("defaults target to 'active' when not provided", async () => {
    const session = makeMockSession();
    const steerTool = createSteerTool(session);

    await steerTool.invoke({
      kind: "add_todo",
      payload: { content: "Write tests", status: "pending" },
    });

    expect(session.send).toHaveBeenCalledWith(
      expect.objectContaining({ target: "active" }),
    );
  });

  it("supports all command kinds", async () => {
    const kinds = [
      "message",
      "reminder",
      "add_todo",
      "update_todo",
      "set_guidance",
    ] as const;

    for (const kind of kinds) {
      const session = makeMockSession();
      const steerTool = createSteerTool(session);

      const result = await steerTool.invoke({
        kind,
        payload: { text: `${kind} payload` },
      });

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe("queued");
      expect(session.send).toHaveBeenCalledWith(
        expect.objectContaining({ kind }),
      );
    }
  });

  it("has correct tool name and description", () => {
    const session = makeMockSession();
    const steerTool = createSteerTool(session);

    expect(steerTool.name).toBe("steer_agent");
    expect(steerTool.description).toContain("steering command");
  });
});

function extractToolsFromAgent(agent: {
  graph: ReactAgent<any>["graph"];
}) {
  const graph = agent.graph;
  const toolsNode = graph.nodes?.tools.bound as unknown as {
    tools: StructuredTool[];
  };

  return Object.fromEntries(
    (toolsNode.tools ?? []).map((t) => [t.name, t]),
  );
}

describe("createCompanionAgent", () => {
  it("creates an agent with only observe_agent when steering is disabled", () => {
    const session = makeMockSession();
    const agent = createCompanionAgent({ session });

    const tools = extractToolsFromAgent(agent);
    expect(tools.observe_agent).toBeDefined();
    expect(tools.steer_agent).toBeUndefined();
  });

  it("creates an agent with both tools when steering is enabled", () => {
    const session = makeMockSession();
    const agent = createCompanionAgent({ session, allowSteering: true });

    const tools = extractToolsFromAgent(agent);
    expect(tools.observe_agent).toBeDefined();
    expect(tools.steer_agent).toBeDefined();
  });

  it("returns a valid agent that can be invoked", () => {
    const session = makeMockSession();
    const agent = createCompanionAgent({ session });

    expect(agent).toBeDefined();
    expect(typeof agent.invoke).toBe("function");
    expect(typeof agent.stream).toBe("function");
  });

  it("includes companion role description in the system prompt", () => {
    const session = makeMockSession();
    const agent = createCompanionAgent({ session });

    const graph = agent.graph;
    const agentNode = graph.nodes?.agent;
    const systemPrompt = (agentNode as any)?.bound?.systemMessage;

    if (typeof systemPrompt === "string") {
      expect(systemPrompt).toContain("companion assistant");
      expect(systemPrompt).toContain("observe_agent");
    }
  });

  it("appends custom systemPrompt when provided", () => {
    const session = makeMockSession();
    const agent = createCompanionAgent({
      session,
      systemPrompt: "Always respond in Spanish.",
    });

    const graph = agent.graph;
    const agentNode = graph.nodes?.agent;
    const systemPrompt = (agentNode as any)?.bound?.systemMessage;

    if (typeof systemPrompt === "string") {
      expect(systemPrompt).toContain("companion assistant");
      expect(systemPrompt).toContain("Always respond in Spanish.");
    }
  });
});
