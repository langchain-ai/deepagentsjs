import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSwarm, type SwarmExecutionOptions } from "./executor.js";
import {
  manifestPath,
  resultPath,
  summaryPath,
  taskPath,
} from "./layout.js";
import { serializeManifest } from "./manifest.js";
import { createInMemoryBackend, type InMemoryBackend } from "./test-utils.js";
import { TASK_TIMEOUT_SECONDS, type ManifestEntry, type TaskResult } from "./types.js";

const RUN_DIR = "swarm_runs/test-run";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(id: string, subagentType?: string): ManifestEntry {
  return subagentType
    ? { id, descriptionPath: `tasks/${id}.txt`, subagentType }
    : { id, descriptionPath: `tasks/${id}.txt` };
}

function makeSubagent(
  result: Record<string, unknown> = { messages: [{ content: "result text" }] },
) {
  return { invoke: vi.fn().mockResolvedValue(result) } as any;
}

interface SeedOptions {
  manifestEntries: ManifestEntry[];
  taskContents?: Record<string, string>;
  existingResults?: TaskResult[];
}

function seedRun(opts: SeedOptions): InMemoryBackend {
  const initial: Record<string, string> = {
    [manifestPath(RUN_DIR)]: serializeManifest(opts.manifestEntries),
  };
  for (const e of opts.manifestEntries) {
    const content = opts.taskContents?.[e.id] ?? `prompt for ${e.id}`;
    initial[taskPath(RUN_DIR, e.id)] = content;
  }
  for (const r of opts.existingResults ?? []) {
    initial[resultPath(RUN_DIR, r.id)] = JSON.stringify(r, null, 2);
  }
  return createInMemoryBackend(initial);
}

function defaultOptions(
  backend: InMemoryBackend,
  overrides: Partial<SwarmExecutionOptions> = {},
): SwarmExecutionOptions {
  return {
    backend,
    parentState: {},
    subagentGraphs: { "general-purpose": makeSubagent() },
    maxRetries: 1,
    ...overrides,
  };
}

function readResultFromBackend(
  backend: InMemoryBackend,
  id: string,
): TaskResult | null {
  const raw = backend.files.get(resultPath(RUN_DIR, id));
  return raw ? (JSON.parse(raw) as TaskResult) : null;
}

// ---------------------------------------------------------------------------
// 1. Fresh run — happy path
// ---------------------------------------------------------------------------

describe("executeSwarm — fresh run", () => {
  it("dispatches all manifest entries and writes per-task result files", async () => {
    const subagent = makeSubagent({ messages: [{ content: "ok" }] });
    const backend = seedRun({
      manifestEntries: [entry("a"), entry("b"), entry("c")],
    });

    const summary = await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent },
      }),
    );

    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.dispatched).toBe(3);
    expect(summary.skipped).toBe(0);
    expect(subagent.invoke).toHaveBeenCalledTimes(3);

    for (const id of ["a", "b", "c"]) {
      const result = readResultFromBackend(backend, id);
      expect(result?.status).toBe("completed");
    }
  });

  it("invokes the subagent with a HumanMessage carrying the task content", async () => {
    const subagent = makeSubagent();
    const backend = seedRun({
      manifestEntries: [entry("a")],
      taskContents: { a: "Research topic X" },
    });

    await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent },
      }),
    );

    expect(subagent.invoke).toHaveBeenCalledOnce();
    const [state] = subagent.invoke.mock.calls[0];
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("Research topic X");
  });

  it("writes a summary.json with start and finish timestamps", async () => {
    const backend = seedRun({ manifestEntries: [entry("a")] });
    const summary = await executeSwarm(RUN_DIR, defaultOptions(backend));

    const stored = backend.files.get(summaryPath(RUN_DIR));
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.runDir).toBe(RUN_DIR);
    expect(parsed.completed).toBe(1);
    expect(parsed.startedAt).toBe(summary.startedAt);
    expect(parsed.finishedAt).toBe(summary.finishedAt);
  });
});

// ---------------------------------------------------------------------------
// 2. Retry semantics
// ---------------------------------------------------------------------------

describe("executeSwarm — retries", () => {
  it("records `attempts` matching the successful attempt number", async () => {
    const subagent = {
      invoke: vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce({ messages: [{ content: "recovered" }] }),
    };
    const backend = seedRun({ manifestEntries: [entry("a")] });

    await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent as any },
        maxRetries: 3,
      }),
    );

    const result = readResultFromBackend(backend, "a");
    expect(result?.status).toBe("completed");
    expect(result?.attempts).toBe(2);
  });

  it("writes a failed result with the last error after maxRetries", async () => {
    const subagent = {
      invoke: vi.fn().mockRejectedValue(new Error("persistent failure")),
    };
    const backend = seedRun({ manifestEntries: [entry("a")] });

    const summary = await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent as any },
        maxRetries: 3,
      }),
    );

    expect(summary.failed).toBe(1);
    expect(summary.completed).toBe(0);
    const result = readResultFromBackend(backend, "a");
    expect(result?.status).toBe("failed");
    if (result?.status === "failed") {
      expect(result.error).toBe("persistent failure");
      expect(result.attempts).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Resume semantics
// ---------------------------------------------------------------------------

describe("executeSwarm — resume", () => {
  it("skips already-completed tasks and only dispatches missing ones", async () => {
    const subagent = makeSubagent();
    const backend = seedRun({
      manifestEntries: [entry("a"), entry("b"), entry("c")],
      existingResults: [
        {
          id: "a",
          status: "completed",
          subagentType: "general-purpose",
          attempts: 1,
          startedAt: "2024-01-01T00:00:00.000Z",
          finishedAt: "2024-01-01T00:00:01.000Z",
          result: "previous run",
        },
      ],
    });

    const summary = await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent },
      }),
    );

    expect(summary.skipped).toBe(1);
    expect(summary.dispatched).toBe(2);
    expect(summary.completed).toBe(3);
    expect(subagent.invoke).toHaveBeenCalledTimes(2);

    // Original result must be preserved verbatim.
    const aResult = readResultFromBackend(backend, "a");
    expect(aResult?.status === "completed" && aResult.result).toBe(
      "previous run",
    );
  });

  it("leaves failed tasks alone by default", async () => {
    const subagent = makeSubagent();
    const backend = seedRun({
      manifestEntries: [entry("a")],
      existingResults: [
        {
          id: "a",
          status: "failed",
          subagentType: "general-purpose",
          attempts: 3,
          startedAt: "2024-01-01T00:00:00.000Z",
          finishedAt: "2024-01-01T00:00:01.000Z",
          error: "previously broken",
        },
      ],
    });

    const summary = await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent },
      }),
    );

    expect(summary.skipped).toBe(1);
    expect(summary.dispatched).toBe(0);
    expect(summary.failed).toBe(1);
    expect(subagent.invoke).not.toHaveBeenCalled();
  });

  it("re-dispatches failed tasks when retryFailed is true", async () => {
    const subagent = makeSubagent({ messages: [{ content: "fixed" }] });
    const backend = seedRun({
      manifestEntries: [entry("a")],
      existingResults: [
        {
          id: "a",
          status: "failed",
          subagentType: "general-purpose",
          attempts: 3,
          startedAt: "2024-01-01T00:00:00.000Z",
          finishedAt: "2024-01-01T00:00:01.000Z",
          error: "old failure",
        },
      ],
    });

    const summary = await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent },
        retryFailed: true,
      }),
    );

    expect(summary.dispatched).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    const a = readResultFromBackend(backend, "a");
    expect(a?.status).toBe("completed");
  });

  it("reports orphaned result ids", async () => {
    const subagent = makeSubagent();
    const backend = seedRun({
      manifestEntries: [entry("a")],
      existingResults: [
        {
          id: "ghost",
          status: "completed",
          subagentType: "general-purpose",
          attempts: 1,
          startedAt: "2024-01-01T00:00:00.000Z",
          finishedAt: "2024-01-01T00:00:01.000Z",
          result: "leftover",
        },
      ],
    });

    const summary = await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent },
      }),
    );

    expect(summary.orphanedResultIds).toEqual(["ghost"]);
    // Orphans are reported but never deleted.
    expect(backend.files.has(resultPath(RUN_DIR, "ghost"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Pre-dispatch failures
// ---------------------------------------------------------------------------

describe("executeSwarm — pre-dispatch failures", () => {
  it("writes a failed result when a task file is missing", async () => {
    const subagent = makeSubagent();
    const backend = seedRun({
      manifestEntries: [entry("a"), entry("b")],
    });
    backend.files.delete(taskPath(RUN_DIR, "a"));

    const summary = await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent },
      }),
    );

    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
    const result = readResultFromBackend(backend, "a");
    expect(result?.status).toBe("failed");
    if (result?.status === "failed") {
      expect(result.error).toContain("task file missing");
    }
    expect(subagent.invoke).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Validation
// ---------------------------------------------------------------------------

describe("executeSwarm — validation", () => {
  it("throws when manifest references an unknown subagent type", async () => {
    const subagent = makeSubagent();
    const backend = seedRun({
      manifestEntries: [entry("a", "nonexistent")],
    });

    await expect(
      executeSwarm(
        RUN_DIR,
        defaultOptions(backend, {
          subagentGraphs: { "general-purpose": subagent },
        }),
      ),
    ).rejects.toThrow(/unknown subagentType/);
    expect(subagent.invoke).not.toHaveBeenCalled();
  });

  it("includes available subagent types in the error message", async () => {
    const backend = seedRun({ manifestEntries: [entry("a", "bad")] });
    await expect(
      executeSwarm(
        RUN_DIR,
        defaultOptions(backend, {
          subagentGraphs: {
            "general-purpose": makeSubagent(),
            researcher: makeSubagent(),
          },
        }),
      ),
    ).rejects.toThrow(/Available:.*researcher/);
  });

  it("rejects when the manifest does not exist", async () => {
    const backend = createInMemoryBackend();
    await expect(
      executeSwarm(RUN_DIR, defaultOptions(backend)),
    ).rejects.toThrow(/manifest not found/);
  });
});

// ---------------------------------------------------------------------------
// 6. Concurrency limiting
// ---------------------------------------------------------------------------

describe("executeSwarm — concurrency", () => {
  it("respects concurrency=1 by running tasks sequentially", async () => {
    const order: string[] = [];
    const subagent = {
      invoke: vi.fn(async (state: any) => {
        order.push(state.messages[0].content);
        return { messages: [{ content: "done" }] };
      }),
    };
    const backend = seedRun({
      manifestEntries: [entry("a"), entry("b"), entry("c")],
      taskContents: { a: "first", b: "second", c: "third" },
    });

    await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent as any },
        concurrency: 1,
      }),
    );

    expect(order).toEqual(["first", "second", "third"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Timeout
// ---------------------------------------------------------------------------

describe("executeSwarm — timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a hanging task as failed with a timeout error", async () => {
    const hanging = {
      invoke: vi.fn(
        () =>
          new Promise<never>(() => {
            /* never resolves */
          }),
      ),
    };
    const backend = seedRun({ manifestEntries: [entry("a")] });

    const promise = executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": hanging as any },
      }),
    );

    await vi.advanceTimersByTimeAsync(TASK_TIMEOUT_SECONDS * 1000 + 1000);
    const summary = await promise;

    expect(summary.failed).toBe(1);
    const result = readResultFromBackend(backend, "a");
    expect(result?.status).toBe("failed");
    if (result?.status === "failed") {
      expect(result.error).toContain("timed out");
      expect(result.error).toContain(String(TASK_TIMEOUT_SECONDS));
    }
  });
});

// ---------------------------------------------------------------------------
// 8. State filtering
// ---------------------------------------------------------------------------

describe("executeSwarm — filterStateForSubagent", () => {
  const EXCLUDED = [
    "messages",
    "todos",
    "structuredResponse",
    "skillsMetadata",
    "memoryContents",
  ];

  it("strips excluded keys from the state passed to subagents", async () => {
    const subagent = makeSubagent();
    const backend = seedRun({ manifestEntries: [entry("a")] });
    const parentState: Record<string, unknown> = {
      messages: [{ content: "old" }],
      todos: ["x"],
      structuredResponse: { foo: 1 },
      skillsMetadata: {},
      memoryContents: "memory",
      keepMe: "yes",
    };

    await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent },
        parentState,
      }),
    );

    const [state] = subagent.invoke.mock.calls[0];
    for (const key of EXCLUDED) {
      if (key === "messages") {
        expect(state.messages).toHaveLength(1);
      } else {
        expect(state).not.toHaveProperty(key);
      }
    }
    expect(state.keepMe).toBe("yes");
  });
});

// ---------------------------------------------------------------------------
// 9. extractResultText behavior
// ---------------------------------------------------------------------------

describe("executeSwarm — extractResultText", () => {
  it("uses structuredResponse when present", async () => {
    const data = { answer: 42 };
    const subagent = makeSubagent({
      messages: [{ content: "ignored" }],
      structuredResponse: data,
    });
    const backend = seedRun({ manifestEntries: [entry("a")] });

    await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent },
      }),
    );

    const result = readResultFromBackend(backend, "a");
    expect(result?.status === "completed" && result.result).toBe(
      JSON.stringify(data),
    );
  });

  it("filters tool_use, thinking, and redacted_thinking blocks from array content", async () => {
    const subagent = makeSubagent({
      messages: [
        {
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: "visible" },
            { type: "tool_use", id: "1", name: "x", input: {} },
          ],
        },
      ],
    });
    const backend = seedRun({ manifestEntries: [entry("a")] });

    await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent },
      }),
    );

    const result = readResultFromBackend(backend, "a");
    expect(result?.status === "completed" && result.result).toBe("visible");
  });

  it("returns 'Task completed (no output)' for an empty messages array", async () => {
    const subagent = makeSubagent({ messages: [] });
    const backend = seedRun({ manifestEntries: [entry("a")] });

    await executeSwarm(
      RUN_DIR,
      defaultOptions(backend, {
        subagentGraphs: { "general-purpose": subagent },
      }),
    );

    const result = readResultFromBackend(backend, "a");
    expect(result?.status === "completed" && result.result).toBe(
      "Task completed (no output)",
    );
  });
});
