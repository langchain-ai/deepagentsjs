import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "@langchain/langgraph";
import { Client } from "@langchain/langgraph-sdk";
import { ToolMessage } from "@langchain/core/messages";
import type { ToolRuntime } from "langchain";

import {
  asyncTasksReducer,
  buildStartTool,
  buildCheckTool,
  buildUpdateTool,
  buildCancelTool,
  buildListTool,
  createAsyncSubAgentMiddleware,
  extractCallbackContext,
  ClientCache,
  ASYNC_TASK_SYSTEM_PROMPT,
  TERMINAL_STATUSES,
  type AsyncSubAgent,
  type AsyncTask,
  type AsyncTaskStatus,
} from "./async_subagents.js";

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

// ─── ASYNC_TASK_SYSTEM_PROMPT ───

describe("ASYNC_TASK_SYSTEM_PROMPT", () => {
  it("should mention all five tool names", () => {
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("start_async_task");
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("check_async_task");
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("update_async_task");
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("cancel_async_task");
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("list_async_tasks");
  });

  it("should include critical behavioral rules", () => {
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain(
      "Never auto-check after launching",
    );
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("Never poll");
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("ALWAYS stale");
  });
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
  const threadsGetState = vi.fn();

  clientInstance.threads.create = threadsCreate;
  clientInstance.runs.create = runsCreate;
  clientInstance.runs.get = runsGet;
  clientInstance.runs.cancel = runsCancel;
  clientInstance.threads.getState = threadsGetState;

  return {
    cache,
    threadsCreate,
    runsCreate,
    runsGet,
    runsCancel,
    threadsGetState,
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
    const { cache, runsGet, threadsGetState } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "success",
    });
    threadsGetState.mockResolvedValue({
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
    const { cache, runsGet, threadsGetState } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "success",
    });
    threadsGetState.mockResolvedValue({ values: { messages: [] } });

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
    expect(content.result).toBe("Completed with no output messages.");
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

  it("should degrade gracefully when threads.getState throws on success", async () => {
    const { cache, runsGet, threadsGetState } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "success",
    });
    threadsGetState.mockRejectedValue(new Error("state fetch failed"));

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke(
      { taskId: trackedJob.taskId },
      asyncAgentToolInvokeConfig(toolCallId, {
        asyncTasks: { [trackedJob.taskId]: trackedJob },
      }),
    );

    // Should still return a Command (not an error string)
    expect(result).toBeInstanceOf(Command);
    const cmd = result as Command;
    const content = JSON.parse(
      ((cmd.update as Record<string, unknown>).messages as ToolMessage[])[0]
        .content as string,
    );
    expect(content.status).toBe("success");
    expect(content.result).toBe("Completed with no output messages.");
  });

  it("should extract content from non-object messages via String()", async () => {
    const { cache, runsGet, threadsGetState } = createMockClientCache(agentMap);
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "success",
    });
    threadsGetState.mockResolvedValue({
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

    expect(runsGet).toHaveBeenCalledWith(job.threadId, job.runId);
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

  it("should preserve all timestamps from existing jobs unchanged", async () => {
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
    expect(updatedJobs[job.taskId].checkedAt).toBe("2024-06-01T11:30:00.000Z");
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
