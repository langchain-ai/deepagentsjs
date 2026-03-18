import { describe, it, expect, vi } from "vitest";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import { Client } from "@langchain/langgraph-sdk";
import { ToolMessage } from "@langchain/core/messages";

import {
  asyncSubagentJobsReducer,
  buildLaunchTool,
  buildCheckTool,
  ClientCache,
  ASYNC_TASK_SYSTEM_PROMPT,
  TERMINAL_STATUSES,
  type AsyncSubagent,
  type AsyncSubagentJob,
  type AsyncSubagentStatus,
} from "./async_subagents.js";

vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/langgraph")>();
  return { ...actual, getCurrentTaskInput: vi.fn() };
});

// ─── Helper factories ───

function makeJob(overrides: Partial<AsyncSubagentJob> = {}): AsyncSubagentJob {
  return {
    jobId: "thread-1",
    agentName: "researcher",
    threadId: "thread-1",
    runId: "run-1",
    status: "running" as AsyncSubagentStatus,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AsyncSubagent> = {}): AsyncSubagent {
  return {
    name: "researcher",
    description: "Research agent",
    graphId: "research_graph",
    url: "https://example.langsmith.dev",
    ...overrides,
  };
}

// ─── asyncSubagentJobsReducer ───

describe("asyncSubagentJobsReducer", () => {
  it("should return update when existing is undefined", () => {
    const job = makeJob();
    const result = asyncSubagentJobsReducer(undefined, { [job.jobId]: job });
    expect(result).toEqual({ "thread-1": job });
  });

  it("should return empty dict when both are undefined", () => {
    const result = asyncSubagentJobsReducer(undefined, undefined);
    expect(result).toEqual({});
  });

  it("should return existing when update is undefined", () => {
    const job = makeJob();
    const existing = { [job.jobId]: job };
    const result = asyncSubagentJobsReducer(existing, undefined);
    expect(result).toEqual(existing);
  });

  it("should merge update into existing without removing other jobs", () => {
    const job1 = makeJob({ jobId: "thread-1", threadId: "thread-1" });
    const job2 = makeJob({
      jobId: "thread-2",
      threadId: "thread-2",
      runId: "run-2",
    });

    const existing = { [job1.jobId]: job1 };
    const update = { [job2.jobId]: job2 };

    const result = asyncSubagentJobsReducer(existing, update);
    expect(result).toEqual({
      "thread-1": job1,
      "thread-2": job2,
    });
  });

  it("should overwrite existing job when update has same key", () => {
    const original = makeJob({ status: "running" });
    const updated = makeJob({ status: "success" });

    const result = asyncSubagentJobsReducer(
      { [original.jobId]: original },
      { [updated.jobId]: updated },
    );
    expect(result["thread-1"].status).toBe("success");
  });

  it("should not mutate the existing dict", () => {
    const job1 = makeJob();
    const job2 = makeJob({
      jobId: "thread-2",
      threadId: "thread-2",
      runId: "run-2",
    });
    const existing = { [job1.jobId]: job1 };
    const frozenExisting = { ...existing };

    asyncSubagentJobsReducer(existing, { [job2.jobId]: job2 });

    expect(existing).toEqual(frozenExisting);
  });
});

// ─── TERMINAL_STATUSES ───

describe("TERMINAL_STATUSES", () => {
  it.each(["cancelled", "success", "error", "timeout", "interrupted"])(
    "should include '%s'",
    (status) => {
      expect(TERMINAL_STATUSES.has(status)).toBe(true);
    },
  );

  it.each(["running", "pending", "queued"])(
    "should NOT include '%s'",
    (status) => {
      expect(TERMINAL_STATUSES.has(status)).toBe(false);
    },
  );
});

// ─── ASYNC_TASK_SYSTEM_PROMPT ───

describe("ASYNC_TASK_SYSTEM_PROMPT", () => {
  it("should mention all five tool names", () => {
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("launch_async_subagent");
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("check_async_subagent");
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("update_async_subagent");
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("cancel_async_subagent");
    expect(ASYNC_TASK_SYSTEM_PROMPT).toContain("list_async_subagent_jobs");
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
  it("should allow creating a valid AsyncSubagent", () => {
    const agent = makeAgent();
    expect(agent.name).toBe("researcher");
    expect(agent.graphId).toBe("research_graph");
  });

  it("should allow AsyncSubagent without optional fields", () => {
    const agent: AsyncSubagent = {
      name: "worker",
      description: "A worker agent",
      graphId: "worker_graph",
    };
    expect(agent.url).toBeUndefined();
    expect(agent.headers).toBeUndefined();
  });

  it("should allow creating a valid AsyncSubagentJob", () => {
    const job = makeJob();
    expect(job.jobId).toBe("thread-1");
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
    const constructorSpy = vi.spyOn(Client.prototype, "constructor" as any);
    // We can't easily inspect the headers passed to Client constructor,
    // so we verify indirectly: agents with and without x-auth-scheme
    // explicitly set should produce the same cache key (same Client).
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
    constructorSpy.mockRestore();
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

// ─── buildLaunchTool ───

/**
 * Create a ClientCache with mocked SDK methods on the underlying Client.
 *
 * Returns both the cache and mock functions so tests can assert on calls
 * and control return values.
 */
function createMockClientCache(agentMap: Record<string, AsyncSubagent>) {
  const cache = new ClientCache(agentMap);
  // Get a real Client instance from the cache so we can mock its methods
  const clientInstance = cache.getClient(Object.keys(agentMap)[0]);

  const threadsCreate = vi.fn();
  const runsCreate = vi.fn();
  const runsGet = vi.fn();
  const threadsGetState = vi.fn();

  clientInstance.threads.create = threadsCreate;
  clientInstance.runs.create = runsCreate;
  clientInstance.runs.get = runsGet;
  clientInstance.threads.getState = threadsGetState;

  return { cache, threadsCreate, runsCreate, runsGet, threadsGetState };
}

describe("buildLaunchTool", () => {
  const agentMap = { researcher: makeAgent() };
  const toolCallId = "call-123";
  const config = { toolCall: { id: toolCallId } } as any;

  it("should return an error for an unknown agent name", async () => {
    const { cache } = createMockClientCache(agentMap);
    const launchTool = buildLaunchTool(agentMap, cache, "Launch a subagent");

    const result = await launchTool.invoke(
      { description: "do research", agentName: "unknown" },
      config,
    );
    // tool().invoke() wraps string returns into a ToolMessage
    expect(result).toBeInstanceOf(ToolMessage);
    const msg = result as ToolMessage;
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

    const launchTool = buildLaunchTool(agentMap, cache, "Launch a subagent");
    const result = await launchTool.invoke(
      { description: "research quantum computing", agentName: "researcher" },
      config,
    );

    expect(result).toBeInstanceOf(Command);
    const cmd = result as Command;
    const update = cmd.update as Record<string, unknown>;

    // Check job is persisted in state
    const jobs = update.asyncSubagentJobs as Record<string, AsyncSubagentJob>;
    expect(jobs[mockThreadId]).toEqual({
      jobId: mockThreadId,
      agentName: "researcher",
      threadId: mockThreadId,
      runId: mockRunId,
      status: "running",
    });

    // Check tool message
    const messages = update.message as ToolMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(ToolMessage);
    expect(messages[0].content).toContain(mockThreadId);
  });

  it("should pass the description as a user message to runs.create", async () => {
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);

    threadsCreate.mockResolvedValue({ thread_id: "t-1" });
    runsCreate.mockResolvedValue({ run_id: "r-1", status: "running" });

    const launchTool = buildLaunchTool(agentMap, cache, "Launch a subagent");
    await launchTool.invoke(
      { description: "analyze the data", agentName: "researcher" },
      config,
    );

    expect(runsCreate).toHaveBeenCalledWith(
      "t-1",
      "research_graph",
      expect.objectContaining({
        input: {
          message: [{ role: "user", content: "analyze the data" }],
        },
      }),
    );
  });

  it("should return an error when the SDK throws", async () => {
    const { cache, threadsCreate } = createMockClientCache(agentMap);
    threadsCreate.mockRejectedValue(new Error("network error"));

    const launchTool = buildLaunchTool(agentMap, cache, "Launch a subagent");
    const result = await launchTool.invoke(
      { description: "do research", agentName: "researcher" },
      config,
    );

    // tool().invoke() wraps string returns into a ToolMessage
    expect(result).toBeInstanceOf(ToolMessage);
    const msg = result as ToolMessage;
    expect(msg.content).toContain("Failed to launch async subagent");
    expect(msg.content).toContain("network error");
  });

  it("should use empty string for tool_call_id when config has no toolCall", async () => {
    const { cache, threadsCreate, runsCreate } =
      createMockClientCache(agentMap);

    threadsCreate.mockResolvedValue({ thread_id: "t-notc" });
    runsCreate.mockResolvedValue({ run_id: "r-notc", status: "running" });

    const launchTool = buildLaunchTool(agentMap, cache, "Launch a subagent");
    const result = await launchTool.invoke(
      { description: "do work", agentName: "researcher" },
      {} as any,
    );

    expect(result).toBeInstanceOf(Command);
    const cmd = result as Command;
    const messages = (cmd.update as Record<string, unknown>)
      .message as ToolMessage[];
    expect(messages[0].tool_call_id).toBe("");
  });
});

// ─── buildCheckTool ───

describe("buildCheckTool", () => {
  const agentMap = { researcher: makeAgent() };
  const toolCallId = "call-check-1";
  const config = { toolCall: { id: toolCallId } } as any;
  const trackedJob = makeJob();
  const mockGetCurrentTaskInput = vi.mocked(getCurrentTaskInput);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return an error for an unknown job ID", async () => {
    const { cache } = createMockClientCache(agentMap);
    mockGetCurrentTaskInput.mockReturnValue({
      asyncSubagentJobs: {},
    });

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke({ jobId: "unknown-id" }, config);

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).content).toContain(
      "No tracked job found for jobId",
    );
  });

  it("should return a Command with running status", async () => {
    const { cache, runsGet } = createMockClientCache(agentMap);
    mockGetCurrentTaskInput.mockReturnValue({
      asyncSubagentJobs: { [trackedJob.jobId]: trackedJob },
    });
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "running",
    });

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke({ jobId: trackedJob.jobId }, config);

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
    mockGetCurrentTaskInput.mockReturnValue({
      asyncSubagentJobs: { [trackedJob.jobId]: trackedJob },
    });
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
    const result = await checkTool.invoke({ jobId: trackedJob.jobId }, config);

    expect(result).toBeInstanceOf(Command);
    const cmd = result as Command;
    const update = cmd.update as Record<string, unknown>;
    const content = JSON.parse(
      (update.messages as ToolMessage[])[0].content as string,
    );
    expect(content.status).toBe("success");
    expect(content.result).toBe("Here are the research findings.");

    // Job status should be updated in state
    const jobs = update.asyncSubagentJobs as Record<string, AsyncSubagentJob>;
    expect(jobs[trackedJob.jobId].status).toBe("success");
  });

  it("should return fallback result when success but no messages", async () => {
    const { cache, runsGet, threadsGetState } = createMockClientCache(agentMap);
    mockGetCurrentTaskInput.mockReturnValue({
      asyncSubagentJobs: { [trackedJob.jobId]: trackedJob },
    });
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "success",
    });
    threadsGetState.mockResolvedValue({ values: { messages: [] } });

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke({ jobId: trackedJob.jobId }, config);

    const cmd = result as Command;
    const content = JSON.parse(
      ((cmd.update as Record<string, unknown>).messages as ToolMessage[])[0]
        .content as string,
    );
    expect(content.result).toBe("Completed with no output messages.");
  });

  it("should return a Command with error on error status", async () => {
    const { cache, runsGet } = createMockClientCache(agentMap);
    mockGetCurrentTaskInput.mockReturnValue({
      asyncSubagentJobs: { [trackedJob.jobId]: trackedJob },
    });
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "error",
    });

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke({ jobId: trackedJob.jobId }, config);

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
    mockGetCurrentTaskInput.mockReturnValue({
      asyncSubagentJobs: { [trackedJob.jobId]: trackedJob },
    });
    runsGet.mockRejectedValue(new Error("connection refused"));

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke({ jobId: trackedJob.jobId }, config);

    expect(result).toBeInstanceOf(ToolMessage);
    expect((result as ToolMessage).content).toContain(
      "Failed to get run status",
    );
    expect((result as ToolMessage).content).toContain("connection refused");
  });

  it("should degrade gracefully when threads.getState throws on success", async () => {
    const { cache, runsGet, threadsGetState } = createMockClientCache(agentMap);
    mockGetCurrentTaskInput.mockReturnValue({
      asyncSubagentJobs: { [trackedJob.jobId]: trackedJob },
    });
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "success",
    });
    threadsGetState.mockRejectedValue(new Error("state fetch failed"));

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke({ jobId: trackedJob.jobId }, config);

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
    mockGetCurrentTaskInput.mockReturnValue({
      asyncSubagentJobs: { [trackedJob.jobId]: trackedJob },
    });
    runsGet.mockResolvedValue({
      run_id: trackedJob.runId,
      status: "success",
    });
    threadsGetState.mockResolvedValue({
      values: { messages: ["plain string result"] },
    });

    const checkTool = buildCheckTool(cache);
    const result = await checkTool.invoke({ jobId: trackedJob.jobId }, config);

    const cmd = result as Command;
    const content = JSON.parse(
      ((cmd.update as Record<string, unknown>).messages as ToolMessage[])[0]
        .content as string,
    );
    expect(content.result).toBe("plain string result");
  });
});
