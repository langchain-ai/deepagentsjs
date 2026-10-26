import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { Command } from "@langchain/langgraph";
import { Client } from "@langchain/langgraph-sdk";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod/v4";

import {
  asyncTasksReducer,
  buildStartTool,
  buildCheckTool,
  buildUpdateTool,
  buildCancelTool,
  buildListTool,
  createAsyncSubAgentMiddleware,
  extractCallbackContext,
  launchingAgent,
  notificationContent,
  traceHeaders,
  ClientCache,
  TERMINAL_STATUSES,
  type AsyncSubAgent,
  type AsyncTask,
  type AsyncTaskStatus,
} from "./async_subagents.js";

// The real lookup, unless a test points the current span somewhere.
const { getCurrentRunTree } = vi.hoisted(() => ({
  getCurrentRunTree: vi.fn(),
}));
vi.mock("langsmith/traceable", async (importOriginal) => {
  const original = await importOriginal<typeof import("langsmith/traceable")>();
  getCurrentRunTree.mockImplementation(original.getCurrentRunTree);
  return { ...original, getCurrentRunTree };
});

/**
 * Matches what LangChain `ToolNode` passes to `tool.invoke` (see `agents/nodes/ToolNode.js`):
 * `state` is the graph state, same source as the former `getCurrentTaskInput(config)`.
 */
type AsyncToolInvokeState = {
  asyncTasks?: Record<string, AsyncTask>;
};

function asyncAgentToolInvokeConfig(
  toolCallId: string,
  state: AsyncToolInvokeState,
): ToolRuntime<AsyncToolInvokeState> {
  return {
    toolCall: { id: toolCallId },
    toolCallId,
    state,
  } as ToolRuntime<AsyncToolInvokeState>;
}

// Tracing is off unless a test says otherwise, whatever the environment sets.
beforeEach(() => {
  for (const name of [
    "LANGSMITH_TRACING",
    "LANGSMITH_TRACING_V2",
    "LANGCHAIN_TRACING",
    "LANGCHAIN_TRACING_V2",
  ]) {
    vi.stubEnv(name, "false");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Helper factories ───

function makeTask(overrides: Partial<AsyncTask> = {}): AsyncTask {
  return {
    taskId: "thread-1",
    agentName: "researcher",
    threadId: "thread-1",
    runId: "run-1",
    status: "running" as AsyncTaskStatus,
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AsyncSubAgent> = {}): AsyncSubAgent {
  return {
    name: "researcher",
    description: "Research agent",
    graphId: "research_graph",
    url: "https://example.langsmith.dev",
    ...overrides,
  };
}

// ─── asyncTasksReducer ───

describe("asyncTasksReducer", () => {
  it("should return update when existing is undefined", () => {
    const job = makeTask();
    const result = asyncTasksReducer(undefined, { [job.taskId]: job });
    expect(result).toEqual({ "thread-1": job });
  });

  it("should return empty dict when both are undefined", () => {
    const result = asyncTasksReducer(undefined, undefined);
    expect(result).toEqual({});
  });

  it("should return existing when update is undefined", () => {
    const job = makeTask();
    const existing = { [job.taskId]: job };
    const result = asyncTasksReducer(existing, undefined);
    expect(result).toEqual(existing);
  });

  it("should merge update into existing without removing other jobs", () => {
    const job1 = makeTask({ taskId: "thread-1", threadId: "thread-1" });
    const job2 = makeTask({
      taskId: "thread-2",
      threadId: "thread-2",
      runId: "run-2",
    });

    const existing = { [job1.taskId]: job1 };
    const update = { [job2.taskId]: job2 };

    const result = asyncTasksReducer(existing, update);
    expect(result).toEqual({
      "thread-1": job1,
      "thread-2": job2,
    });
  });

  it("should overwrite existing job when update has same key", () => {
    const original = makeTask({ status: "running" });
    const updated = makeTask({ status: "success" });

    const result = asyncTasksReducer(
      { [original.taskId]: original },
      { [updated.taskId]: updated },
    );
    expect(result["thread-1"].status).toBe("success");
  });

  it("should not mutate the existing dict", () => {
    const job1 = makeTask();
    const job2 = makeTask({
      taskId: "thread-2",
      threadId: "thread-2",
      runId: "run-2",
    });
    const existing = { [job1.taskId]: job1 };
    const frozenExisting = { ...existing };

    asyncTasksReducer(existing, { [job2.taskId]: job2 });

    expect(existing).toEqual(frozenExisting);
  });
});

// ─── TERMINAL_STATUSES ───

describe("TERMINAL_STATUSES", () => {
  it.each(["cancelled", "success", "error", "timeout", "interrupted"])(
    "should include '%s'",
    (status: AsyncTaskStatus) => {
      expect(TERMINAL_STATUSES.has(status)).toBe(true);
    },
  );

  it.each(["running", "pending", "queued"])(
    "should NOT include '%s'",
    (status: AsyncTaskStatus) => {
      expect(TERMINAL_STATUSES.has(status)).toBe(false);
    },
  );
});

// ─── Type instantiation (compile-time checks) ───

describe("type instantiation", () => {
  it("should allow creating a valid AsyncSubAgent", () => {
    const agent = makeAgent();
    expect(agent.name).toBe("researcher");
    expect(agent.graphId).toBe("research_graph");
  });

  it("should allow AsyncSubAgent without optional fields", () => {
    const agent: AsyncSubAgent = {
      name: "worker",
      description: "A worker agent",
      graphId: "worker_graph",
    };
    expect(agent.url).toBeUndefined();
    expect(agent.headers).toBeUndefined();
  });

  it("should allow creating a valid AsyncTask", () => {
    const job = makeTask();
    expect(job.taskId).toBe("thread-1");
    expect(job.agentName).toBe("researcher");
    expect(job.status).toBe("running");
  });
});

// ─── ClientCache ───

describe("ClientCache", () => {
  it("should return a Client instance for a known agent", () => {
    const agents = { researcher: makeAgent() };
    const cache = new ClientCache(agents);
    const client = cache.getClient("researcher");
    expect(client).toBeInstanceOf(Client);
  });

  it("should return the same Client for the same agent on repeated calls", () => {
    const agents = { researcher: makeAgent() };
    const cache = new ClientCache(agents);
    const client1 = cache.getClient("researcher");
    const client2 = cache.getClient("researcher");
    expect(client1).toBe(client2);
  });

  it("should reuse a Client when two agents share the same url and headers", () => {
    const agents = {
      researcher: makeAgent({ name: "researcher" }),
      analyst: makeAgent({ name: "analyst", graphId: "analyst_graph" }),
    };
    const cache = new ClientCache(agents);
    const client1 = cache.getClient("researcher");
    const client2 = cache.getClient("analyst");
    expect(client1).toBe(client2);
  });

  it("should create separate Clients for agents with different urls", () => {
    const agents = {
      researcher: makeAgent({ url: "https://server-a.langsmith.dev" }),
      analyst: makeAgent({
        name: "analyst",
        url: "https://server-b.langsmith.dev",
      }),
    };
    const cache = new ClientCache(agents);
    const client1 = cache.getClient("researcher");
    const client2 = cache.getClient("analyst");
    expect(client1).not.toBe(client2);
  });

  it("should create separate Clients for agents with different headers", () => {
    const agents = {
      researcher: makeAgent({ headers: { "x-team": "alpha" } }),
      analyst: makeAgent({
        name: "analyst",
        headers: { "x-team": "beta" },
      }),
    };
    const cache = new ClientCache(agents);
    const client1 = cache.getClient("researcher");
    const client2 = cache.getClient("analyst");
    expect(client1).not.toBe(client2);
  });

  it("should add x-auth-scheme: langsmith header by default", () => {
    // Verified indirectly: agents with and without x-auth-scheme explicitly
    // set should produce the same resolved headers → same cache key → same Client.
    const agents = {
      withHeader: makeAgent({
        name: "withHeader",
        headers: { "x-auth-scheme": "langsmith" },
      }),
      withoutHeader: makeAgent({
        name: "withoutHeader",
        headers: {},
      }),
    };
    const cache = new ClientCache(agents);
    const client1 = cache.getClient("withHeader");
    const client2 = cache.getClient("withoutHeader");
    // Same resolved headers → same cache key → same Client
    expect(client1).toBe(client2);
  });

  it("should not overwrite a custom x-auth-scheme header", () => {
    const agents = {
      custom: makeAgent({
        name: "custom",
        headers: { "x-auth-scheme": "custom-auth" },
      }),
      default: makeAgent({
        name: "default",
        headers: {},
      }),
    };
    const cache = new ClientCache(agents);
    const client1 = cache.getClient("custom");
    const client2 = cache.getClient("default");
    // Different x-auth-scheme → different cache key → different Clients
    expect(client1).not.toBe(client2);
  });

  it("should handle agents with no url", () => {
    const agents = {
      local: makeAgent({ name: "local", url: undefined }),
    };
    const cache = new ClientCache(agents);
    const client = cache.getClient("local");
    expect(client).toBeInstanceOf(Client);
  });
});

describe("extractCallbackContext", () => {
  it("should return callbackThreadId when runtime has thread_id in config", () => {
    const runtime = {
      config: { configurable: { thread_id: "parent-thread-123" } },
      state: {},
    } as unknown as ToolRuntime<AsyncToolInvokeState>;

    expect(extractCallbackContext(runtime)).toEqual({
      callbackThreadId: "parent-thread-123",
    });
  });

  it("should return empty object when runtime has no config", () => {
    const runtime = {
      state: {},
    } as unknown as ToolRuntime<AsyncToolInvokeState>;

    expect(extractCallbackContext(runtime)).toEqual({});
  });

  it("should return empty object when configurable has no thread_id", () => {
    const runtime = {
      config: { configurable: {} },
      state: {},
    } as unknown as ToolRuntime<AsyncToolInvokeState>;

    expect(extractCallbackContext(runtime)).toEqual({});
  });

  it("should return empty object when thread_id is empty string", () => {
    const runtime = {
      config: { configurable: { thread_id: "" } },
      state: {},
    } as unknown as ToolRuntime<AsyncToolInvokeState>;

    expect(extractCallbackContext(runtime)).toEqual({});
  });

  it("should return empty object when thread_id is not a string", () => {
    const runtime = {
      config: { configurable: { thread_id: 42 } },
      state: {},
    } as unknown as ToolRuntime<AsyncToolInvokeState>;

    expect(extractCallbackContext(runtime)).toEqual({});
  });
});

// ─── buildStartTool ───

/**
 * Create a ClientCache with mocked SDK methods on the underlying Client.
 *
 * Returns both the cache and mock functions so tests can assert on calls
 * and control return values.
 */
function createMockClientCache(agentMap: Record<string, AsyncSubAgent>) {
  const cache = new ClientCache(agentMap);
  // Get a real Client instance from the cache so we can mock its methods
  const clientInstance = cache.getClient(Object.keys(agentMap)[0]);

  const threadsCreate = vi.fn();
  const runsCreate = vi.fn();
  const runsGet = vi.fn();
  const runsCancel = vi.fn();
  // A finished run's thread is idle unless a test says otherwise.
  const threadsGet = vi.fn().mockResolvedValue({ status: "idle", values: {} });
  const runsList = vi.fn();

  clientInstance.threads.create = threadsCreate;
  clientInstance.runs.create = runsCreate;
  clientInstance.runs.get = runsGet;
  clientInstance.runs.cancel = runsCancel;
  clientInstance.threads.get = threadsGet;
  clientInstance.runs.list = runsList;

  return {
    cache,
    threadsCreate,
    runsCreate,
    runsGet,
    runsCancel,
    threadsGet,
    runsList,
  };
}

describe("buildStartTool", () => {
  const agentMap = { researcher: makeAgent() };
  const toolCallId = "call-123";
  const config = asyncAgentToolInvokeConfig(toolCallId, {});

  it("should return an error for an unknown agent name", async () => {
    const { cache } = createMockClientCache(agentMap);
    const launchTool = buildStartTool(agentMap, cache, "Launch a SubAgent");

    const result = await launchTool.invoke(
      { description: "do research", agentName: "unknown" },
      config,
    );
    // tool().invoke() wraps string returns into a ToolMessage
    expect(result).toBeInstanceOf(ToolMessage);
    const msg = result as unknown as ToolMessage;
    expect(msg.content).toContain("Unknown async subagent type");
    expect(msg.content).toContain("`researcher`");
  });

  it("should return a Command on successful launch", async () => {
    const mockThreadId = "thread-abc";
    const mockRunId = "run-xyz";
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);

    threadsCreate.mockResolvedValue({ thread_id: mockThreadId });
    runsCreate.mockResolvedValue({ run_id: mockRunId, status: "running" });

    const launchTool = buildStartTool(agentMap, cache, "Launch a SubAgent");
    const result = await launchTool.invoke(
      { description: "research quantum computing", agentName: "researcher" },
      config,
    );

    expect(result).toBeInstanceOf(Command);
    const cmd = result as Command;
    const update = cmd.update as Record<string, unknown>;

    // Check job is persisted in state
    const jobs = update.asyncTasks as Record<string, AsyncTask>;
    expect(jobs[mockThreadId]).toMatchObject({
      taskId: mockThreadId,
      agentName: "researcher",
      threadId: mockThreadId,
      runId: mockRunId,
      status: "running",
    });

    // Check tool message
    const messages = update.messages as ToolMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(ToolMessage);
    expect(messages[0].content).toContain(mockThreadId);
  });

  it("should pass the description as a user message to runs.create", async () => {
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);

    threadsCreate.mockResolvedValue({ thread_id: "t-1" });
    runsCreate.mockResolvedValue({ run_id: "r-1", status: "running" });

    const launchTool = buildStartTool(agentMap, cache, "Launch a SubAgent");
    await launchTool.invoke(
      { description: "analyze the data", agentName: "researcher" },
      config,
    );

    expect(runsCreate).toHaveBeenCalledWith(
      "t-1",
      "research_graph",
      expect.objectContaining({
        input: {
          messages: [{ role: "user", content: "analyze the data" }],
        },
      }),
    );
  });

  it("should include callbackThreadId in input when runtime has thread_id", async () => {
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);

    threadsCreate.mockResolvedValue({ thread_id: "t-cb" });
    runsCreate.mockResolvedValue({ run_id: "r-cb", status: "running" });

    const launchTool = buildStartTool(agentMap, cache, "Launch a SubAgent");
    const configWithThreadId = {
      ...config,
      config: { configurable: { thread_id: "parent-thread-abc" } },
    };
    await launchTool.invoke(
      { description: "do work", agentName: "researcher" },
      configWithThreadId,
    );

    expect(runsCreate).toHaveBeenCalledWith(
      "t-cb",
      "research_graph",
      expect.objectContaining({
        input: {
          messages: [{ role: "user", content: "do work" }],
          callbackThreadId: "parent-thread-abc",
        },
      }),
    );
  });

  it("should not include callbackThreadId when runtime has no thread_id", async () => {
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);

    threadsCreate.mockResolvedValue({ thread_id: "t-nocb" });
    runsCreate.mockResolvedValue({ run_id: "r-nocb", status: "running" });

    const launchTool = buildStartTool(agentMap, cache, "Launch a SubAgent");
    await launchTool.invoke(
      { description: "do work", agentName: "researcher" },
      config,
    );

    const callArg = runsCreate.mock.calls[0][2];
    expect(callArg.input).not.toHaveProperty("callbackThreadId");
  });

  it("should return an error when the SDK throws", async () => {
    const { cache, threadsCreate } = createMockClientCache(agentMap);
    threadsCreate.mockRejectedValue(new Error("network error"));

    const launchTool = buildStartTool(agentMap, cache, "Launch a SubAgent");
    const result = await launchTool.invoke(
      { description: "do research", agentName: "researcher" },
      config,
    );

    // tool().invoke() wraps string returns into a ToolMessage
    expect(result).toBeInstanceOf(ToolMessage);
    const msg = result as unknown as ToolMessage;
    expect(msg.content).toContain("Failed to launch async subagent");
    expect(msg.content).toContain("network error");
  });

  it("should use empty string for tool_call_id when config has no toolCall", async () => {
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);

    threadsCreate.mockResolvedValue({ thread_id: "t-notc" });
    runsCreate.mockResolvedValue({ run_id: "r-notc", status: "running" });

    const launchTool = buildStartTool(agentMap, cache, "Launch a SubAgent");
    const result = await launchTool.invoke(
      { description: "do work", agentName: "researcher" },
      {} as any,
    );

    expect(result).toBeInstanceOf(Command);
    const cmd = result as Command;
    const messages = (cmd.update as Record<string, unknown>)
      .messages as ToolMessage[];
    expect(messages[0].tool_call_id).toBe("");
  });

  it("should set createdAt to a valid ISO timestamp on the launched job", async () => {
    const before = new Date();
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);
    threadsCreate.mockResolvedValue({ thread_id: "t-ts" });
    runsCreate.mockResolvedValue({ run_id: "r-ts", status: "running" });

    const launchTool = buildStartTool(agentMap, cache, "Launch a SubAgent");
    const result = await launchTool.invoke(
      { description: "do work", agentName: "researcher" },
      config,
    );
    const after = new Date();

    const jobs = ((result as Command).update as Record<string, unknown>)
      .asyncTasks as Record<string, AsyncTask>;
    const createdAt = new Date(jobs["t-ts"].createdAt);
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(jobs["t-ts"].updatedAt).toBeUndefined();
    expect(jobs["t-ts"].checkedAt).toBeUndefined();
  });
});

// ─── buildCheckTool ───

describe("buildCheckTool", () => {
  const agentMap = { researcher: makeAgent() };
  const toolCallId = "call-check-1";
  const trackedJob = makeTask();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return an error for an unknown job ID", async () => {
    const { cache } = createMockClientCache(agentMap);

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke(
      { taskId: "unknown-id" },
      asyncAgentToolInvokeConfig(toolCallId, { asyncTasks: {} }),
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as unknown as ToolMessage).content).toContain(
      "No tracked task found for taskId",
    );
  });

  it("should return a Command with running status", async () => {
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "running",
    });

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    expect(result).toBeInstanceOf(Command);
    const cmd = result as Command;
    const update = cmd.update as Record<string, unknown>;
    const content = JSON.parse(
      (update.messages as ToolMessage[])[0].content as string,
    );
    expect(content.status).toBe("running");
    expect(content.result).toBeUndefined();
    expect(content.error).toBeUndefined();
  });

  it("should return a Command with result on success", async () => {
    const { cache, runsGet, threadsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "success",
    });
    threadsGet.mockResolvedValue({
      values: {
        messages: [{ content: "Here are the research findings." }],
      },
    });

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    expect(result).toBeInstanceOf(Command);
    const cmd = result as Command;
    const update = cmd.update as Record<string, unknown>;
    const content = JSON.parse(
      (update.messages as ToolMessage[])[0].content as string,
    );
    expect(content.status).toBe("success");
    expect(content.result).toBe("Here are the research findings.");

    // Job status should be updated in state
    const jobs = update.asyncTasks as Record<string, AsyncTask>;
    expect(jobs[trackedJob.taskId].status).toBe("success");
  });

  it("should return fallback result when success but no messages", async () => {
    const { cache, runsGet, threadsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "success",
    });
    threadsGet.mockResolvedValue({ values: { messages: [] } });

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    const cmd = result as Command;
    const content = JSON.parse(
      ((cmd.update as Record<string, unknown>).messages as ToolMessage[])[0]
        .content as string,
    );
    expect(content.result).toBe("(completed with no output messages)");
  });

  it("should return a Command with error on error status", async () => {
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "error",
    });

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    expect(result).toBeInstanceOf(Command);
    const cmd = result as Command;
    const content = JSON.parse(
      ((cmd.update as Record<string, unknown>).messages as ToolMessage[])[0]
        .content as string,
    );
    expect(content.status).toBe("error");
    expect(content.error).toBe("The async subagent encountered an error.");
  });

  it("should return an error when runs.get throws", async () => {
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockRejectedValue(new Error("connection refused"));

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as unknown as ToolMessage).content).toContain(
      "Failed to get run status",
    );
    expect((result as unknown as ToolMessage).content).toContain(
      "connection refused",
    );
  });

  it("should report a check failure, not success, when threads.get throws after a successful run", async () => {
    const { cache, runsGet, threadsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "success",
    });
    threadsGet.mockRejectedValue(new Error("state fetch failed"));

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    // A paused run also ends as `success`, so without the thread the status is unknown.
    expect((result as unknown as ToolMessage).content).toContain(
      "Failed to get run status",
    );
  });

  it("should extract content from non-object messages via String()", async () => {
    const { cache, runsGet, threadsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "success",
    });
    threadsGet.mockResolvedValue({
      values: { messages: ["plain string result"] },
    });

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    const cmd = result as Command;
    const content = JSON.parse(
      ((cmd.update as Record<string, unknown>).messages as ToolMessage[])[0]
        .content as string,
    );
    expect(content.result).toBe("plain string result");
  });

  it("returns the answer without reasoning, and keeps an image as a block", async () => {
    const { cache, runsGet, threadsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ run_id: trackedJob.runId, status: "success" });
    threadsGet.mockResolvedValue({
      status: "idle",
      values: {
        messages: [
          {
            type: "ai",
            content: [
              { type: "reasoning", reasoning: "private thoughts" },
              { type: "text", text: "Here's the chart." },
              { type: "image", url: "https://example.com/chart.png" },
            ],
          },
        ],
      },
    });

    const result = await buildCheckTool(cache).invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    const [message] = ((result as Command).update as Record<string, unknown>)
      .messages as ToolMessage[];
    const blocks = message.content as Array<Record<string, unknown>>;
    expect(JSON.parse(blocks[0].text as string)).toMatchObject({
      status: "success",
    });
    expect(blocks.slice(1)).toEqual([
      { type: "text", text: "Here's the chart." },
      expect.objectContaining({ type: "image" }),
    ]);
    expect(JSON.stringify(blocks)).not.toContain("private thoughts");
  });

  it("should set checkedAt to a valid ISO timestamp on the updated job", async () => {
    const before = new Date();
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ run_id: trackedJob.runId, status: "running" });

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );
    const after = new Date();

    const jobs = ((result as Command).update as Record<string, unknown>)
      .asyncTasks as Record<string, AsyncTask>;
    const checkedAt = new Date(jobs[trackedJob.taskId].checkedAt!);
    expect(checkedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(checkedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("should preserve createdAt and updatedAt from the existing job", async () => {
    const jobWithTimestamps = makeTask({
      createdAt: "2024-06-01T10:00:00.000Z",
      updatedAt: "2024-06-01T11:00:00.000Z",
    });
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({
      run_id: jobWithTimestamps.runId,
      status: "running",
    });

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke(
      { taskId: jobWithTimestamps.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [jobWithTimestamps.taskId]: jobWithTimestamps },
      }),
    );

    const jobs = ((result as Command).update as Record<string, unknown>)
      .asyncTasks as Record<string, AsyncTask>;
    expect(jobs[jobWithTimestamps.taskId].createdAt).toBe(
      "2024-06-01T10:00:00.000Z",
    );
    expect(jobs[jobWithTimestamps.taskId].updatedAt).toBe(
      "2024-06-01T11:00:00.000Z",
    );
  });
});

// ─── buildUpdateTool ───

describe("buildUpdateTool", () => {
  const agentMap = { researcher: makeAgent() };
  const toolCallId = "call-update-1";
  const trackedJob = makeTask();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return an error for an unknown job ID", async () => {
    const { cache } = createMockClientCache(agentMap);

    const updateTool = buildUpdateTool(agentMap, cache);
    const result = await updateTool.invoke(
      { taskId: "unknown-id", message: "new instructions" },
      asyncAgentToolInvokeConfig(toolCallId, { asyncTasks: {} }),
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as unknown as ToolMessage).content).toContain(
      "No tracked task found for taskId",
    );
  });

  it("should create a new run on the same thread and return a Command", async () => {
    const newRunId = "run-updated";
    const { cache, runsCreate } = createMockClientCache(agentMap);
    runsCreate.mockResolvedValue({ run_id: newRunId, status: "running" });

    const updateTool = buildUpdateTool(agentMap, cache);
    const result = await updateTool.invoke(
      { taskId: trackedJob.taskId, message: "focus on quantum entanglement" },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    expect(result).toBeInstanceOf(Command);
    const cmd = result as Command;
    const update = cmd.update as Record<string, unknown>;

    // Task should keep the same taskId but have a new runId
    const jobs = update.asyncTasks as Record<string, AsyncTask>;
    expect(jobs[trackedJob.taskId]).toMatchObject({
      taskId: trackedJob.taskId,
      agentName: trackedJob.agentName,
      threadId: trackedJob.threadId,
      runId: newRunId,
      status: "running",
    });

    // Tool message should confirm the update
    const messages = update.messages as ToolMessage[];
    expect(messages[0].content).toContain(trackedJob.taskId);
  });

  it("should pass multitaskStrategy: interrupt to runs.create", async () => {
    const { cache, runsCreate } = createMockClientCache(agentMap);
    runsCreate.mockResolvedValue({ run_id: "run-2", status: "running" });

    const updateTool = buildUpdateTool(agentMap, cache);
    await updateTool.invoke(
      { taskId: trackedJob.taskId, message: "new instructions" },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    expect(runsCreate).toHaveBeenCalledWith(
      trackedJob.threadId,
      "research_graph",
      expect.objectContaining({
        multitaskStrategy: "interrupt",
      }),
    );
  });

  it("should return an error when the SDK throws", async () => {
    const { cache, runsCreate } = createMockClientCache(agentMap);
    runsCreate.mockRejectedValue(new Error("server unavailable"));

    const updateTool = buildUpdateTool(agentMap, cache);
    const result = await updateTool.invoke(
      { taskId: trackedJob.taskId, message: "new instructions" },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as unknown as ToolMessage).content).toContain(
      "Failed to update async subagent",
    );
    expect((result as unknown as ToolMessage).content).toContain(
      "server unavailable",
    );
  });

  it("should set updatedAt to a valid ISO timestamp on the updated job", async () => {
    const before = new Date();
    const { cache, runsCreate } = createMockClientCache(agentMap);
    runsCreate.mockResolvedValue({ run_id: "run-new", status: "running" });

    const updateTool = buildUpdateTool(agentMap, cache);
    const result = await updateTool.invoke(
      { taskId: trackedJob.taskId, message: "new instructions" },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );
    const after = new Date();

    const jobs = ((result as Command).update as Record<string, unknown>)
      .asyncTasks as Record<string, AsyncTask>;
    const updatedAt = new Date(jobs[trackedJob.taskId].updatedAt!);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("should preserve createdAt and checkedAt from the existing job", async () => {
    const jobWithTimestamps = makeTask({
      createdAt: "2024-06-01T10:00:00.000Z",
      checkedAt: "2024-06-01T10:30:00.000Z",
    });
    const { cache, runsCreate } = createMockClientCache(agentMap);
    runsCreate.mockResolvedValue({ run_id: "run-new", status: "running" });

    const updateTool = buildUpdateTool(agentMap, cache);
    const result = await updateTool.invoke(
      { taskId: jobWithTimestamps.taskId, message: "follow-up" },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [jobWithTimestamps.taskId]: jobWithTimestamps },
      }),
    );

    const jobs = ((result as Command).update as Record<string, unknown>)
      .asyncTasks as Record<string, AsyncTask>;
    expect(jobs[jobWithTimestamps.taskId].createdAt).toBe(
      "2024-06-01T10:00:00.000Z",
    );
    expect(jobs[jobWithTimestamps.taskId].checkedAt).toBe(
      "2024-06-01T10:30:00.000Z",
    );
  });
});

// ─── buildCancelTool ───

describe("buildCancelTool", () => {
  const agentMap = { researcher: makeAgent() };
  const toolCallId = "call-cancel-1";
  const trackedJob = makeTask();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return an error for an unknown job ID", async () => {
    const { cache } = createMockClientCache(agentMap);

    const cancelTool = buildCancelTool(cache);
    const result = await cancelTool.invoke(
      { taskId: "unknown-id" },
      asyncAgentToolInvokeConfig(toolCallId, { asyncTasks: {} }),
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as unknown as ToolMessage).content).toContain(
      "No tracked task found for taskId",
    );
  });

  it("should cancel the run and return a Command with cancelled status", async () => {
    const { cache, runsCancel } = createMockClientCache(agentMap);
    runsCancel.mockResolvedValue(undefined);

    const cancelTool = buildCancelTool(cache);
    const result = await cancelTool.invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    expect(result).toBeInstanceOf(Command);
    const cmd = result as Command;
    const update = cmd.update as Record<string, unknown>;

    // Job status should be updated to cancelled
    const jobs = update.asyncTasks as Record<string, AsyncTask>;
    expect(jobs[trackedJob.taskId].status).toBe("cancelled");

    // Should keep the same runId (cancel doesn't create a new run)
    expect(jobs[trackedJob.taskId].runId).toBe(trackedJob.runId);

    // Tool message should confirm cancellation
    const messages = update.messages as ToolMessage[];
    expect(messages[0].content).toContain(trackedJob.taskId);
  });

  it("should call runs.cancel with the correct thread and run IDs", async () => {
    const { cache, runsCancel } = createMockClientCache(agentMap);
    runsCancel.mockResolvedValue(undefined);

    const cancelTool = buildCancelTool(cache);
    await cancelTool.invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    expect(runsCancel).toHaveBeenCalledWith(
      trackedJob.threadId,
      trackedJob.runId,
    );
  });

  it("should return an error when the SDK throws", async () => {
    const { cache, runsCancel } = createMockClientCache(agentMap);
    runsCancel.mockRejectedValue(new Error("permission denied"));

    const cancelTool = buildCancelTool(cache);
    const result = await cancelTool.invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as unknown as ToolMessage).content).toContain(
      "Failed to cancel run",
    );
    expect((result as unknown as ToolMessage).content).toContain(
      "permission denied",
    );
  });

  it("should preserve createdAt and checkedAt, and set updatedAt to reflect the cancellation", async () => {
    const before = new Date();
    const jobWithTimestamps = makeTask({
      createdAt: "2024-06-01T10:00:00.000Z",
      updatedAt: "2024-06-01T11:00:00.000Z",
      checkedAt: "2024-06-01T11:30:00.000Z",
    });
    const { cache, runsCancel } = createMockClientCache(agentMap);
    runsCancel.mockResolvedValue(undefined);

    const cancelTool = buildCancelTool(cache);
    const result = await cancelTool.invoke(
      { taskId: jobWithTimestamps.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [jobWithTimestamps.taskId]: jobWithTimestamps },
      }),
    );
    const after = new Date();

    const jobs = ((result as Command).update as Record<string, unknown>)
      .asyncTasks as Record<string, AsyncTask>;
    expect(jobs[jobWithTimestamps.taskId].createdAt).toBe(
      "2024-06-01T10:00:00.000Z",
    );
    const updatedAt = new Date(jobs[jobWithTimestamps.taskId].updatedAt!);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(jobs[jobWithTimestamps.taskId].checkedAt).toBe(
      "2024-06-01T11:30:00.000Z",
    );
  });
});

// ─── buildListTool ───

describe("buildListTool", () => {
  const agentMap = { researcher: makeAgent() };
  const toolCallId = "call-list-1";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return a string when state has no jobs", async () => {
    const { cache } = createMockClientCache(agentMap);

    const listTool = buildListTool(cache);
    const result = await listTool.invoke(
      { statusFilter: undefined },
      asyncAgentToolInvokeConfig(toolCallId, { asyncTasks: {} }),
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as unknown as ToolMessage).content).toContain(
      "No async subagent tasks tracked",
    );
  });

  it("should return a string when asyncTasks is undefined", async () => {
    const { cache } = createMockClientCache(agentMap);

    const listTool = buildListTool(cache);
    const result = await listTool.invoke(
      { statusFilter: undefined },
      asyncAgentToolInvokeConfig(toolCallId, {}),
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as unknown as ToolMessage).content).toContain(
      "No async subagent tasks tracked",
    );
  });

  it("should return a string when the status filter matches no jobs", async () => {
    const runningJob = makeTask({ status: "running" });
    const { cache, runsGet } = createMockClientCache(agentMap);

    const listTool = buildListTool(cache);
    // Filter for "success" but the only job is "running" → no match
    const result = await listTool.invoke(
      { statusFilter: "success" },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [runningJob.taskId]: runningJob },
      }),
    );

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as unknown as ToolMessage).content).toContain(
      "No async subagent tasks tracked",
    );
    // Filtering happens before the SDK call — no live fetch needed
    expect(runsGet).not.toHaveBeenCalled();
  });

  it("should return a Command listing all jobs when no filter is provided", async () => {
    const job1 = makeTask({ taskId: "t-1", threadId: "t-1", runId: "r-1" });
    const job2 = makeTask({ taskId: "t-2", threadId: "t-2", runId: "r-2" });
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ status: "running" });

    const listTool = buildListTool(cache);
    const result = await listTool.invoke(
      { statusFilter: undefined },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [job1.taskId]: job1, [job2.taskId]: job2 },
      }),
    );

    expect(result).toBeInstanceOf(Command);
    const messages = ((result as Command).update as Record<string, unknown>)
      .messages as ToolMessage[];
    expect(messages[0].content).toContain("2 tracked task(s)");
  });

  it("should return all jobs when statusFilter is 'all'", async () => {
    const job1 = makeTask({
      taskId: "t-1",
      threadId: "t-1",
      status: "running",
    });
    const job2 = makeTask({
      taskId: "t-2",
      threadId: "t-2",
      status: "success",
    });
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ status: "running" });

    const listTool = buildListTool(cache);
    const result = await listTool.invoke(
      { statusFilter: "all" },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [job1.taskId]: job1, [job2.taskId]: job2 },
      }),
    );

    expect(result).toBeInstanceOf(Command);
    const messages = ((result as Command).update as Record<string, unknown>)
      .messages as ToolMessage[];
    expect(messages[0].content).toContain("2 tracked task(s)");
  });

  it("should filter jobs by cached status", async () => {
    const runningJob = makeTask({
      taskId: "t-run",
      threadId: "t-run",
      status: "running",
    });
    const successJob = makeTask({
      taskId: "t-ok",
      threadId: "t-ok",
      status: "success",
    });
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ status: "running" });

    const listTool = buildListTool(cache);
    const result = await listTool.invoke(
      { statusFilter: "running" },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: {
          [runningJob.taskId]: runningJob,
          [successJob.taskId]: successJob,
        },
      }),
    );

    expect(result).toBeInstanceOf(Command);
    const messages = ((result as Command).update as Record<string, unknown>)
      .messages as ToolMessage[];
    expect(messages[0].content).toContain("1 tracked task(s)");
    expect(messages[0].content).toContain("t-run");
    expect(messages[0].content).not.toContain("t-ok");
  });

  it("should fetch live status from the server for non-terminal jobs", async () => {
    const job = makeTask({ status: "running" });
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ run_id: job.runId, status: "success" });

    const listTool = buildListTool(cache);
    const result = await listTool.invoke(
      { statusFilter: undefined },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [job.taskId]: job },
      }),
    );

    expect(runsGet).toHaveBeenCalledWith(
      job.threadId,
      job.runId,
      expect.anything(),
    );
    const messages = ((result as Command).update as Record<string, unknown>)
      .messages as ToolMessage[];
    // The live status should appear in the formatted output
    expect(messages[0].content).toContain("success");
  });

  it.each(["success", "cancelled", "error", "timeout", "interrupted"] as const)(
    "should skip SDK call for terminal status '%s'",
    async (status) => {
      const job = makeTask({
        taskId: `t-${status}`,
        threadId: `t-${status}`,
        status,
      });
      const { cache, runsGet } = createMockClientCache(agentMap);

      const listTool = buildListTool(cache);
      await listTool.invoke(
        { statusFilter: undefined },
        asyncAgentToolInvokeConfig(toolCallId, {
          asyncTasks: { [job.taskId]: job },
        }),
      );

      expect(runsGet).not.toHaveBeenCalled();
    },
  );

  it("should fall back to cached status when runsGet throws", async () => {
    const job = makeTask({ status: "running" });
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockRejectedValue(new Error("connection refused"));

    const listTool = buildListTool(cache);
    const result = await listTool.invoke(
      { statusFilter: undefined },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [job.taskId]: job },
      }),
    );

    expect(result).toBeInstanceOf(Command);
    const updatedJobs = ((result as Command).update as Record<string, unknown>)
      .asyncTasks as Record<string, AsyncTask>;
    // Falls back to cached "running" status
    expect(updatedJobs[job.taskId].status).toBe("running");
  });

  it("should update asyncTasks in state with live statuses", async () => {
    const job = makeTask({ status: "running" });
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ run_id: job.runId, status: "success" });

    const listTool = buildListTool(cache);
    const result = await listTool.invoke(
      { statusFilter: undefined },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [job.taskId]: job },
      }),
    );

    const updatedJobs = ((result as Command).update as Record<string, unknown>)
      .asyncTasks as Record<string, AsyncTask>;
    expect(updatedJobs[job.taskId].status).toBe("success");
    expect(updatedJobs[job.taskId].taskId).toBe(job.taskId);
    expect(updatedJobs[job.taskId].agentName).toBe(job.agentName);
    expect(updatedJobs[job.taskId].threadId).toBe(job.threadId);
    expect(updatedJobs[job.taskId].runId).toBe(job.runId);
  });

  it("should format each entry with taskId, agentName, and status", async () => {
    const job = makeTask({ status: "running" });
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ run_id: job.runId, status: "running" });

    const listTool = buildListTool(cache);
    const result = await listTool.invoke(
      { statusFilter: undefined },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [job.taskId]: job },
      }),
    );

    const messages = ((result as Command).update as Record<string, unknown>)
      .messages as ToolMessage[];
    const text = messages[0].content as string;
    expect(text).toContain(`taskId: ${job.taskId}`);
    expect(text).toContain(`agent: ${job.agentName}`);
    expect(text).toContain(`status: running`);
  });

  it("should use the correct tool_call_id from config", async () => {
    const job = makeTask({ status: "success" });
    const { cache } = createMockClientCache(agentMap);

    const listTool = buildListTool(cache);
    const result = await listTool.invoke(
      { statusFilter: undefined },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [job.taskId]: job },
      }),
    );

    const messages = ((result as Command).update as Record<string, unknown>)
      .messages as ToolMessage[];
    expect(messages[0].tool_call_id).toBe(toolCallId);
  });

  it("should fetch all job statuses in parallel", async () => {
    const job1 = makeTask({
      taskId: "t-1",
      threadId: "t-1",
      runId: "r-1",
      status: "running",
    });
    const job2 = makeTask({
      taskId: "t-2",
      threadId: "t-2",
      runId: "r-2",
      status: "running",
    });
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ status: "running" });

    const listTool = buildListTool(cache);
    await listTool.invoke(
      { statusFilter: undefined },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [job1.taskId]: job1, [job2.taskId]: job2 },
      }),
    );

    // Both jobs should have been fetched
    expect(runsGet).toHaveBeenCalledTimes(2);
  });

  it("should keep createdAt and updatedAt but refresh checkedAt", async () => {
    const job = makeTask({
      status: "running",
      createdAt: "2024-06-01T10:00:00.000Z",
      updatedAt: "2024-06-01T11:00:00.000Z",
      checkedAt: "2024-06-01T11:30:00.000Z",
    });
    const { cache, runsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ run_id: job.runId, status: "running" });

    const listTool = buildListTool(cache);
    const result = await listTool.invoke(
      { statusFilter: undefined },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [job.taskId]: job },
      }),
    );

    const updatedJobs = ((result as Command).update as Record<string, unknown>)
      .asyncTasks as Record<string, AsyncTask>;
    expect(updatedJobs[job.taskId].createdAt).toBe("2024-06-01T10:00:00.000Z");
    expect(updatedJobs[job.taskId].updatedAt).toBe("2024-06-01T11:00:00.000Z");
    expect(updatedJobs[job.taskId].checkedAt).not.toBe(
      "2024-06-01T11:30:00.000Z",
    );
  });
});

// ─── createAsyncSubAgentMiddleware ───

describe("createAsyncSubAgentMiddleware", () => {
  it("should throw when asyncSubAgents array is empty", () => {
    expect(() => createAsyncSubAgentMiddleware({ asyncSubAgents: [] })).toThrow(
      "At least one async subagent must be specified",
    );
  });

  it("should throw when duplicate agent names are provided", () => {
    expect(() =>
      createAsyncSubAgentMiddleware({
        asyncSubAgents: [makeAgent(), makeAgent()],
      }),
    ).toThrow("Duplicate async subagent names: researcher");
  });

  it("should report all unique duplicate names in the error", () => {
    expect(() =>
      createAsyncSubAgentMiddleware({
        asyncSubAgents: [
          makeAgent({ name: "alpha" }),
          makeAgent({ name: "beta" }),
          makeAgent({ name: "alpha" }),
          makeAgent({ name: "beta" }),
        ],
      }),
    ).toThrow("Duplicate async subagent names: alpha, beta");
  });

  it("should return a middleware object for a valid config", () => {
    const middleware = createAsyncSubAgentMiddleware({
      asyncSubAgents: [makeAgent()],
    });
    expect(middleware).toBeDefined();
  });

  it("should have name 'asyncSubAgentMiddleware'", () => {
    const middleware = createAsyncSubAgentMiddleware({
      asyncSubAgents: [makeAgent()],
    });
    expect(middleware.name).toBe("asyncSubAgentMiddleware");
  });

  it("should have exactly 5 tools", () => {
    const middleware = createAsyncSubAgentMiddleware({
      asyncSubAgents: [makeAgent()],
    });
    expect(middleware.tools).toHaveLength(5);
  });

  it("should include all 5 async subagent tool names", () => {
    const middleware = createAsyncSubAgentMiddleware({
      asyncSubAgents: [makeAgent()],
    });
    const toolNames = (middleware.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("start_async_task");
    expect(toolNames).toContain("check_async_task");
    expect(toolNames).toContain("update_async_task");
    expect(toolNames).toContain("cancel_async_task");
    expect(toolNames).toContain("list_async_tasks");
  });

  it("should inject the agent name and description into the launch tool", () => {
    const agent = makeAgent({
      name: "my-worker",
      description: "Does hard work",
    });
    const middleware = createAsyncSubAgentMiddleware({
      asyncSubAgents: [agent],
    });
    const launchTool = (middleware.tools ?? []).find(
      (t) => t.name === "start_async_task",
    );
    expect(launchTool?.description).toContain("my-worker");
    expect(launchTool?.description).toContain("Does hard work");
  });

  it("should include all agent names in the launch tool description for multiple agents", () => {
    const middleware = createAsyncSubAgentMiddleware({
      asyncSubAgents: [
        makeAgent({ name: "researcher" }),
        makeAgent({ name: "analyst", graphId: "analyst_graph" }),
        makeAgent({ name: "writer", graphId: "writer_graph" }),
      ],
    });
    const launchTool = (middleware.tools ?? []).find(
      (t) => t.name === "start_async_task",
    );
    expect(launchTool?.description).toContain("researcher");
    expect(launchTool?.description).toContain("analyst");
    expect(launchTool?.description).toContain("writer");
  });

  it("does not inject a default system prompt", async () => {
    const middleware = createAsyncSubAgentMiddleware({
      asyncSubAgents: [makeAgent()],
    });
    const handler = vi.fn().mockResolvedValue({ response: "ok" });
    const request = {
      systemMessage: new SystemMessage("Base prompt"),
      state: {},
      config: {},
      tools: middleware.tools ?? [],
    };

    await middleware.wrapModelCall!(request as any, handler);
    expect(handler.mock.calls[0][0].systemMessage.text).toBe("Base prompt");
  });

  it("should accept a custom system prompt", () => {
    const middleware = createAsyncSubAgentMiddleware({
      asyncSubAgents: [makeAgent()],
      systemPrompt: "Custom async SubAgent instructions",
    });
    expect(middleware).toBeDefined();
    expect(middleware.name).toBe("asyncSubAgentMiddleware");
  });

  it("should accept empty string to disable system prompt injection", () => {
    // Empty string is falsy → fullSystemPrompt becomes null → no injection
    const middleware = createAsyncSubAgentMiddleware({
      asyncSubAgents: [makeAgent()],
      systemPrompt: "",
    });
    expect(middleware).toBeDefined();
    expect(middleware.name).toBe("asyncSubAgentMiddleware");
  });

  it("should create independent middleware instances for separate calls", () => {
    const m1 = createAsyncSubAgentMiddleware({
      asyncSubAgents: [makeAgent({ name: "agent-a" })],
    });
    const m2 = createAsyncSubAgentMiddleware({
      asyncSubAgents: [makeAgent({ name: "agent-b" })],
    });
    const launchDesc1 = (m1.tools ?? []).find(
      (t) => t.name === "start_async_task",
    )?.description;
    const launchDesc2 = (m2.tools ?? []).find(
      (t) => t.name === "start_async_task",
    )?.description;
    expect(launchDesc1).toContain("agent-a");
    expect(launchDesc1).not.toContain("agent-b");
    expect(launchDesc2).toContain("agent-b");
    expect(launchDesc2).not.toContain("agent-a");
  });
});

// ─── Parent reference, trace headers and waiting tasks ───

/** A tool runtime whose config says which agent is running. */
function parentRuntime(
  state: AsyncToolInvokeState,
): ToolRuntime<AsyncToolInvokeState> {
  return {
    ...asyncAgentToolInvokeConfig("call-1", state),
    config: {
      configurable: { thread_id: "parent-thread" },
      metadata: { assistant_id: "lead" },
    },
  } as unknown as ToolRuntime<AsyncToolInvokeState>;
}

describe("parent reference", () => {
  it("links a same-deployment launch to the parent's thread and assistant", async () => {
    const agentMap = { researcher: makeAgent({ url: undefined }) };
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);
    threadsCreate.mockResolvedValue({ thread_id: "t" });
    runsCreate.mockResolvedValue({ run_id: "r" });

    await buildStartTool(agentMap, cache, "Launch").invoke(
      { description: "go", agentName: "researcher" },
      parentRuntime({}),
    );

    expect(threadsCreate).toHaveBeenCalledWith({
      metadata: {
        subagent_name: "researcher",
        parent_thread_id: "parent-thread",
        parent_assistant_id: "lead",
      },
    });
    expect(runsCreate.mock.calls[0][2].config).toEqual({
      configurable: {
        deepagents_parent: { thread_id: "parent-thread", assistant_id: "lead" },
      },
    });
  });

  it("sends only the parent's thread to another server", async () => {
    const agentMap = { researcher: makeAgent() };
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);
    threadsCreate.mockResolvedValue({ thread_id: "t" });
    runsCreate.mockResolvedValue({ run_id: "r" });

    await buildStartTool(agentMap, cache, "Launch").invoke(
      { description: "go", agentName: "researcher" },
      parentRuntime({}),
    );

    expect(threadsCreate).toHaveBeenCalledWith({
      metadata: {
        subagent_name: "researcher",
        parent_thread_id: "parent-thread",
      },
    });
    expect(runsCreate.mock.calls[0][2].config).toEqual({
      configurable: { deepagents_parent: { thread_id: "parent-thread" } },
    });
  });

  it("runs a same-deployment subagent with the parent's context", async () => {
    const agentMap = { researcher: makeAgent({ url: undefined }) };
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);
    threadsCreate.mockResolvedValue({ thread_id: "t" });
    runsCreate.mockResolvedValue({ run_id: "r" });
    const runtime = parentRuntime({});
    (runtime as { context?: unknown }).context = {
      team: "eng",
      deepagents_parent: { thread_id: "grandparent" },
    };

    await buildStartTool(agentMap, cache, "Launch").invoke(
      { description: "go", agentName: "researcher" },
      runtime,
    );

    // The Agent Server takes `context` or `configurable`; the thread's metadata names the parent.
    expect(runsCreate.mock.calls[0][2].context).toEqual({ team: "eng" });
    expect(runsCreate.mock.calls[0][2].config).toBeUndefined();
    expect(threadsCreate.mock.calls[0][0].metadata.parent_assistant_id).toBe(
      "lead",
    );
  });

  it("doesn't send the parent's context to another server", async () => {
    const agentMap = { researcher: makeAgent() };
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);
    threadsCreate.mockResolvedValue({ thread_id: "t" });
    runsCreate.mockResolvedValue({ run_id: "r" });
    const runtime = parentRuntime({});
    (runtime as { context?: unknown }).context = { team: "eng" };

    await buildStartTool(agentMap, cache, "Launch").invoke(
      { description: "go", agentName: "researcher" },
      runtime,
    );

    expect(runsCreate.mock.calls[0][2].context).toBeUndefined();
  });

  it.each(["start", "update"] as const)(
    "sets the subagent's webhook on the runs it %ss",
    async (tool) => {
      const agentMap = {
        researcher: makeAgent({ webhook: "https://app.example.com/done" }),
      };
      const { cache, threadsCreate, runsCreate } =
        createMockClientCache(agentMap);
      threadsCreate.mockResolvedValue({ thread_id: "t" });
      runsCreate.mockResolvedValue({ run_id: "r" });

      if (tool === "start") {
        await buildStartTool(agentMap, cache, "Launch").invoke(
          { description: "go", agentName: "researcher" },
          parentRuntime({}),
        );
      } else {
        const task = makeTask();
        await buildUpdateTool(agentMap, cache).invoke(
          { taskId: task.taskId, message: "more" },
          parentRuntime({ asyncTasks: { [task.taskId]: task } }),
        );
      }

      expect(runsCreate.mock.calls[0][2].webhook).toBe(
        "https://app.example.com/done",
      );
    },
  );

  it("never lets a subagent that must not notify wake its parent", async () => {
    const agentMap = {
      researcher: makeAgent({ url: undefined, notifyParent: false }),
    };
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);
    threadsCreate.mockResolvedValue({ thread_id: "t" });
    runsCreate.mockResolvedValue({ run_id: "r" });

    await buildStartTool(agentMap, cache, "Launch").invoke(
      { description: "go", agentName: "researcher" },
      parentRuntime({}),
    );

    // Without the parent's assistant, neither this run nor a later run on its thread can wake the parent.
    expect(threadsCreate).toHaveBeenCalledWith({
      metadata: {
        subagent_name: "researcher",
        parent_thread_id: "parent-thread",
      },
    });
    expect(runsCreate.mock.calls[0][2].config).toEqual({
      configurable: { deepagents_parent: { thread_id: "parent-thread" } },
    });
  });

  it("falls back to the task thread's metadata", () => {
    expect(
      launchingAgent({
        metadata: { parent_thread_id: "p", parent_assistant_id: "lead" },
      }),
    ).toEqual({ thread_id: "p", assistant_id: "lead" });
    expect(launchingAgent({})).toBeNull();
  });
});

describe("fork mode", () => {
  async function launch(
    agent: AsyncSubAgent,
    state: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const agentMap = { researcher: agent };
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);
    threadsCreate.mockResolvedValue({ thread_id: "t" });
    runsCreate.mockResolvedValue({ run_id: "r" });
    await buildStartTool(agentMap, cache, "Launch").invoke(
      { description: "dig deeper", agentName: "researcher" },
      parentRuntime(state as AsyncToolInvokeState),
    );
    return runsCreate.mock.calls[0][2].input.messages;
  }

  const history = [
    new HumanMessage({ content: "find the bug", id: "h1" }),
    new ToolMessage({
      content: "file contents",
      tool_call_id: "c1",
      additional_kwargs: { lc_evicted_to: "/large_tool_results/c1" },
    }),
    new AIMessage({
      content: "",
      tool_calls: [{ id: "c2", name: "start_async_task", args: {} }],
    }),
  ];

  it("sends the parent's conversation, without its in-flight call, then the task", async () => {
    const messages = await launch(makeAgent({ mode: "fork" }), {
      messages: history,
    });

    expect(messages.map((m) => m.type)).toEqual(["human", "tool", "human"]);
    expect(messages[0]).toMatchObject({ content: "find the bug", id: "h1" });
    // A parent-local eviction tag would make the child hide the full content.
    expect(messages[1]).toMatchObject({
      tool_call_id: "c1",
      additional_kwargs: {},
    });
    expect(String(messages[2].content)).toMatch(
      /background subagent[\s\S]*dig deeper$/,
    );
  });

  it("sends the summary in place of what the parent summarized away", async () => {
    const summary = new HumanMessage({ content: "summary so far" });
    const messages = await launch(makeAgent({ mode: "fork" }), {
      messages: history,
      _summarizationEvent: { cutoffIndex: 1, summaryMessage: summary },
    });

    expect(messages.map((m) => m.content)).toEqual([
      "summary so far",
      "file contents",
      expect.stringContaining("dig deeper"),
    ]);
  });

  it("sends offloaded media as references, for a subagent sharing the parent's backend to load", async () => {
    const image = new ToolMessage({
      content: [
        {
          type: "image",
          mimeType: "image/png",
          deepagents_blob: "a".repeat(64),
        },
      ] as never,
      tool_call_id: "c1",
      name: "read_file",
    });

    const messages = await launch(makeAgent({ mode: "fork" }), {
      messages: [new HumanMessage("look at this"), image],
    });

    expect(messages[1].content).toEqual([
      { type: "image", mimeType: "image/png", deepagents_blob: "a".repeat(64) },
    ]);
  });

  it("sends only the task without fork mode", async () => {
    const messages = await launch(makeAgent(), { messages: history });

    expect(messages).toEqual([{ role: "user", content: "dig deeper" }]);
  });

  it("tells the model what a forked subagent inherits, and rejects unknown modes", () => {
    const [start] = createAsyncSubAgentMiddleware({
      asyncSubAgents: [makeAgent({ mode: "fork" })],
    }).tools!;

    expect(start.description).toContain(
      "researcher: Research agent (inherits your conversation at launch",
    );
    expect(() =>
      createAsyncSubAgentMiddleware({
        asyncSubAgents: [
          makeAgent({ mode: "copy" as unknown as AsyncSubAgent["mode"] }),
        ],
      }),
    ).toThrow("invalid mode 'copy'");
  });
});

describe("traceHeaders", () => {
  function mockRunTree() {
    getCurrentRunTree.mockReturnValueOnce({
      tracingEnabled: true,
      trace_id: "trace",
      dotted_order: "20260101T000000000000Zabc",
      project_name: "my project",
    });
  }

  it("is empty when tracing is off", async () => {
    // Inside a tool, LangChain keeps an untraced placeholder span in context.
    const probe = tool(async () => JSON.stringify(traceHeaders(spec)), {
      name: "probe",
      description: "Read trace headers.",
      schema: z.object({}),
    });
    const spec = makeAgent({ url: undefined });

    expect(await probe.invoke({})).toBe("{}");
  });

  it("is empty for a subagent on another server", () => {
    mockRunTree();
    expect(traceHeaders(makeAgent())).toEqual({});
  });

  it("points at the current span and keeps existing baggage", () => {
    mockRunTree();
    const headers = traceHeaders(
      makeAgent({ url: undefined, headers: { baggage: "a=b" } }),
    );
    expect(headers["langsmith-trace"]).toBe("20260101T000000000000Zabc");
    expect(headers.baggage).toBe(
      "a=b,langsmith-metadata=%7B%22ls_nest_under_parent%22%3Atrue%7D,langsmith-project=my%20project",
    );
  });
});

describe("waiting tasks", () => {
  const agentMap = { researcher: makeAgent() };

  it("reports a finished run on an interrupted thread as waiting", async () => {
    const task = makeTask();
    const { cache, runsGet, threadsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ run_id: task.runId, status: "success" });
    threadsGet.mockResolvedValue({
      status: "interrupted",
      interrupts: { t1: [{ id: "i1", value: "Approve?" }] },
    });

    const result = (await buildCheckTool(cache).invoke(
      { taskId: task.taskId },
      asyncAgentToolInvokeConfig("c", { asyncTasks: { [task.taskId]: task } }),
    )) as Command;
    const update = result.update as Record<string, unknown>;
    const content = JSON.parse(
      (update.messages as ToolMessage[])[0].content as string,
    );

    expect(content.status).toBe("waiting");
    expect(content.interrupts).toEqual([{ id: "i1", value: "Approve?" }]);
    expect(content.note).toContain("waiting for a human");
    expect(
      (update.asyncTasks as Record<string, AsyncTask>)[task.taskId].status,
    ).toBe("waiting");
  });

  it("reads the latest run when the thread moved on", async () => {
    const task = makeTask();
    const { cache, runsGet, threadsGet, runsList } =
      createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ run_id: task.runId, status: "success" });
    threadsGet.mockResolvedValue({ status: "busy" });
    runsList.mockResolvedValue([{ run_id: "run-2", status: "running" }]);

    const result = (await buildCheckTool(cache).invoke(
      { taskId: task.taskId },
      asyncAgentToolInvokeConfig("c", { asyncTasks: { [task.taskId]: task } }),
    )) as Command;
    const tracked = (result.update as Record<string, unknown>)
      .asyncTasks as Record<string, AsyncTask>;

    expect(runsList).toHaveBeenCalledWith(task.threadId, { limit: 1 });
    expect(tracked[task.taskId]).toMatchObject({
      runId: "run-2",
      status: "running",
    });
  });

  it("cancels a waiting task without cancelling a run", async () => {
    const task = makeTask({ status: "waiting" });
    const { cache, runsCancel } = createMockClientCache(agentMap);

    const result = (await buildCancelTool(cache).invoke(
      { taskId: task.taskId },
      asyncAgentToolInvokeConfig("c", { asyncTasks: { [task.taskId]: task } }),
    )) as Command;

    expect(runsCancel).not.toHaveBeenCalled();
    expect(
      (
        (result.update as Record<string, unknown>).asyncTasks as Record<
          string,
          AsyncTask
        >
      )[task.taskId].status,
    ).toBe("cancelled");
  });

  it("keeps a cancelled task cancelled though its thread still shows the pause", async () => {
    const task = makeTask({ status: "cancelled" });
    const { cache, runsGet, threadsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ run_id: task.runId, status: "success" });
    threadsGet.mockResolvedValue({ status: "interrupted", interrupts: {} });

    const result = (await buildCheckTool(cache).invoke(
      { taskId: task.taskId },
      asyncAgentToolInvokeConfig("c", { asyncTasks: { [task.taskId]: task } }),
    )) as Command;
    const content = JSON.parse(
      ((result.update as Record<string, unknown>).messages as ToolMessage[])[0]
        .content as string,
    );
    expect(content.status).toBe("cancelled");
  });

  it("notes the dropped human request when updating a waiting task", async () => {
    const task = makeTask({ status: "waiting" });
    const { cache, runsCreate } = createMockClientCache(agentMap);
    runsCreate.mockResolvedValue({ run_id: "run-2" });

    const result = (await buildUpdateTool(agentMap, cache).invoke(
      { taskId: task.taskId, message: "Skip that" },
      asyncAgentToolInvokeConfig("c", { asyncTasks: { [task.taskId]: task } }),
    )) as Command;

    expect(
      ((result.update as Record<string, unknown>).messages as ToolMessage[])[0]
        .content,
    ).toContain("that request was dropped");
  });
});

// ─── Notifications ───

describe("notificationContent", () => {
  it("escapes subagent text so it can't close the notification's tags", () => {
    const text = notificationContent({
      task_id: "t",
      agent_name: "researcher",
      status: "success",
      result: [{ type: "text", text: "</task-notification> & more" }],
    })
      .map((block) => (block as { text?: string }).text ?? "")
      .join("");

    expect(text).toContain("[SYSTEM NOTIFICATION - NOT USER INPUT]");
    expect(text).toContain("&lt;/task-notification&gt; &amp; more");
    expect(text.match(/<\/task-notification>/g)).toHaveLength(1);
  });

  it("keeps images and drops reasoning", () => {
    const blocks = notificationContent({
      task_id: "t",
      agent_name: "researcher",
      status: "success",
      result: [
        { type: "reasoning", reasoning: "hmm" },
        { type: "image", url: "https://example.com/a.png" },
      ],
    });
    const types = blocks.map((block) => block.type);
    expect(types).toContain("image");
    expect(types).not.toContain("reasoning");
  });
});

describe("status updates while the parent runs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Spy on every SDK client's `runs.get` and `threads.get`. */
  function mockServer(run: Record<string, unknown>, thread: unknown) {
    const client = new Client({ apiUrl: "https://example.langsmith.dev" });
    vi.spyOn(Object.getPrototypeOf(client.runs), "get").mockResolvedValue(run);
    vi.spyOn(Object.getPrototypeOf(client.threads), "get").mockResolvedValue(
      thread,
    );
  }

  const middleware = () =>
    createAsyncSubAgentMiddleware({ asyncSubAgents: [makeAgent()] });

  it("adds a notification before the model call when a task finishes", async () => {
    mockServer(
      { run_id: "run-1", status: "success" },
      {
        status: "idle",
        values: { messages: [{ type: "ai", content: "Done" }] },
      },
    );
    const task = makeTask();
    const hook = middleware().beforeModel as (
      state: unknown,
    ) => Promise<Record<string, unknown>>;

    const update = await hook({
      messages: [],
      asyncTasks: { [task.taskId]: task },
    });

    const [message] = update.messages as HumanMessage[];
    expect(message.additional_kwargs.deepagents_notification).toEqual({
      task_id: task.taskId,
      agent_name: "researcher",
      status: "success",
      run_id: "run-1",
    });
    expect(JSON.stringify(message.content)).toContain("Done");
    expect(
      (update.asyncTasks as Record<string, AsyncTask>)[task.taskId].status,
    ).toBe("success");
  });

  it("doesn't report an outcome the agent already saw", async () => {
    mockServer(
      { run_id: "run-1", status: "success" },
      {
        status: "interrupted",
        interrupts: {},
      },
    );
    const task = makeTask({ status: "waiting" });
    const hook = middleware().beforeModel as (
      state: unknown,
    ) => Promise<unknown>;

    expect(
      await hook({ messages: [], asyncTasks: { [task.taskId]: task } }),
    ).toBeUndefined();
  });

  it("gives the model another turn after a final answer when a task finished", async () => {
    mockServer({ run_id: "run-1", status: "error" }, { status: "error" });
    const task = makeTask();
    const afterModel = middleware().afterModel as {
      hook: (state: unknown) => Promise<Record<string, unknown>>;
    };

    const update = await afterModel.hook({
      messages: [new AIMessage("All done.")],
      asyncTasks: { [task.taskId]: task },
    });

    expect(update.jumpTo).toBe("model");
    expect(update.messages).toHaveLength(1);
  });

  it("records the notification that started the run", async () => {
    mockServer({ run_id: "run-1", status: "success" }, { status: "idle" });
    const task = makeTask();
    const notification = new HumanMessage({
      content: "update",
      additional_kwargs: {
        deepagents_notification: {
          task_id: task.taskId,
          agent_name: "researcher",
          status: "success",
          run_id: "run-1",
        },
      },
    });
    const hook = middleware().beforeAgent as (
      state: unknown,
    ) => Promise<Record<string, unknown>>;

    const update = await hook({
      messages: [notification],
      asyncTasks: { [task.taskId]: task },
    });

    expect(update.messages).toBeUndefined();
    expect(
      (update.asyncTasks as Record<string, AsyncTask>)[task.taskId].status,
    ).toBe("success");
  });
});

describe("status updates the parent can't read", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const pullBeforeModel = (tasks: Record<string, AsyncTask>) =>
    (
      createAsyncSubAgentMiddleware({ asyncSubAgents: [makeAgent()] })
        .beforeModel as (state: unknown) => Promise<Record<string, unknown>>
    )({ messages: [], asyncTasks: tasks });

  function spyServer() {
    const client = new Client({ apiUrl: "https://example.langsmith.dev" });
    return {
      runsGet: vi.spyOn(Object.getPrototypeOf(client.runs), "get"),
      threadsGet: vi.spyOn(Object.getPrototypeOf(client.threads), "get"),
    };
  }

  it("keeps the subagent's text when its message isn't a LangChain message", async () => {
    const { runsGet, threadsGet } = spyServer();
    runsGet.mockResolvedValue({ run_id: "run-1", status: "success" });
    threadsGet.mockResolvedValue({
      status: "idle",
      values: { messages: [{ content: "plain answer" }] },
    });
    const task = makeTask();

    const update = await pullBeforeModel({ [task.taskId]: task });

    const [message] = update.messages as HumanMessage[];
    expect(JSON.stringify(message.content)).toContain("plain answer");
  });

  it("checks again later when a finished run's thread can't be read", async () => {
    const { runsGet, threadsGet } = spyServer();
    runsGet.mockResolvedValue({ run_id: "run-1", status: "success" });
    threadsGet.mockRejectedValue(new Error("unavailable"));
    const task = makeTask({ status: "waiting" });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await pullBeforeModel({ [task.taskId]: task })).toBeUndefined();
  });

  it("reports a run cancelled on the server as cancelled", async () => {
    const { runsGet } = spyServer();
    const client = new Client({ apiUrl: "https://example.langsmith.dev" });
    runsGet.mockResolvedValue({ run_id: "run-1", status: "interrupted" });
    vi.spyOn(Object.getPrototypeOf(client.runs), "list").mockResolvedValue([
      { run_id: "run-1", status: "interrupted" },
    ]);
    const task = makeTask({ runId: "run-1" });

    const update = await pullBeforeModel({ [task.taskId]: task });

    const [message] = update.messages as HumanMessage[];
    expect(message.additional_kwargs.deepagents_notification).toMatchObject({
      status: "cancelled",
    });
    expect(JSON.stringify(message.content)).toContain(
      "cancelled before it finished",
    );
    expect(
      (update.asyncTasks as Record<string, AsyncTask>)[task.taskId].status,
    ).toBe("cancelled");
  });

  it("follows a run another client's run replaced, without reporting it", async () => {
    const { runsGet } = spyServer();
    const client = new Client({ apiUrl: "https://example.langsmith.dev" });
    runsGet.mockResolvedValue({ run_id: "run-1", status: "interrupted" });
    vi.spyOn(Object.getPrototypeOf(client.runs), "list").mockResolvedValue([
      { run_id: "run-newer", status: "running" },
    ]);
    const task = makeTask({ runId: "run-1" });

    const update = await pullBeforeModel({ [task.taskId]: task });

    expect(update.messages).toBeUndefined();
    expect(
      (update.asyncTasks as Record<string, AsyncTask>)[task.taskId].runId,
    ).toBe("run-newer");
  });

  it("keeps the task's description when its status changes", async () => {
    const { runsGet } = spyServer();
    runsGet.mockResolvedValue({ run_id: "run-1", status: "error" });
    const task = makeTask({ description: "research X" });

    const update = await pullBeforeModel({ [task.taskId]: task });

    expect(
      (update.asyncTasks as Record<string, AsyncTask>)[task.taskId],
    ).toMatchObject({ status: "error", description: "research X" });
  });

  it("keeps a cancelled task cancelled when its notification arrives", async () => {
    const task = makeTask({ status: "cancelled" });
    const notification = new HumanMessage({
      content: "update",
      additional_kwargs: {
        deepagents_notification: {
          task_id: task.taskId,
          agent_name: "researcher",
          status: "success",
          run_id: task.runId,
        },
      },
    });
    const hook = createAsyncSubAgentMiddleware({
      asyncSubAgents: [makeAgent()],
    }).beforeAgent as (state: unknown) => Promise<unknown>;

    expect(
      await hook({
        messages: [notification],
        asyncTasks: { [task.taskId]: task },
      }),
    ).toBeUndefined();
  });
});

describe("queued follow-ups", () => {
  const queued = makeAgent({ updateStrategy: "enqueue" });
  const agentMap = { researcher: queued };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Send a follow-up to a tracked `run-1` task; the server returns it as `run-followup`, queued. */
  async function sendUpdate(
    spec: AsyncSubAgent,
    task: AsyncTask = makeTask(),
  ): Promise<unknown> {
    const map = { researcher: spec };
    const { cache, runsCreate } = createMockClientCache(map);
    runsCreate.mockResolvedValue({ run_id: "run-followup", status: "pending" });
    const result = await buildUpdateTool(map, cache).invoke(
      { taskId: task.taskId, message: "Keep going" },
      asyncAgentToolInvokeConfig("call-1", {
        asyncTasks: { [task.taskId]: task },
      }),
    );
    expect(runsCreate.mock.calls[0]?.[2].multitaskStrategy).toBe(
      spec.updateStrategy ?? "interrupt",
    );
    return result;
  }

  function sent(result: unknown): [AsyncTask, string] {
    const update = (result as Command).update as Record<string, unknown>;
    const task = Object.values(
      update.asyncTasks as Record<string, AsyncTask>,
    )[0];
    return [task, String((update.messages as ToolMessage[])[0].content)];
  }

  it.each([undefined, "interrupt" as const])(
    "interrupts the current run by default (%s)",
    async (updateStrategy) => {
      const [task, confirmation] = sent(
        await sendUpdate(makeAgent({ updateStrategy })),
      );
      expect(task).toMatchObject({ runId: "run-followup", status: "running" });
      expect(task.supersededRunIds).toBeUndefined();
      expect(confirmation).toMatch(/^Updated async subagent/);
    },
  );

  it("queues behind the current run with enqueue", async () => {
    const [task, confirmation] = sent(await sendUpdate(queued));
    expect(task).toMatchObject({
      runId: "run-followup",
      status: "pending",
      supersededRunIds: ["run-1"],
    });
    expect(confirmation).toContain("without interrupting");
  });

  it.each(["waiting", "success", "error"] as const)(
    "is a plain update when the task has no active run (%s)",
    async (status) => {
      const [, confirmation] = sent(
        await sendUpdate(queued, makeTask({ status })),
      );
      expect(confirmation).toMatch(/^Updated async subagent/);
      expect(confirmation.includes("request was dropped")).toBe(
        status === "waiting",
      );
    },
  );

  it("keeps earlier runs until the latest run finishes", async () => {
    const { cache, runsCreate } = createMockClientCache(agentMap);
    for (const id of ["run-first", "run-second", "run-third"]) {
      runsCreate.mockResolvedValueOnce({ run_id: id, status: "pending" });
    }
    const update = buildUpdateTool(agentMap, cache);
    let task = makeTask();
    const send = async () => {
      const result = await update.invoke(
        { taskId: task.taskId, message: "More" },
        asyncAgentToolInvokeConfig("call-1", {
          asyncTasks: { [task.taskId]: task },
        }),
      );
      [task] = sent(result);
    };
    await send();
    await send();
    expect(task.supersededRunIds).toEqual(["run-1", "run-first"]);
    // Once the latest run has finished, the next follow-up leaves only that run behind.
    task = { ...task, status: "success" };
    await send();
    expect(task.supersededRunIds).toEqual(["run-second"]);
  });

  it("names only the enqueue subagents in the tool description", () => {
    const { cache } = createMockClientCache(agentMap);
    const description = buildUpdateTool(
      {
        researcher: makeAgent(),
        coder: makeAgent({ name: "coder", updateStrategy: "enqueue" }),
      },
      cache,
    ).description;
    const plain = buildUpdateTool(
      { researcher: makeAgent() },
      cache,
    ).description;
    expect(description.startsWith(plain)).toBe(true);
    expect(description).toContain(
      "for `coder`, follow-ups queue behind the current run without interrupting it",
    );
    expect(description).not.toContain("`researcher`");
  });

  it("check and list keep a queued task pending and its earlier runs", async () => {
    const { cache, runsGet, threadsGet } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({ run_id: "run-followup", status: "pending" });
    const task = makeTask({
      runId: "run-followup",
      status: "pending",
      supersededRunIds: ["run-1"],
    });
    const checked = await buildCheckTool(cache).invoke(
      { taskId: task.taskId },
      asyncAgentToolInvokeConfig("call-1", {
        asyncTasks: { [task.taskId]: task },
      }),
    );
    const [checkedTask, output] = sent(checked);
    const result = JSON.parse(output);
    expect(result.status).toBe("pending");
    expect(result.note).toContain("earlier run");
    expect(result.result).toBeUndefined();
    expect(threadsGet).not.toHaveBeenCalled();

    const listed = await buildListTool(cache).invoke(
      { statusFilter: "pending" },
      asyncAgentToolInvokeConfig("call-2", {
        asyncTasks: { [task.taskId]: checkedTask },
      }),
    );
    const [listedTask, entries] = sent(listed);
    expect(entries).toContain("pending");
    expect(listedTask.supersededRunIds).toEqual(["run-1"]);
  });

  it("sends only the first of parallel follow-ups to one task", async () => {
    const turn = new AIMessage({
      content: "",
      tool_calls: ["first", "second"].map((m) => ({
        name: "update_async_task",
        args: { taskId: "thread-1", message: m },
        id: `call-${m}`,
      })),
    });
    const { cache, runsCreate } = createMockClientCache(agentMap);
    runsCreate.mockResolvedValue({ run_id: "run-followup", status: "pending" });
    const update = buildUpdateTool(agentMap, cache);
    const task = makeTask();
    const [first, second] = await Promise.all(
      ["call-first", "call-second"].map((id) =>
        update.invoke(
          { taskId: task.taskId, message: "Keep going" },
          asyncAgentToolInvokeConfig(id, {
            asyncTasks: { [task.taskId]: task },
            messages: [turn],
          } as AsyncToolInvokeState),
        ),
      ),
    );
    expect(first).toBeInstanceOf(Command);
    expect(String((second as unknown as ToolMessage).content)).toMatch(
      /^Not sent/,
    );
    expect(runsCreate).toHaveBeenCalledOnce();
  });

  it("cancel stops the queued run and earlier active runs, newest first", async () => {
    const { cache, runsGet, runsCancel } = createMockClientCache(agentMap);
    runsGet
      .mockResolvedValueOnce({ status: "pending" })
      .mockRejectedValueOnce(new Error("thread gone"))
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "success" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const task = makeTask({
      runId: "run-latest",
      status: "pending",
      supersededRunIds: ["run-done", "run-active", "run-stale", "run-queued"],
    });
    const result = await buildCancelTool(cache).invoke(
      { taskId: task.taskId },
      asyncAgentToolInvokeConfig("call-1", {
        asyncTasks: { [task.taskId]: task },
      }),
    );
    expect(sent(result)[0].status).toBe("cancelled");
    expect(runsCancel.mock.calls.map((call) => call[1])).toEqual([
      "run-latest",
      "run-queued",
      "run-active",
    ]);
  });

  it("rejects an unknown updateStrategy", () => {
    expect(() =>
      createAsyncSubAgentMiddleware({
        asyncSubAgents: [makeAgent({ updateStrategy: "reject" as "enqueue" })],
      }),
    ).toThrow(/invalid updateStrategy/);
  });

  describe("an earlier run's notification", () => {
    function mockServer(run: Record<string, unknown>, thread: unknown) {
      const client = new Client({ apiUrl: "https://example.langsmith.dev" });
      vi.spyOn(Object.getPrototypeOf(client.runs), "get").mockResolvedValue(
        run,
      );
      vi.spyOn(Object.getPrototypeOf(client.threads), "get").mockResolvedValue(
        thread,
      );
    }

    const event = {
      task_id: "thread-1",
      agent_name: "researcher",
      status: "success" as const,
      run_id: "run-1",
    };
    const queuedTask = makeTask({
      runId: "run-followup",
      status: "pending",
      supersededRunIds: ["run-1"],
    });
    const beforeAgent = () =>
      createAsyncSubAgentMiddleware({ asyncSubAgents: [queued] })
        .beforeAgent as (state: unknown) => Promise<Record<string, unknown>>;

    it("is rewritten, keeping its result, and doesn't complete the task", async () => {
      mockServer({ run_id: "run-followup", status: "pending" }, null);
      const notification = new HumanMessage({
        id: "notification",
        content: notificationContent({
          ...event,
          result: [{ type: "text", text: "FULL REPORT" }],
        }),
        additional_kwargs: { deepagents_notification: event },
      });

      const update = await beforeAgent()({
        messages: [notification],
        asyncTasks: { [queuedTask.taskId]: queuedTask },
      });

      expect(update.asyncTasks).toEqual({});
      const [replaced] = update.messages as HumanMessage[];
      expect(replaced.id).toBe("notification");
      expect(replaced.additional_kwargs.deepagents_notification).toEqual(event);
      expect(replaced.text).toMatch(
        /^\[SYSTEM NOTIFICATION - NOT USER INPUT\]/,
      );
      expect(replaced.text).toContain("FULL REPORT");
      expect(replaced.text).toContain("not the result of the follow-up");
      expect(replaced.text).not.toContain("Use the result to continue");
      expect(replaced.text.split("</task-notification>")).toHaveLength(2);
    });

    it("is rewritten alongside the follow-up's own outcome", async () => {
      mockServer(
        { run_id: "run-followup", status: "success" },
        {
          status: "idle",
          values: { messages: [{ type: "ai", content: "follow-up done" }] },
        },
      );
      const notification = new HumanMessage({
        id: "notification",
        content: "old outcome",
        additional_kwargs: { deepagents_notification: event },
      });

      const update = await beforeAgent()({
        messages: [notification],
        asyncTasks: { [queuedTask.taskId]: queuedTask },
      });

      const [replaced, completion] = update.messages as HumanMessage[];
      expect(replaced.id).toBe("notification");
      expect(replaced.text).toContain("not the result of the follow-up");
      expect(
        completion.additional_kwargs.deepagents_notification,
      ).toMatchObject({ run_id: "run-followup", status: "success" });
      expect(
        (update.asyncTasks as Record<string, AsyncTask>)["thread-1"].status,
      ).toBe("success");
    });
  });
});
