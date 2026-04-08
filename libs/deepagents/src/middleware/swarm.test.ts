import { describe, it, expect, vi } from "vitest";
import {
  createSwarmTool,
  createSwarmMiddleware,
  SWARM_SYSTEM_PROMPT,
} from "./swarm.js";
import { createMockBackend } from "./test.js";
import { serializeResultsJsonl } from "../swarm/parse.js";
import type { SwarmTaskResult } from "../swarm/types.js";
import { SystemMessage } from "@langchain/core/messages";

vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/langgraph")>();
  return { ...actual, getCurrentTaskInput: vi.fn().mockReturnValue({}) };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSubagent(response = "done") {
  return {
    invoke: vi.fn().mockResolvedValue({ messages: [{ content: response }] }),
  };
}

const TASK_1: SwarmTaskResult = {
  id: "t1",
  description: "Do something",
  status: "completed",
  result: "done",
};

// ---------------------------------------------------------------------------
// createSwarmTool
// ---------------------------------------------------------------------------

describe("createSwarmTool", () => {
  it("returns a tool named 'swarm'", () => {
    const backend = createMockBackend();
    const tool = createSwarmTool({ subagentGraphs: {}, backend });
    expect(tool.name).toBe("swarm");
  });

  it("includes available subagent types in the description", () => {
    const backend = createMockBackend();
    const tool = createSwarmTool({
      subagentGraphs: {
        "general-purpose": makeSubagent(),
        researcher: makeSubagent(),
      },
      backend,
    });
    expect(tool.description).toContain("general-purpose");
    expect(tool.description).toContain("researcher");
  });

  it("throws when the tasks file is not found", async () => {
    const backend = createMockBackend({ files: {} });
    const tool = createSwarmTool({
      subagentGraphs: { "general-purpose": makeSubagent() },
      backend,
    });
    await expect(
      tool.invoke({ tasksPath: "/tmp/swarm/tasks.jsonl" }),
    ).rejects.toThrow('Failed to read tasks file at "/tmp/swarm/tasks.jsonl"');
  });

  it("throws when tasks.jsonl fails validation", async () => {
    const backend = createMockBackend({
      files: { "/tmp/swarm/tasks.jsonl": "{ bad json" },
    });
    const tool = createSwarmTool({
      subagentGraphs: { "general-purpose": makeSubagent() },
      backend,
    });
    await expect(
      tool.invoke({ tasksPath: "/tmp/swarm/tasks.jsonl" }),
    ).rejects.toThrow();
  });

  it("returns a JSON summary on successful execution", async () => {
    const tasksJsonl = serializeResultsJsonl([TASK_1]);
    const backend = createMockBackend({
      files: { "/tmp/swarm/tasks.jsonl": tasksJsonl },
    });
    const subagent = makeSubagent("done");
    const tool = createSwarmTool({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    const result = await tool.invoke({ tasksPath: "/tmp/swarm/tasks.jsonl" });
    const summary = JSON.parse(result as string);

    expect(summary.total).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("passes concurrency and maxRetries through to the executor", async () => {
    const tasksJsonl = serializeResultsJsonl([TASK_1]);
    const backend = createMockBackend({
      files: { "/tmp/swarm/tasks.jsonl": tasksJsonl },
    });
    const subagent = makeSubagent();
    const tool = createSwarmTool({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    // maxRetries: 1 means only one attempt — subagent should be called once
    await tool.invoke({
      tasksPath: "/tmp/swarm/tasks.jsonl",
      concurrency: 5,
      maxRetries: 1,
    });

    expect(subagent.invoke).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createSwarmMiddleware
// ---------------------------------------------------------------------------

describe("createSwarmMiddleware", () => {
  it("registers the swarm tool", () => {
    const backend = createMockBackend();
    const middleware = createSwarmMiddleware({
      subagentGraphs: { "general-purpose": makeSubagent() },
      backend,
    });
    expect(
      middleware.tools?.some((t: { name: string }) => t.name === "swarm"),
    ).toBe(true);
  });

  it("injects the swarm system prompt", async () => {
    const backend = createMockBackend();
    const middleware = createSwarmMiddleware({
      subagentGraphs: { "general-purpose": makeSubagent() },
      backend,
    });

    const captured: any[] = [];
    const handler = vi.fn(async (req: any) => {
      captured.push(req);
      return { content: "" };
    });

    await middleware.wrapModelCall?.({ systemMessage: [] }, handler);

    const systemMessages: SystemMessage[] = captured[0].systemMessage;
    const injected = systemMessages.find(
      (m) => typeof m.content === "string" && m.content.includes("swarm"),
    );
    expect(injected).toBeDefined();
    expect(injected!.content).toContain(SWARM_SYSTEM_PROMPT);
  });

  it("preserves existing system messages when injecting", async () => {
    const backend = createMockBackend();
    const middleware = createSwarmMiddleware({
      subagentGraphs: { "general-purpose": makeSubagent() },
      backend,
    });

    const existing = new SystemMessage("existing prompt");
    const captured: any[] = [];
    const handler = vi.fn(async (req: any) => {
      captured.push(req);
      return { content: "" };
    });

    await middleware.wrapModelCall?.({ systemMessage: [existing] }, handler);

    const systemMessages: SystemMessage[] = captured[0].systemMessage;
    expect(systemMessages).toHaveLength(2);
    expect(systemMessages[0]).toBe(existing);
  });
});
