import { describe, it, expect, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import { executeSwarm, type SwarmExecutionOptions } from "./executor.js";
import type { SwarmTaskSpec } from "./types.js";
import type { BackendProtocolV2 } from "../backends/v2/protocol.js";

function createMockSubagent(
  response: Record<string, unknown> = { messages: [new AIMessage("done")] },
  delay = 0,
) {
  return {
    invoke: vi.fn(async (..._args: unknown[]) => {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return response;
    }),
  } as unknown as Runnable & { invoke: ReturnType<typeof vi.fn> };
}

function createThrowingMockSubagent(error: Error, delay = 0) {
  return {
    invoke: vi.fn(async (..._args: unknown[]) => {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      throw error;
    }),
  } as unknown as Runnable & { invoke: ReturnType<typeof vi.fn> };
}

function createMockBackend(): BackendProtocolV2 & {
  writtenFiles: Record<string, string>;
} {
  const writtenFiles: Record<string, string> = {};
  return {
    writtenFiles,
    write: vi.fn(async (path: string, content: string) => {
      writtenFiles[path] = content;
      return {};
    }),
  } as unknown as BackendProtocolV2 & { writtenFiles: Record<string, string> };
}

function buildOptions(
  overrides: Partial<SwarmExecutionOptions> = {},
): SwarmExecutionOptions {
  const tasks: SwarmTaskSpec[] = overrides.tasks ?? [
    { id: "t1", description: "Task one" },
    { id: "t2", description: "Task two" },
  ];

  return {
    tasks,
    subagentGraphs: overrides.subagentGraphs ?? {
      "general-purpose": createMockSubagent(),
    },
    backend: overrides.backend ?? createMockBackend(),
    currentState: overrides.currentState ?? {},
    ...overrides,
  };
}

describe("executeSwarm", () => {
  describe("happy path", () => {
    it("dispatches all tasks and returns a summary", async () => {
      const subagent = createMockSubagent({
        messages: [new AIMessage("result")],
      });
      const options = buildOptions({
        subagentGraphs: { "general-purpose": subagent },
      });

      const summary = await executeSwarm(options);

      expect(summary.total).toBe(2);
      expect(summary.completed).toBe(2);
      expect(summary.failed).toBe(0);
      expect(summary.failedTasks).toHaveLength(0);
      expect(summary.resultsDir).toMatch(/^\/swarm_runs\//);
      expect(subagent.invoke).toHaveBeenCalledTimes(2);

      expect(summary.results).toHaveLength(2);
      expect(summary.results[0]).toMatchObject({
        id: "t1",
        subagentType: "general-purpose",
        status: "completed",
        result: "result",
      });
      expect(summary.results[1]).toMatchObject({
        id: "t2",
        subagentType: "general-purpose",
        status: "completed",
        result: "result",
      });
    });

    it("passes task description as HumanMessage to subagent", async () => {
      const subagent = createMockSubagent();
      const options = buildOptions({
        tasks: [{ id: "t1", description: "Do the thing" }],
        subagentGraphs: { "general-purpose": subagent },
      });

      await executeSwarm(options);

      const calls = subagent.invoke.mock.calls as unknown[][];
      const invokedState = calls[0][0] as Record<string, unknown>;
      const messages = invokedState.messages as HumanMessage[];
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Do the thing");
    });

    it("routes tasks to the correct subagent type", async () => {
      const generalAgent = createMockSubagent();
      const analystAgent = createMockSubagent();
      const options = buildOptions({
        tasks: [
          { id: "t1", description: "general task" },
          { id: "t2", description: "analyst task", subagentType: "analyst" },
        ],
        subagentGraphs: {
          "general-purpose": generalAgent,
          analyst: analystAgent,
        },
      });

      await executeSwarm(options);

      expect(generalAgent.invoke).toHaveBeenCalledTimes(1);
      expect(analystAgent.invoke).toHaveBeenCalledTimes(1);
    });
  });

  describe("result extraction", () => {
    it("extracts string content from AIMessage", async () => {
      const backend = createMockBackend();
      const options = buildOptions({
        tasks: [{ id: "t1", description: "task" }],
        subagentGraphs: {
          "general-purpose": createMockSubagent({
            messages: [new AIMessage("extracted text")],
          }),
        },
        backend,
      });

      await executeSwarm(options);

      const resultsFile = Object.entries(backend.writtenFiles).find(([k]) =>
        k.endsWith("results.jsonl"),
      );
      expect(resultsFile).toBeDefined();
      const parsed = JSON.parse(resultsFile![1].trim());
      expect(parsed.result).toBe("extracted text");
    });

    it("extracts structuredResponse as JSON", async () => {
      const backend = createMockBackend();
      const options = buildOptions({
        tasks: [{ id: "t1", description: "task" }],
        subagentGraphs: {
          "general-purpose": createMockSubagent({
            structuredResponse: { category: "bug" },
            messages: [new AIMessage("ignored")],
          }),
        },
        backend,
      });

      await executeSwarm(options);

      const resultsFile = Object.entries(backend.writtenFiles).find(([k]) =>
        k.endsWith("results.jsonl"),
      );
      const parsed = JSON.parse(resultsFile![1].trim());
      expect(parsed.result).toBe('{"category":"bug"}');
    });

    it("extracts text from array content blocks", async () => {
      const backend = createMockBackend();
      const msg = new AIMessage({
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      });
      const options = buildOptions({
        tasks: [{ id: "t1", description: "task" }],
        subagentGraphs: {
          "general-purpose": createMockSubagent({ messages: [msg] }),
        },
        backend,
      });

      await executeSwarm(options);

      const resultsFile = Object.entries(backend.writtenFiles).find(([k]) =>
        k.endsWith("results.jsonl"),
      );
      const parsed = JSON.parse(resultsFile![1].trim());
      expect(parsed.result).toBe("hello\nworld");
    });

    it("filters out thinking and tool_use blocks", async () => {
      const backend = createMockBackend();
      const msg = new AIMessage({
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "x", name: "t", input: {} },
        ],
      });
      const options = buildOptions({
        tasks: [{ id: "t1", description: "task" }],
        subagentGraphs: {
          "general-purpose": createMockSubagent({ messages: [msg] }),
        },
        backend,
      });

      await executeSwarm(options);

      const resultsFile = Object.entries(backend.writtenFiles).find(([k]) =>
        k.endsWith("results.jsonl"),
      );
      const parsed = JSON.parse(resultsFile![1].trim());
      expect(parsed.result).toBe("answer");
    });

    it("falls back to 'Task completed' for empty messages", async () => {
      const backend = createMockBackend();
      const options = buildOptions({
        tasks: [{ id: "t1", description: "task" }],
        subagentGraphs: {
          "general-purpose": createMockSubagent({ messages: [] }),
        },
        backend,
      });

      await executeSwarm(options);

      const resultsFile = Object.entries(backend.writtenFiles).find(([k]) =>
        k.endsWith("results.jsonl"),
      );
      const parsed = JSON.parse(resultsFile![1].trim());
      expect(parsed.result).toBe("Task completed");
    });
  });

  describe("error handling", () => {
    it("captures subagent errors as failed tasks", async () => {
      const options = buildOptions({
        tasks: [{ id: "t1", description: "will fail" }],
        subagentGraphs: {
          "general-purpose": createThrowingMockSubagent(new Error("boom")),
        },
      });

      const summary = await executeSwarm(options);

      expect(summary.failed).toBe(1);
      expect(summary.completed).toBe(0);
      expect(summary.failedTasks).toHaveLength(1);
      expect(summary.failedTasks[0].id).toBe("t1");
      expect(summary.failedTasks[0].error).toBe("boom");

      expect(summary.results).toHaveLength(1);
      expect(summary.results[0]).toMatchObject({
        id: "t1",
        status: "failed",
        error: "boom",
      });
    });

    it("throws on unknown subagent type", async () => {
      const options = buildOptions({
        tasks: [{ id: "t1", description: "task", subagentType: "nonexistent" }],
        subagentGraphs: { "general-purpose": createMockSubagent() },
      });

      await expect(executeSwarm(options)).rejects.toThrow(
        "Unknown subagent type(s): nonexistent",
      );
    });

    it("reports available subagent types in the error", async () => {
      const options = buildOptions({
        tasks: [{ id: "t1", description: "task", subagentType: "missing" }],
        subagentGraphs: {
          "general-purpose": createMockSubagent(),
          analyst: createMockSubagent(),
        },
      });

      await expect(executeSwarm(options)).rejects.toThrow(
        "Available: general-purpose, analyst",
      );
    });

    it("handles mixed success and failure", async () => {
      const successAgent = createMockSubagent({
        messages: [new AIMessage("ok")],
      });
      const failAgent = createThrowingMockSubagent(new Error("failed"));

      const options = buildOptions({
        tasks: [
          { id: "t1", description: "succeeds" },
          { id: "t2", description: "fails", subagentType: "flaky" },
        ],
        subagentGraphs: {
          "general-purpose": successAgent,
          flaky: failAgent,
        },
      });

      const summary = await executeSwarm(options);

      expect(summary.total).toBe(2);
      expect(summary.completed).toBe(1);
      expect(summary.failed).toBe(1);

      expect(summary.results).toHaveLength(2);
      const completed = summary.results.find((r) => r.status === "completed");
      const failed = summary.results.find((r) => r.status === "failed");
      expect(completed).toMatchObject({ id: "t1", result: "ok" });
      expect(failed).toMatchObject({ id: "t2", error: "failed" });
    });
  });

  describe("file output", () => {
    it("writes results.jsonl to the run directory", async () => {
      const backend = createMockBackend();
      const options = buildOptions({
        tasks: [{ id: "t1", description: "task" }],
        backend,
      });

      const summary = await executeSwarm(options);

      const resultsPath = `${summary.resultsDir}/results.jsonl`;
      expect(backend.writtenFiles[resultsPath]).toBeDefined();

      const lines = backend.writtenFiles[resultsPath]
        .split("\n")
        .filter((l) => l.trim());
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).id).toBe("t1");
    });

    it("writes tasks.jsonl when synthesizedTasksJsonl is provided", async () => {
      const backend = createMockBackend();
      const tasksJsonl = '{"id":"t1","description":"task"}\n';
      const options = buildOptions({
        tasks: [{ id: "t1", description: "task" }],
        backend,
        synthesizedTasksJsonl: tasksJsonl,
      });

      const summary = await executeSwarm(options);

      const tasksPath = `${summary.resultsDir}/tasks.jsonl`;
      expect(backend.writtenFiles[tasksPath]).toBe(tasksJsonl);
    });

    it("does not write tasks.jsonl when synthesizedTasksJsonl is not provided", async () => {
      const backend = createMockBackend();
      const options = buildOptions({
        tasks: [{ id: "t1", description: "task" }],
        backend,
      });

      const summary = await executeSwarm(options);

      const tasksPath = `${summary.resultsDir}/tasks.jsonl`;
      expect(backend.writtenFiles[tasksPath]).toBeUndefined();
    });
  });

  describe("state filtering", () => {
    it("excludes messages, todos, structuredResponse from subagent state", async () => {
      const subagent = createMockSubagent();
      const options = buildOptions({
        tasks: [{ id: "t1", description: "task" }],
        subagentGraphs: { "general-purpose": subagent },
        currentState: {
          messages: ["should be excluded"],
          todos: ["should be excluded"],
          structuredResponse: "should be excluded",
          skillsMetadata: "should be excluded",
          memoryContents: "should be excluded",
          customField: "should be kept",
        },
      });

      await executeSwarm(options);

      const invokedState = subagent.invoke.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(invokedState).not.toHaveProperty("todos");
      expect(invokedState).not.toHaveProperty("structuredResponse");
      expect(invokedState).not.toHaveProperty("skillsMetadata");
      expect(invokedState).not.toHaveProperty("memoryContents");
      expect(invokedState.customField).toBe("should be kept");
      // messages is replaced with the task HumanMessage
      expect(invokedState.messages).toHaveLength(1);
    });
  });

  describe("concurrency", () => {
    it("respects the concurrency limit", async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const subagent = {
        invoke: vi.fn(async () => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise((resolve) => setTimeout(resolve, 50));
          currentConcurrent--;
          return { messages: [new AIMessage("done")] };
        }),
      } as unknown as Runnable & { invoke: ReturnType<typeof vi.fn> };

      const tasks: SwarmTaskSpec[] = Array.from({ length: 10 }, (_, i) => ({
        id: `t${i}`,
        description: `task ${i}`,
      }));

      const options = buildOptions({
        tasks,
        subagentGraphs: { "general-purpose": subagent },
        concurrency: 3,
      });

      await executeSwarm(options);

      expect(maxConcurrent).toBeLessThanOrEqual(3);
      expect(subagent.invoke).toHaveBeenCalledTimes(10);
    });

    it("clamps concurrency to MAX_CONCURRENCY", async () => {
      const subagent = createMockSubagent();
      const options = buildOptions({
        tasks: [{ id: "t1", description: "task" }],
        subagentGraphs: { "general-purpose": subagent },
        concurrency: 999,
      });

      const summary = await executeSwarm(options);

      expect(summary.completed).toBe(1);
    });
  });

  describe("responseSchema", () => {
    describe("validation", () => {
      it("rejects responseSchema with non-object top-level type", async () => {
        const options = buildOptions({
          tasks: [
            {
              id: "t1",
              description: "task",
              responseSchema: { type: "array", items: { type: "string" } },
            },
          ],
        });

        await expect(executeSwarm(options)).rejects.toThrow(
          `responseSchema must have type "object" at the top level`,
        );
      });

      it("includes the offending task id in the error", async () => {
        const options = buildOptions({
          tasks: [
            { id: "t1", description: "ok task" },
            {
              id: "t2",
              description: "bad task",
              responseSchema: { type: "string" },
            },
          ],
        });

        await expect(executeSwarm(options)).rejects.toThrow(
          `"t2" has type "string"`,
        );
      });

      it("includes all offending task ids when multiple are invalid", async () => {
        const options = buildOptions({
          tasks: [
            {
              id: "t1",
              description: "task",
              responseSchema: { type: "array" },
            },
            {
              id: "t2",
              description: "task",
              responseSchema: { type: "string" },
            },
          ],
        });

        await expect(executeSwarm(options)).rejects.toThrow(`"t1"`);
        await expect(executeSwarm(options)).rejects.toThrow(`"t2"`);
      });

      it("rejects responseSchema with no properties", async () => {
        const options = buildOptions({
          tasks: [
            {
              id: "t1",
              description: "task",
              responseSchema: {
                type: "object",
                additionalProperties: { type: "string" },
              },
            },
          ],
        });

        await expect(executeSwarm(options)).rejects.toThrow(
          `responseSchema must define "properties" with at least one field`,
        );
      });

      it("rejects responseSchema with empty properties", async () => {
        const options = buildOptions({
          tasks: [
            {
              id: "t1",
              description: "task",
              responseSchema: { type: "object", properties: {} },
            },
          ],
        });

        await expect(executeSwarm(options)).rejects.toThrow(
          `responseSchema must define "properties" with at least one field`,
        );
      });

      it("accepts responseSchema with type: object", async () => {
        const options = buildOptions({
          tasks: [
            {
              id: "t1",
              description: "task",
              responseSchema: {
                type: "object",
                properties: { label: { type: "string" } },
              },
            },
          ],
        });

        await expect(executeSwarm(options)).resolves.toMatchObject({
          completed: 1,
        });
      });
    });

    describe("factory dispatch", () => {
      it("calls the factory with the responseSchema and uses the compiled variant", async () => {
        const defaultGraph = createMockSubagent({
          messages: [new AIMessage("default")],
        });
        const variantGraph = createMockSubagent({
          messages: [new AIMessage("variant")],
        });
        const factory = vi.fn(() => variantGraph);

        const schema = {
          type: "object",
          properties: { label: { type: "string" } },
        };
        const options = buildOptions({
          tasks: [{ id: "t1", description: "task", responseSchema: schema }],
          subagentGraphs: { "general-purpose": defaultGraph },
          subagentFactories: { "general-purpose": factory },
        });

        const summary = await executeSwarm(options);

        expect(factory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith(schema);
        expect(variantGraph.invoke).toHaveBeenCalledTimes(1);
        expect(defaultGraph.invoke).not.toHaveBeenCalled();
        expect(summary.results[0].result).toBe("variant");
      });

      it("caches the compiled variant — factory called once for same schema across multiple tasks", async () => {
        const variantGraph = createMockSubagent({
          messages: [new AIMessage("ok")],
        });
        const factory = vi.fn(() => variantGraph);

        const schema = {
          type: "object",
          properties: { n: { type: "number" } },
        };
        const options = buildOptions({
          tasks: [
            { id: "t1", description: "task 1", responseSchema: schema },
            { id: "t2", description: "task 2", responseSchema: schema },
            { id: "t3", description: "task 3", responseSchema: schema },
          ],
          subagentGraphs: { "general-purpose": createMockSubagent() },
          subagentFactories: { "general-purpose": factory },
        });

        await executeSwarm(options);

        expect(factory).toHaveBeenCalledTimes(1);
        expect(variantGraph.invoke).toHaveBeenCalledTimes(3);
      });

      it("compiles separate variants for different schemas", async () => {
        const variantA = createMockSubagent({ messages: [new AIMessage("a")] });
        const variantB = createMockSubagent({ messages: [new AIMessage("b")] });
        const factory = vi
          .fn()
          .mockReturnValueOnce(variantA)
          .mockReturnValueOnce(variantB);

        const schemaA = {
          type: "object",
          properties: { x: { type: "number" } },
        };
        const schemaB = {
          type: "object",
          properties: { y: { type: "string" } },
        };
        const options = buildOptions({
          tasks: [
            { id: "t1", description: "task 1", responseSchema: schemaA },
            { id: "t2", description: "task 2", responseSchema: schemaB },
          ],
          subagentGraphs: { "general-purpose": createMockSubagent() },
          subagentFactories: { "general-purpose": factory },
        });

        await executeSwarm(options);

        expect(factory).toHaveBeenCalledTimes(2);
        expect(factory).toHaveBeenNthCalledWith(1, schemaA);
        expect(factory).toHaveBeenNthCalledWith(2, schemaB);
        expect(variantA.invoke).toHaveBeenCalledTimes(1);
        expect(variantB.invoke).toHaveBeenCalledTimes(1);
      });

      it("falls back to the default graph when no factory exists for the subagent type", async () => {
        const defaultGraph = createMockSubagent({
          messages: [new AIMessage("default")],
        });
        const schema = {
          type: "object",
          properties: { x: { type: "number" } },
        };
        const options = buildOptions({
          tasks: [{ id: "t1", description: "task", responseSchema: schema }],
          subagentGraphs: { "general-purpose": defaultGraph },
          // No subagentFactories
        });

        const summary = await executeSwarm(options);

        expect(defaultGraph.invoke).toHaveBeenCalledTimes(1);
        expect(summary.results[0].result).toBe("default");
      });

      it("uses the default graph for tasks without responseSchema even when factories exist", async () => {
        const defaultGraph = createMockSubagent({
          messages: [new AIMessage("default")],
        });
        const factory = vi.fn(() => createMockSubagent());

        const options = buildOptions({
          tasks: [{ id: "t1", description: "task" }],
          subagentGraphs: { "general-purpose": defaultGraph },
          subagentFactories: { "general-purpose": factory },
        });

        await executeSwarm(options);

        expect(factory).not.toHaveBeenCalled();
        expect(defaultGraph.invoke).toHaveBeenCalledTimes(1);
      });
    });
  });
});
