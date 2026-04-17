import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Runnable } from "@langchain/core/runnables";
import { SystemMessage } from "@langchain/core/messages";
import { createSwarmTool, createSwarmMiddleware } from "./swarm.js";
import { getCurrentTaskInput } from "@langchain/langgraph";
import { executeSwarm } from "../swarm/executor.js";
import { parseTasksJsonl } from "../swarm/parse.js";
import { resolveVirtualTableTasks } from "../swarm/virtual-table.js";
import { readFileSync } from "node:fs";
import type { SwarmExecutionSummary } from "../swarm/types.js";

vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getCurrentTaskInput: vi.fn(() => ({})),
  };
});

vi.mock("../backends/protocol.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    resolveBackend: vi.fn(async (backend: unknown) => backend),
  };
});

vi.mock("../swarm/executor.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    executeSwarm: vi.fn(),
  };
});

vi.mock("../swarm/parse.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    parseTasksJsonl: vi.fn(),
  };
});

vi.mock("../swarm/virtual-table.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    resolveVirtualTableTasks: vi.fn(),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    readFileSync: vi.fn(),
  };
});

function createMockBackend() {
  return {
    readRaw: vi.fn(),
    write: vi.fn(),
    glob: vi.fn(),
  };
}

function createMockSubagentGraphs() {
  return {
    "general-purpose": { invoke: vi.fn() } as unknown as Runnable,
  };
}

const defaultSummary: SwarmExecutionSummary = {
  total: 1,
  completed: 1,
  failed: 0,
  resultsDir: "/swarm_runs/test-uuid",
  failedTasks: [],
};

function getSwarmTool() {
  const backend = createMockBackend();
  const subagentGraphs = createMockSubagentGraphs();
  const swarmTool = createSwarmTool({
    subagentGraphs,
    backend: backend as any,
  });
  return { swarmTool, backend, subagentGraphs };
}

describe("createSwarmTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentTaskInput).mockReturnValue({});
  });

  describe("tool metadata", () => {
    it("creates a tool named 'swarm'", () => {
      const { swarmTool } = getSwarmTool();
      expect(swarmTool.name).toBe("swarm");
    });

    it("includes available subagent types in description", () => {
      const subagentGraphs = {
        "general-purpose": { invoke: vi.fn() } as unknown as Runnable,
        analyst: { invoke: vi.fn() } as unknown as Runnable,
      };
      const swarmTool = createSwarmTool({
        subagentGraphs,
        backend: createMockBackend() as any,
      });
      expect(swarmTool.description).toContain("general-purpose");
      expect(swarmTool.description).toContain("analyst");
    });
  });

  describe("input validation", () => {
    it("rejects when both script and virtual-table forms are provided", async () => {
      const { swarmTool } = getSwarmTool();
      const result = await swarmTool.invoke({
        tasksPath: "/tasks.jsonl",
        filePaths: ["a.txt"],
        instruction: "process",
      });
      expect(result).toContain("Cannot mix");
    });

    it("rejects when tasksPath is combined with glob", async () => {
      const { swarmTool } = getSwarmTool();
      const result = await swarmTool.invoke({
        tasksPath: "/tasks.jsonl",
        glob: "*.txt",
        instruction: "process",
      });
      expect(result).toContain("Cannot mix");
    });

    it("rejects when neither form is provided", async () => {
      const { swarmTool } = getSwarmTool();
      const result = await swarmTool.invoke({});
      expect(result).toContain("Provide either");
    });

    it("rejects virtual-table form without instruction", async () => {
      const { swarmTool } = getSwarmTool();
      const result = await swarmTool.invoke({ filePaths: ["a.txt"] });
      expect(result).toContain("instruction is required");
    });
  });

  describe("script form", () => {
    it("reads tasks from backend and executes swarm", async () => {
      const { swarmTool, backend } = getSwarmTool();
      const tasks = [{ id: "t1", description: "task" }];

      backend.readRaw.mockResolvedValue({
        data: { content: '{"id":"t1","description":"task"}' },
      });
      vi.mocked(parseTasksJsonl).mockReturnValue(tasks);
      vi.mocked(executeSwarm).mockResolvedValue(defaultSummary);

      const result = await swarmTool.invoke({ tasksPath: "/tasks.jsonl" });

      expect(JSON.parse(result as string)).toEqual(defaultSummary);
      expect(parseTasksJsonl).toHaveBeenCalledWith(
        '{"id":"t1","description":"task"}',
      );
      expect(executeSwarm).toHaveBeenCalled();
    });

    it("joins array content from backend readRaw", async () => {
      const { swarmTool, backend } = getSwarmTool();

      backend.readRaw.mockResolvedValue({
        data: {
          content: [
            '{"id":"t1","description":"task1"}',
            '{"id":"t2","description":"task2"}',
          ],
        },
      });
      vi.mocked(parseTasksJsonl).mockReturnValue([
        { id: "t1", description: "task1" },
      ]);
      vi.mocked(executeSwarm).mockResolvedValue(defaultSummary);

      await swarmTool.invoke({ tasksPath: "/tasks.jsonl" });

      expect(parseTasksJsonl).toHaveBeenCalledWith(
        '{"id":"t1","description":"task1"}\n{"id":"t2","description":"task2"}',
      );
    });

    it("falls back to readFileSync when backend readRaw throws", async () => {
      const { swarmTool, backend } = getSwarmTool();

      backend.readRaw.mockRejectedValue(new Error("not found"));
      vi.mocked(readFileSync).mockReturnValue(
        '{"id":"t1","description":"task"}',
      );
      vi.mocked(parseTasksJsonl).mockReturnValue([
        { id: "t1", description: "task" },
      ]);
      vi.mocked(executeSwarm).mockResolvedValue(defaultSummary);

      const result = await swarmTool.invoke({ tasksPath: "/tasks.jsonl" });

      expect(JSON.parse(result as string)).toEqual(defaultSummary);
      expect(readFileSync).toHaveBeenCalledWith("/tasks.jsonl", "utf-8");
    });

    it("falls back to readFileSync when backend returns error", async () => {
      const { swarmTool, backend } = getSwarmTool();

      backend.readRaw.mockResolvedValue({ error: "file not found" });
      vi.mocked(readFileSync).mockReturnValue(
        '{"id":"t1","description":"task"}',
      );
      vi.mocked(parseTasksJsonl).mockReturnValue([
        { id: "t1", description: "task" },
      ]);
      vi.mocked(executeSwarm).mockResolvedValue(defaultSummary);

      const result = await swarmTool.invoke({ tasksPath: "/tasks.jsonl" });

      expect(JSON.parse(result as string)).toEqual(defaultSummary);
      expect(readFileSync).toHaveBeenCalledWith("/tasks.jsonl", "utf-8");
    });

    it("returns error when both backend and filesystem read fail", async () => {
      const { swarmTool, backend } = getSwarmTool();

      backend.readRaw.mockRejectedValue(new Error("not found"));
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const result = await swarmTool.invoke({ tasksPath: "/missing.jsonl" });

      expect(result).toContain("Failed to read tasks file");
      expect(result).toContain("/missing.jsonl");
    });

    it("returns error when parseTasksJsonl throws", async () => {
      const { swarmTool, backend } = getSwarmTool();

      backend.readRaw.mockResolvedValue({
        data: { content: "invalid json" },
      });
      vi.mocked(parseTasksJsonl).mockImplementation(() => {
        throw new Error("Invalid JSON on line 1");
      });

      const result = await swarmTool.invoke({ tasksPath: "/tasks.jsonl" });

      expect(result).toContain("Invalid JSON on line 1");
    });

    it("returns error when executeSwarm throws", async () => {
      const { swarmTool, backend } = getSwarmTool();

      backend.readRaw.mockResolvedValue({
        data: { content: '{"id":"t1","description":"task"}' },
      });
      vi.mocked(parseTasksJsonl).mockReturnValue([
        { id: "t1", description: "task" },
      ]);
      vi.mocked(executeSwarm).mockRejectedValue(
        new Error("Unknown subagent type(s): nonexistent"),
      );

      const result = await swarmTool.invoke({ tasksPath: "/tasks.jsonl" });

      expect(result).toContain("Unknown subagent type(s)");
    });
  });

  describe("virtual-table form", () => {
    it("resolves files and executes swarm with filePaths", async () => {
      const { swarmTool } = getSwarmTool();

      vi.mocked(resolveVirtualTableTasks).mockResolvedValue({
        tasks: [{ id: "a.txt", description: "Process\n\nFile: a.txt" }],
        tasksJsonl: '{"id":"a.txt","description":"Process\\n\\nFile: a.txt"}\n',
      });
      vi.mocked(executeSwarm).mockResolvedValue(defaultSummary);

      const result = await swarmTool.invoke({
        filePaths: ["a.txt"],
        instruction: "Process",
      });

      expect(JSON.parse(result as string)).toEqual(defaultSummary);
      expect(resolveVirtualTableTasks).toHaveBeenCalledWith(
        expect.objectContaining({
          filePaths: ["a.txt"],
          instruction: "Process",
        }),
        expect.anything(),
      );
    });

    it("resolves files and executes swarm with glob", async () => {
      const { swarmTool } = getSwarmTool();

      vi.mocked(resolveVirtualTableTasks).mockResolvedValue({
        tasks: [{ id: "001.txt", description: "Classify\n\nFile: f/001.txt" }],
        tasksJsonl: '{"id":"001.txt"}\n',
      });
      vi.mocked(executeSwarm).mockResolvedValue(defaultSummary);

      await swarmTool.invoke({
        glob: "feedback/*.txt",
        instruction: "Classify",
      });

      expect(resolveVirtualTableTasks).toHaveBeenCalledWith(
        expect.objectContaining({
          glob: "feedback/*.txt",
          instruction: "Classify",
        }),
        expect.anything(),
      );
    });

    it("passes subagentType to resolver", async () => {
      const { swarmTool } = getSwarmTool();

      vi.mocked(resolveVirtualTableTasks).mockResolvedValue({
        tasks: [
          {
            id: "a.txt",
            description: "Analyze\n\nFile: a.txt",
            subagentType: "analyst",
          },
        ],
        tasksJsonl: "",
      });
      vi.mocked(executeSwarm).mockResolvedValue(defaultSummary);

      await swarmTool.invoke({
        filePaths: ["a.txt"],
        instruction: "Analyze",
        subagentType: "analyst",
      });

      expect(resolveVirtualTableTasks).toHaveBeenCalledWith(
        expect.objectContaining({ subagentType: "analyst" }),
        expect.anything(),
      );
    });

    it("returns error from resolver", async () => {
      const { swarmTool } = getSwarmTool();

      vi.mocked(resolveVirtualTableTasks).mockResolvedValue({
        error: "No files matched the provided patterns: nothing/*.txt",
      });

      const result = await swarmTool.invoke({
        glob: "nothing/*.txt",
        instruction: "Read",
      });

      expect(result).toContain("No files matched");
      expect(executeSwarm).not.toHaveBeenCalled();
    });

    it("returns error when executeSwarm throws", async () => {
      const { swarmTool } = getSwarmTool();

      vi.mocked(resolveVirtualTableTasks).mockResolvedValue({
        tasks: [{ id: "t1", description: "task" }],
        tasksJsonl: "",
      });
      vi.mocked(executeSwarm).mockRejectedValue(new Error("dispatch failed"));

      const result = await swarmTool.invoke({
        filePaths: ["a.txt"],
        instruction: "Process",
      });

      expect(result).toContain("dispatch failed");
    });

    it("passes synthesizedTasksJsonl to executeSwarm", async () => {
      const { swarmTool } = getSwarmTool();
      const jsonl = '{"id":"a.txt","description":"task"}\n';

      vi.mocked(resolveVirtualTableTasks).mockResolvedValue({
        tasks: [{ id: "a.txt", description: "task" }],
        tasksJsonl: jsonl,
      });
      vi.mocked(executeSwarm).mockResolvedValue(defaultSummary);

      await swarmTool.invoke({
        filePaths: ["a.txt"],
        instruction: "Process",
      });

      expect(executeSwarm).toHaveBeenCalledWith(
        expect.objectContaining({ synthesizedTasksJsonl: jsonl }),
      );
    });
  });

  describe("state and concurrency", () => {
    it("passes parent state to executeSwarm", async () => {
      const { swarmTool, backend } = getSwarmTool();
      const parentState = { customField: "value" };

      vi.mocked(getCurrentTaskInput).mockReturnValue(parentState);
      backend.readRaw.mockResolvedValue({
        data: { content: '{"id":"t1","description":"task"}' },
      });
      vi.mocked(parseTasksJsonl).mockReturnValue([
        { id: "t1", description: "task" },
      ]);
      vi.mocked(executeSwarm).mockResolvedValue(defaultSummary);

      await swarmTool.invoke({ tasksPath: "/tasks.jsonl" });

      expect(executeSwarm).toHaveBeenCalledWith(
        expect.objectContaining({ currentState: parentState }),
      );
    });

    it("uses default concurrency when not specified", async () => {
      const { swarmTool, backend } = getSwarmTool();

      backend.readRaw.mockResolvedValue({
        data: { content: '{"id":"t1","description":"task"}' },
      });
      vi.mocked(parseTasksJsonl).mockReturnValue([
        { id: "t1", description: "task" },
      ]);
      vi.mocked(executeSwarm).mockResolvedValue(defaultSummary);

      await swarmTool.invoke({ tasksPath: "/tasks.jsonl" });

      expect(executeSwarm).toHaveBeenCalledWith(
        expect.objectContaining({ concurrency: 10 }),
      );
    });

    it("passes custom concurrency to executeSwarm", async () => {
      const { swarmTool, backend } = getSwarmTool();

      backend.readRaw.mockResolvedValue({
        data: { content: '{"id":"t1","description":"task"}' },
      });
      vi.mocked(parseTasksJsonl).mockReturnValue([
        { id: "t1", description: "task" },
      ]);
      vi.mocked(executeSwarm).mockResolvedValue(defaultSummary);

      await swarmTool.invoke({ tasksPath: "/tasks.jsonl", concurrency: 5 });

      expect(executeSwarm).toHaveBeenCalledWith(
        expect.objectContaining({ concurrency: 5 }),
      );
    });
  });
});

describe("createSwarmMiddleware", () => {
  it("creates middleware with name 'swarmMiddleware'", () => {
    const middleware = createSwarmMiddleware({
      subagentGraphs: createMockSubagentGraphs(),
      backend: createMockBackend() as any,
    });
    expect(middleware.name).toBe("swarmMiddleware");
  });

  it("includes the swarm tool in the middleware tools", () => {
    const middleware = createSwarmMiddleware({
      subagentGraphs: createMockSubagentGraphs(),
      backend: createMockBackend() as any,
    });
    const toolNames = middleware.tools!.map((t: any) => t.name);
    expect(toolNames).toContain("swarm");
  });

  it("has a wrapModelCall handler", () => {
    const middleware = createSwarmMiddleware({
      subagentGraphs: createMockSubagentGraphs(),
      backend: createMockBackend() as any,
    });
    expect(middleware.wrapModelCall).toBeDefined();
    expect(typeof middleware.wrapModelCall).toBe("function");
  });

  it("appends SWARM_SYSTEM_PROMPT via wrapModelCall", async () => {
    const middleware = createSwarmMiddleware({
      subagentGraphs: createMockSubagentGraphs(),
      backend: createMockBackend() as any,
    });

    let passedRequest: any;
    const handler = vi.fn(async (req: any) => {
      passedRequest = req;
      return {};
    });

    const request = {
      systemMessage: [new SystemMessage({ content: "existing prompt" })],
    };

    await middleware.wrapModelCall!(request as any, handler as any);

    expect(handler).toHaveBeenCalledOnce();
    expect(passedRequest.systemMessage).toHaveLength(2);
    expect(passedRequest.systemMessage[0].content).toBe("existing prompt");
  });
});
