import { describe, expect, it, vi } from "vitest";
import { SystemMessage } from "@langchain/core/messages";
import {
  createSwarmAddTasksTool,
  createSwarmGetResultsTool,
  createSwarmInitTool,
  createSwarmMiddleware,
  createSwarmTool,
  SWARM_BASE_PROMPT,
  SWARM_TOOL_NAMES,
  SWARM_WITH_EXECUTE_PROMPT,
  SWARM_WITHOUT_EXECUTE_PROMPT,
} from "./swarm.js";
import { manifestPath, resultPath, taskPath } from "../swarm/layout.js";
import { serializeManifest } from "../swarm/manifest.js";
import {
  createInMemoryBackend,
  type InMemoryBackend,
} from "../swarm/test-utils.js";
import type {
  CompletedResult,
  ManifestEntry,
  SwarmGetResultsResponse,
} from "../swarm/types.js";

vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/langgraph")>();
  return { ...actual, getCurrentTaskInput: vi.fn().mockReturnValue({}) };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSubagent(text = "ok") {
  return {
    invoke: vi.fn().mockResolvedValue({ messages: [{ content: text }] }),
  } as any;
}

function entry(id: string, subagentType?: string): ManifestEntry {
  return subagentType
    ? { id, descriptionPath: `tasks/${id}.txt`, subagentType }
    : { id, descriptionPath: `tasks/${id}.txt` };
}

const RUN_DIR = "swarm_runs/test-run";

function seedInitializedRun(extra: Record<string, string> = {}): InMemoryBackend {
  return createInMemoryBackend({
    [manifestPath(RUN_DIR)]: "",
    ...extra,
  });
}

function makeSandboxBackend(base: InMemoryBackend): any {
  // The middleware uses isSandboxBackend, which checks for `execute` (function)
  // and `id` (non-empty string). Adding both turns our in-memory backend into
  // a structurally-valid sandbox backend for prompt-rendering purposes.
  return Object.assign(base, {
    id: "test-sandbox",
    execute: vi.fn().mockResolvedValue({ output: "", exitCode: 0, truncated: false }),
  });
}

// ---------------------------------------------------------------------------
// SWARM_TOOL_NAMES
// ---------------------------------------------------------------------------

describe("SWARM_TOOL_NAMES", () => {
  it("contains exactly the four swarm tool names", () => {
    expect([...SWARM_TOOL_NAMES].sort()).toEqual(
      ["swarm", "swarm_add_tasks", "swarm_get_results", "swarm_init"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// swarm_init
// ---------------------------------------------------------------------------

describe("swarm_init", () => {
  it("creates a runDir with an empty manifest", async () => {
    const backend = createInMemoryBackend();
    const tool = createSwarmInitTool({ backend });
    const result = JSON.parse(
      (await tool.invoke({ name: "test-run" })) as string,
    );
    expect(result.runDir).toBe(RUN_DIR);
    expect(backend.files.get(manifestPath(RUN_DIR))).toBe("");
  });

  it("generates a uuid-suffixed name when name is omitted", async () => {
    const backend = createInMemoryBackend();
    const tool = createSwarmInitTool({ backend });
    const result = JSON.parse((await tool.invoke({})) as string);
    expect(result.runDir).toMatch(/^swarm_runs\/[a-f0-9]{12}$/);
  });

  it("returns an error when the run already exists", async () => {
    const backend = createInMemoryBackend({
      [manifestPath(RUN_DIR)]: serializeManifest([entry("a")]),
    });
    const tool = createSwarmInitTool({ backend });
    const result = JSON.parse(
      (await tool.invoke({ name: "test-run" })) as string,
    );
    expect(result.error).toContain("already exists");
  });
});

// ---------------------------------------------------------------------------
// swarm_add_tasks
// ---------------------------------------------------------------------------

describe("swarm_add_tasks", () => {
  it("writes task files and appends manifest entries", async () => {
    const backend = seedInitializedRun();
    const tool = createSwarmAddTasksTool({ backend });

    const result = JSON.parse(
      (await tool.invoke({
        runDir: RUN_DIR,
        tasks: [
          { id: "a", content: "do a" },
          { id: "b", content: "do b", subagentType: "researcher" },
        ],
      })) as string,
    );

    expect(result.added).toBe(2);
    expect(result.ids).toEqual(["a", "b"]);
    expect(backend.files.get(taskPath(RUN_DIR, "a"))).toBe("do a");
    expect(backend.files.get(taskPath(RUN_DIR, "b"))).toBe("do b");

    const manifestRaw = backend.files.get(manifestPath(RUN_DIR))!;
    const lines = manifestRaw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(entry("a"));
    expect(JSON.parse(lines[1])).toEqual(entry("b", "researcher"));
  });

  it("rejects duplicate ids within a single batch", async () => {
    const backend = seedInitializedRun();
    const tool = createSwarmAddTasksTool({ backend });
    const result = JSON.parse(
      (await tool.invoke({
        runDir: RUN_DIR,
        tasks: [
          { id: "x", content: "one" },
          { id: "x", content: "two" },
        ],
      })) as string,
    );
    expect(result.error).toContain("duplicate id 'x'");
  });

  it("rejects ids that already exist in the manifest", async () => {
    const backend = createInMemoryBackend({
      [manifestPath(RUN_DIR)]: serializeManifest([entry("a")]),
    });
    const tool = createSwarmAddTasksTool({ backend });
    const result = JSON.parse(
      (await tool.invoke({
        runDir: RUN_DIR,
        tasks: [{ id: "a", content: "again" }],
      })) as string,
    );
    expect(result.error).toContain("already exists");
  });

  it("returns an error when the run is not initialized", async () => {
    const backend = createInMemoryBackend();
    const tool = createSwarmAddTasksTool({ backend });
    const result = JSON.parse(
      (await tool.invoke({
        runDir: RUN_DIR,
        tasks: [{ id: "a", content: "x" }],
      })) as string,
    );
    expect(result.error).toContain("not initialized");
  });

  it("does not append to the manifest when a task file write fails", async () => {
    const backend = seedInitializedRun();
    backend.failWriteFor.add(taskPath(RUN_DIR, "b"));
    const tool = createSwarmAddTasksTool({ backend });

    const result = JSON.parse(
      (await tool.invoke({
        runDir: RUN_DIR,
        tasks: [
          { id: "a", content: "ok" },
          { id: "b", content: "boom" },
        ],
      })) as string,
    );

    expect(result.error).toContain("failed to write task file for 'b'");
    // Manifest must NOT have been touched.
    expect(backend.files.get(manifestPath(RUN_DIR))).toBe("");
    // Task file 'a' was written before the failure, but that's fine — it's
    // an orphan, not a dangling manifest reference.
    expect(backend.files.get(taskPath(RUN_DIR, "a"))).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// swarm (executor tool)
// ---------------------------------------------------------------------------

describe("swarm tool", () => {
  it("end-to-end: init → add 3 → run → results all completed", async () => {
    const backend = createInMemoryBackend();
    const subagent = makeSubagent("done");
    const init = createSwarmInitTool({ backend });
    const addTasks = createSwarmAddTasksTool({ backend });
    const run = createSwarmTool({
      backend,
      subagentGraphs: { "general-purpose": subagent },
    });
    const get = createSwarmGetResultsTool({ backend });

    const initResult = JSON.parse(
      (await init.invoke({ name: "e2e" })) as string,
    );
    const runDir = initResult.runDir;

    await addTasks.invoke({
      runDir,
      tasks: [
        { id: "1", content: "first" },
        { id: "2", content: "second" },
        { id: "3", content: "third" },
      ],
    });

    const summary = JSON.parse((await run.invoke({ runDir })) as string);
    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.dispatched).toBe(3);

    const results = JSON.parse(
      (await get.invoke({ runDir })) as string,
    ) as SwarmGetResultsResponse;
    expect(results.total).toBe(3);
    expect(results.results.every((r) => r.status === "completed")).toBe(true);
  });

  it("returns an error JSON when run does not exist", async () => {
    const backend = createInMemoryBackend();
    const tool = createSwarmTool({
      backend,
      subagentGraphs: { "general-purpose": makeSubagent() },
    });
    const result = JSON.parse(
      (await tool.invoke({ runDir: "swarm_runs/missing" })) as string,
    );
    expect(result.error).toContain("run does not exist");
  });

  it("includes available subagent types in the description", () => {
    const backend = createInMemoryBackend();
    const tool = createSwarmTool({
      backend,
      subagentGraphs: {
        "general-purpose": makeSubagent(),
        researcher: makeSubagent(),
      },
    });
    expect(tool.description).toContain("general-purpose");
    expect(tool.description).toContain("researcher");
  });
});

// ---------------------------------------------------------------------------
// swarm_get_results
// ---------------------------------------------------------------------------

describe("swarm_get_results", () => {
  function buildBackendWithResults(): InMemoryBackend {
    const manifest: ManifestEntry[] = [
      entry("a"),
      entry("b"),
      entry("c"),
      entry("d"),
    ];
    const completed = (id: string, text: string): CompletedResult => ({
      id,
      status: "completed",
      subagentType: "general-purpose",
      attempts: 1,
      startedAt: "2024-01-01T00:00:00.000Z",
      finishedAt: "2024-01-01T00:00:01.000Z",
      result: text,
    });

    return createInMemoryBackend({
      [manifestPath(RUN_DIR)]: serializeManifest(manifest),
      [resultPath(RUN_DIR, "a")]: JSON.stringify(completed("a", "alpha")),
      [resultPath(RUN_DIR, "b")]: JSON.stringify(completed("b", "beta")),
      // c and d are pending
    });
  }

  it("returns all entries by default with pending placeholders", async () => {
    const backend = buildBackendWithResults();
    const tool = createSwarmGetResultsTool({ backend });
    const response = JSON.parse(
      (await tool.invoke({ runDir: RUN_DIR })) as string,
    ) as SwarmGetResultsResponse;

    expect(response.total).toBe(4);
    expect(response.pageSize).toBe(4);
    expect(response.hasMore).toBe(false);
    const byId = Object.fromEntries(response.results.map((r) => [r.id, r]));
    expect(byId.a.status).toBe("completed");
    expect(byId.b.status).toBe("completed");
    expect(byId.c.status).toBe("pending");
    expect(byId.d.status).toBe("pending");
  });

  it("paginates with offset and limit", async () => {
    const backend = buildBackendWithResults();
    const tool = createSwarmGetResultsTool({ backend });
    const page1 = JSON.parse(
      (await tool.invoke({ runDir: RUN_DIR, offset: 0, limit: 2 })) as string,
    ) as SwarmGetResultsResponse;
    expect(page1.results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(page1.hasMore).toBe(true);

    const page2 = JSON.parse(
      (await tool.invoke({ runDir: RUN_DIR, offset: 2, limit: 2 })) as string,
    ) as SwarmGetResultsResponse;
    expect(page2.results.map((r) => r.id)).toEqual(["c", "d"]);
    expect(page2.hasMore).toBe(false);
  });

  it("filters by status: completed only", async () => {
    const backend = buildBackendWithResults();
    const tool = createSwarmGetResultsTool({ backend });
    const response = JSON.parse(
      (await tool.invoke({
        runDir: RUN_DIR,
        statusFilter: "completed",
      })) as string,
    ) as SwarmGetResultsResponse;
    expect(response.total).toBe(2);
    expect(response.results.every((r) => r.status === "completed")).toBe(true);
  });

  it("filters by status: pending only", async () => {
    const backend = buildBackendWithResults();
    const tool = createSwarmGetResultsTool({ backend });
    const response = JSON.parse(
      (await tool.invoke({ runDir: RUN_DIR, statusFilter: "pending" })) as string,
    ) as SwarmGetResultsResponse;
    expect(response.total).toBe(2);
    expect(response.results.map((r) => r.id).sort()).toEqual(["c", "d"]);
  });

  it("filters by ids and reports unknown ids in missingIds", async () => {
    const backend = buildBackendWithResults();
    const tool = createSwarmGetResultsTool({ backend });
    const response = JSON.parse(
      (await tool.invoke({
        runDir: RUN_DIR,
        ids: ["a", "ghost"],
      })) as string,
    ) as SwarmGetResultsResponse;
    expect(response.total).toBe(1);
    expect(response.results[0].id).toBe("a");
    expect(response.missingIds).toEqual(["ghost"]);
  });

  it("truncates oversized result content but leaves the file untouched", async () => {
    const huge = "x".repeat(20 * 1024); // 20KB > MAX_RESULT_INLINE_SIZE
    const completed: CompletedResult = {
      id: "a",
      status: "completed",
      subagentType: "general-purpose",
      attempts: 1,
      startedAt: "2024-01-01T00:00:00.000Z",
      finishedAt: "2024-01-01T00:00:01.000Z",
      result: huge,
    };
    const backend = createInMemoryBackend({
      [manifestPath(RUN_DIR)]: serializeManifest([entry("a")]),
      [resultPath(RUN_DIR, "a")]: JSON.stringify(completed),
    });

    const tool = createSwarmGetResultsTool({ backend });
    const response = JSON.parse(
      (await tool.invoke({ runDir: RUN_DIR })) as string,
    ) as SwarmGetResultsResponse;

    const returned = response.results[0];
    if (returned.status === "completed") {
      expect(returned.result.length).toBeLessThan(huge.length);
      expect(returned.result).toContain("[...truncated");
    } else {
      throw new Error("expected completed result");
    }

    // The on-disk file is unchanged.
    const onDisk = JSON.parse(backend.files.get(resultPath(RUN_DIR, "a"))!);
    expect(onDisk.result.length).toBe(huge.length);
  });

  it("returns an error JSON when run does not exist", async () => {
    const backend = createInMemoryBackend();
    const tool = createSwarmGetResultsTool({ backend });
    const result = JSON.parse(
      (await tool.invoke({ runDir: RUN_DIR })) as string,
    );
    expect(result.error).toContain("run does not exist");
  });
});

// ---------------------------------------------------------------------------
// createSwarmMiddleware
// ---------------------------------------------------------------------------

describe("createSwarmMiddleware", () => {
  it("registers all four swarm tools", () => {
    const backend = createInMemoryBackend();
    const middleware = createSwarmMiddleware({
      backend,
      subagentGraphs: { "general-purpose": makeSubagent() },
    });
    const names = (middleware.tools ?? []).map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual([...SWARM_TOOL_NAMES].sort());
  });

  it("injects the without-execute prompt for non-sandbox backends", async () => {
    const backend = createInMemoryBackend();
    const middleware = createSwarmMiddleware({
      backend,
      subagentGraphs: { "general-purpose": makeSubagent() },
    });
    const captured: any[] = [];
    const handler = vi.fn(async (req: any) => {
      captured.push(req);
      return { content: "" } as any;
    }) as any;
    await middleware.wrapModelCall?.(
      { systemMessage: [], runtime: {}, state: {} } as any,
      handler,
    );
    const messages: SystemMessage[] = captured[0].systemMessage;
    const text = messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(text).toContain(SWARM_BASE_PROMPT);
    expect(text).toContain(SWARM_WITHOUT_EXECUTE_PROMPT);
    expect(text).not.toContain(SWARM_WITH_EXECUTE_PROMPT);
  });

  it("injects the with-execute prompt for sandbox backends", async () => {
    const sandbox = makeSandboxBackend(createInMemoryBackend());
    const middleware = createSwarmMiddleware({
      backend: sandbox,
      subagentGraphs: { "general-purpose": makeSubagent() },
    });
    const captured: any[] = [];
    const handler = vi.fn(async (req: any) => {
      captured.push(req);
      return { content: "" } as any;
    }) as any;
    await middleware.wrapModelCall?.(
      { systemMessage: [], runtime: {}, state: {} } as any,
      handler,
    );
    const messages: SystemMessage[] = captured[0].systemMessage;
    const text = messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(text).toContain(SWARM_BASE_PROMPT);
    expect(text).toContain(SWARM_WITH_EXECUTE_PROMPT);
    expect(text).not.toContain(SWARM_WITHOUT_EXECUTE_PROMPT);
  });

  it("preserves existing system messages when injecting", async () => {
    const backend = createInMemoryBackend();
    const middleware = createSwarmMiddleware({
      backend,
      subagentGraphs: { "general-purpose": makeSubagent() },
    });
    const existing = new SystemMessage("existing prompt");
    const captured: any[] = [];
    const handler = vi.fn(async (req: any) => {
      captured.push(req);
      return { content: "" } as any;
    }) as any;
    await middleware.wrapModelCall?.(
      { systemMessage: [existing], runtime: {}, state: {} } as any,
      handler,
    );
    const messages: SystemMessage[] = captured[0].systemMessage;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(existing);
  });
});
