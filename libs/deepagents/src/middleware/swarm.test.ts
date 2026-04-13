import { describe, it, expect, vi } from "vitest";
import {
  createSwarmTool,
  createSwarmMiddleware,
  SWARM_SYSTEM_PROMPT,
} from "./swarm.js";
import { createMockBackend } from "./test.js";
import { SystemMessage } from "@langchain/core/messages";

vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/langgraph")>();
  return { ...actual, getCurrentTaskInput: vi.fn().mockReturnValue({}) };
});

// ── Helpers ─────────────────────────────────────────────────────────────

function makeSubagent(response = "done") {
  return {
    invoke: vi.fn().mockResolvedValue({ messages: [{ content: response }] }),
  } as any;
}

function makeTasksJsonl(tasks: Array<{ id: string; description: string }>) {
  return tasks.map((t) => JSON.stringify(t)).join("\n") + "\n";
}

// ── createSwarmTool ─────────────────────────────────────────────────────

describe("createSwarmTool", () => {
  it("returns a tool named 'swarm'", () => {
    const backend = createMockBackend();
    const swarmTool = createSwarmTool({ subagentGraphs: {}, backend });
    expect(swarmTool.name).toBe("swarm");
  });

  it("includes available subagent types in the description", () => {
    const backend = createMockBackend();
    const swarmTool = createSwarmTool({
      subagentGraphs: {
        "general-purpose": makeSubagent(),
        researcher: makeSubagent(),
      },
      backend,
    });
    expect(swarmTool.description).toContain("general-purpose");
    expect(swarmTool.description).toContain("researcher");
  });

  it("returns error message when the tasks file is not found", async () => {
    const backend = createMockBackend({ files: {} });
    const swarmTool = createSwarmTool({
      subagentGraphs: { "general-purpose": makeSubagent() },
      backend,
    });
    const result = await swarmTool.invoke({
      tasksPath: "/tmp/swarm/tasks.jsonl",
    });
    expect(result).toContain(
      'Failed to read tasks file at "/tmp/swarm/tasks.jsonl"',
    );
  });

  it("throws when tasks.jsonl fails validation", async () => {
    const backend = createMockBackend({
      files: { "/tmp/swarm/tasks.jsonl": "{ bad json" },
    });
    const swarmTool = createSwarmTool({
      subagentGraphs: { "general-purpose": makeSubagent() },
      backend,
    });
    await expect(
      swarmTool.invoke({ tasksPath: "/tmp/swarm/tasks.jsonl" }),
    ).rejects.toThrow();
  });

  it("returns a JSON summary on successful execution", async () => {
    const tasks = makeTasksJsonl([{ id: "t1", description: "Do something" }]);
    const backend = createMockBackend({
      files: { "/tmp/swarm/tasks.jsonl": tasks },
    });
    const subagent = makeSubagent("done");
    const swarmTool = createSwarmTool({
      subagentGraphs: { "general-purpose": subagent },
      backend,
    });

    const result = await swarmTool.invoke({
      tasksPath: "/tmp/swarm/tasks.jsonl",
    });
    const summary = JSON.parse(result as string);

    expect(summary.total).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.resultsDir).toMatch(/^swarm_runs\/[a-f0-9-]+$/);
    expect(summary.failedTasks).toEqual([]);
  });

  it("does not include maxRetries in the tool schema", () => {
    const backend = createMockBackend();
    const swarmTool = createSwarmTool({
      subagentGraphs: { "general-purpose": makeSubagent() },
      backend,
    });
    const schemaShape = (swarmTool as any).schema?.shape ?? {};
    expect(schemaShape).not.toHaveProperty("maxRetries");
  });
});

// ── createSwarmMiddleware ───────────────────────────────────────────────

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
      return { content: "" } as any;
    }) as any;

    await middleware.wrapModelCall?.({ systemMessage: [] } as any, handler);

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
      return { content: "" } as any;
    }) as any;

    await middleware.wrapModelCall?.(
      { systemMessage: [existing] } as any,
      handler,
    );

    const systemMessages: SystemMessage[] = captured[0].systemMessage;
    expect(systemMessages).toHaveLength(2);
    expect(systemMessages[0]).toBe(existing);
  });
});
