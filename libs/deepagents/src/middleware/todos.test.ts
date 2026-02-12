import { describe, it, expect } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { todosReducer } from "./todos.js";
import {
  filterStateForSubagent,
  autoMarkTodoCompleted,
  diffFilesByReference,
  EXCLUDED_STATE_KEYS_LIST,
} from "./subagents.js";
import { createDeepAgent } from "../agent.js";

// ---------------------------------------------------------------------------
// Unit tests: todosReducer
// ---------------------------------------------------------------------------

describe("todosReducer", () => {
  // ---------- basic merge semantics ----------

  it("returns update when current is empty", () => {
    const update = [
      { id: "a", content: "Task A", status: "pending" as const },
    ];
    expect(todosReducer([], update)).toEqual(update);
  });

  it("returns current when update is null/undefined", () => {
    const current = [
      { id: "a", content: "Task A", status: "in_progress" as const },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(todosReducer(current, null as any)).toEqual(current);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(todosReducer(current, undefined as any)).toEqual(current);
  });

  it("returns empty array as explicit clear signal", () => {
    const current = [
      { id: "a", content: "Task A", status: "completed" as const },
    ];
    expect(todosReducer(current, [])).toEqual([]);
  });

  it("appends new todos that don't exist in current", () => {
    const current = [
      { id: "a", content: "Task A", status: "in_progress" as const },
    ];
    const update = [
      { id: "b", content: "Task B", status: "pending" as const },
    ];
    const result = todosReducer(current, update);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(current[0]);
    expect(result[1]).toEqual(update[0]);
  });

  it("updates existing todos by ID", () => {
    const current = [
      { id: "a", content: "Task A", status: "pending" as const },
    ];
    const update = [
      { id: "a", content: "Task A updated", status: "completed" as const },
    ];
    const result = todosReducer(current, update);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "a",
      content: "Task A updated",
      status: "completed",
    });
  });

  // ---------- status priority: the core stale-edit protection ----------

  it("upgrades status: pending → in_progress", () => {
    const current = [
      { id: "a", content: "Task A", status: "pending" as const },
    ];
    const update = [
      { id: "a", content: "Task A", status: "in_progress" as const },
    ];
    expect(todosReducer(current, update)[0]!.status).toBe("in_progress");
  });

  it("upgrades status: pending → completed", () => {
    const current = [
      { id: "a", content: "Task A", status: "pending" as const },
    ];
    const update = [
      { id: "a", content: "Task A", status: "completed" as const },
    ];
    expect(todosReducer(current, update)[0]!.status).toBe("completed");
  });

  it("upgrades status: in_progress → completed", () => {
    const current = [
      { id: "a", content: "Task A", status: "in_progress" as const },
    ];
    const update = [
      { id: "a", content: "Task A", status: "completed" as const },
    ];
    expect(todosReducer(current, update)[0]!.status).toBe("completed");
  });

  it("NEVER downgrades status: completed → pending is blocked", () => {
    const current = [
      { id: "a", content: "Task A", status: "completed" as const },
    ];
    const update = [
      { id: "a", content: "Task A stale", status: "pending" as const },
    ];
    const result = todosReducer(current, update);
    expect(result[0]!.status).toBe("completed");
    // Content should also be preserved (the whole object is kept)
    expect(result[0]!.content).toBe("Task A");
  });

  it("NEVER downgrades status: completed → in_progress is blocked", () => {
    const current = [
      { id: "a", content: "Task A", status: "completed" as const },
    ];
    const update = [
      { id: "a", content: "Task A stale", status: "in_progress" as const },
    ];
    const result = todosReducer(current, update);
    expect(result[0]!.status).toBe("completed");
    expect(result[0]!.content).toBe("Task A");
  });

  it("NEVER downgrades status: in_progress → pending is blocked", () => {
    const current = [
      { id: "a", content: "Task A", status: "in_progress" as const },
    ];
    const update = [
      { id: "a", content: "Task A stale", status: "pending" as const },
    ];
    const result = todosReducer(current, update);
    expect(result[0]!.status).toBe("in_progress");
    expect(result[0]!.content).toBe("Task A");
  });

  it("allows same-status update (content change with same status)", () => {
    const current = [
      { id: "a", content: "Task A", status: "in_progress" as const },
    ];
    const update = [
      { id: "a", content: "Task A revised", status: "in_progress" as const },
    ];
    const result = todosReducer(current, update);
    expect(result[0]!.content).toBe("Task A revised");
    expect(result[0]!.status).toBe("in_progress");
  });

  // ---------- parallel subagent simulation ----------

  describe("parallel subagent stale-edit scenario", () => {
    /**
     * This is THE critical scenario that the reducer prevents:
     *
     * Parent creates 3 todos: [A:pending, B:pending, C:pending]
     * 3 subagents run in parallel, each getting a snapshot of the state.
     *
     * SubagentA finishes first: returns [A:completed, B:pending, C:pending]
     *   → After reducer: [A:completed, B:pending, C:pending]  ✓
     *
     * SubagentB finishes second: returns [A:pending, B:completed, C:pending]
     *   (stale snapshot! doesn't know A was completed)
     *   → Without reducer: [A:pending, B:completed, C:pending]  ✗ A reverted!
     *   → With reducer:    [A:completed, B:completed, C:pending]  ✓ A preserved!
     *
     * SubagentC finishes last: returns [A:pending, B:pending, C:completed]
     *   (stale snapshot! doesn't know A and B were completed)
     *   → Without reducer: [A:pending, B:pending, C:completed]  ✗ A,B reverted!
     *   → With reducer:    [A:completed, B:completed, C:completed]  ✓ all preserved!
     */
    it("preserves completed status when later subagents return stale state", () => {
      const initial = [
        { id: "a", content: "Task A", status: "in_progress" as const },
        { id: "b", content: "Task B", status: "in_progress" as const },
        { id: "c", content: "Task C", status: "in_progress" as const },
      ];

      // SubagentA completes A, leaves B and C as stale in_progress
      const afterA = todosReducer(initial, [
        { id: "a", content: "Task A", status: "completed" as const },
        { id: "b", content: "Task B", status: "in_progress" as const },
        { id: "c", content: "Task C", status: "in_progress" as const },
      ]);
      expect(afterA.map((t) => t.status)).toEqual([
        "completed",
        "in_progress",
        "in_progress",
      ]);

      // SubagentB returns stale snapshot with A:in_progress (should be blocked!)
      const afterB = todosReducer(afterA, [
        { id: "a", content: "Task A", status: "in_progress" as const }, // STALE
        { id: "b", content: "Task B", status: "completed" as const },
        { id: "c", content: "Task C", status: "in_progress" as const },
      ]);
      expect(afterB.map((t) => t.status)).toEqual([
        "completed", // Protected! Not downgraded
        "completed",
        "in_progress",
      ]);

      // SubagentC returns stale snapshot with A,B:in_progress (both should be blocked!)
      const afterC = todosReducer(afterB, [
        { id: "a", content: "Task A", status: "in_progress" as const }, // STALE
        { id: "b", content: "Task B", status: "in_progress" as const }, // STALE
        { id: "c", content: "Task C", status: "completed" as const },
      ]);
      expect(afterC.map((t) => t.status)).toEqual([
        "completed", // Protected!
        "completed", // Protected!
        "completed",
      ]);
    });

    it("handles interleaved completions across many subagents", () => {
      // 5 parallel subagents, each completing only their own task
      const initial = Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i}`,
        content: `Task ${i}`,
        status: "in_progress" as const,
      }));

      let state = initial;

      // Each subagent returns the full list but only marks its own as completed
      // They all have the same stale snapshot of the initial state
      for (let agentIdx = 0; agentIdx < 5; agentIdx++) {
        const staleUpdate = initial.map((t, i) => ({
          ...t,
          status:
            i === agentIdx
              ? ("completed" as const)
              : ("in_progress" as const),
        }));
        state = todosReducer(state, staleUpdate);
      }

      // After all 5 subagents, all 5 todos should be completed
      expect(state.every((t) => t.status === "completed")).toBe(true);
    });

    it("handles subagents that only return their own todo (partial update)", () => {
      const current = [
        { id: "a", content: "Task A", status: "completed" as const },
        { id: "b", content: "Task B", status: "in_progress" as const },
        { id: "c", content: "Task C", status: "in_progress" as const },
      ];

      // SubagentB only returns the todo it changed
      const partialUpdate = [
        { id: "b", content: "Task B", status: "completed" as const },
      ];

      const result = todosReducer(current, partialUpdate);
      expect(result).toHaveLength(3);
      expect(result.map((t) => t.status)).toEqual([
        "completed",
        "completed",
        "in_progress",
      ]);
    });

    it("handles rapid-fire completions in arbitrary order", () => {
      const initial = [
        { id: "a", content: "Task A", status: "pending" as const },
        { id: "b", content: "Task B", status: "pending" as const },
        { id: "c", content: "Task C", status: "pending" as const },
      ];

      // SubagentC finishes first (out of order) — marks C completed
      const afterC = todosReducer(initial, [
        { id: "c", content: "Task C", status: "completed" as const },
      ]);
      expect(afterC[2]!.status).toBe("completed");

      // SubagentA finishes, has stale snapshot, only marks A
      const afterA = todosReducer(afterC, [
        { id: "a", content: "Task A", status: "completed" as const },
        { id: "c", content: "Task C", status: "pending" as const }, // STALE
      ]);
      expect(afterA[0]!.status).toBe("completed");
      expect(afterA[2]!.status).toBe("completed"); // Protected!

      // SubagentB finishes last, marks B, has stale A and C
      const afterB = todosReducer(afterA, [
        { id: "a", content: "Task A", status: "pending" as const }, // STALE
        { id: "b", content: "Task B", status: "completed" as const },
        { id: "c", content: "Task C", status: "pending" as const }, // STALE
      ]);
      expect(afterB.map((t) => t.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
    });
  });

  // ---------- edge cases ----------

  it("handles unknown status gracefully (defaults to priority 0)", () => {
    const current = [
      { id: "a", content: "Task A", status: "in_progress" as const },
    ];
    const update = [
      // @ts-expect-error - testing unknown status
      { id: "a", content: "Task A", status: "unknown" },
    ];
    // unknown has priority 0, in_progress has priority 1 → blocked
    const result = todosReducer(current, update);
    expect(result[0]!.status).toBe("in_progress");
  });

  it("preserves order of existing todos", () => {
    const current = [
      { id: "c", content: "Third", status: "pending" as const },
      { id: "a", content: "First", status: "pending" as const },
      { id: "b", content: "Second", status: "pending" as const },
    ];
    const update = [
      { id: "a", content: "First", status: "completed" as const },
    ];
    const result = todosReducer(current, update);
    expect(result.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("handles both current and update being null", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(todosReducer(null as any, null as any)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: autoMarkTodoCompleted
// ---------------------------------------------------------------------------

describe("autoMarkTodoCompleted", () => {
  const baseTodos = [
    { id: "todo-1", content: "Task 1", status: "in_progress" },
    { id: "todo-2", content: "Task 2", status: "in_progress" },
    { id: "todo-3", content: "Task 3", status: "pending" },
  ];

  it("marks the target todo as completed", () => {
    const result = autoMarkTodoCompleted("todo-1", baseTodos, undefined);
    expect(result).toBeDefined();
    expect(result!.find((t) => t.id === "todo-1")!.status).toBe("completed");
    // Others unchanged
    expect(result!.find((t) => t.id === "todo-2")!.status).toBe("in_progress");
    expect(result!.find((t) => t.id === "todo-3")!.status).toBe("pending");
  });

  it("falls back to parent todos when subagent returns no todos", () => {
    const result = autoMarkTodoCompleted("todo-2", undefined, baseTodos);
    expect(result).toBeDefined();
    expect(result!.find((t) => t.id === "todo-2")!.status).toBe("completed");
  });

  it("prefers subagent todos over parent todos", () => {
    const subTodos = [
      { id: "todo-1", content: "Task 1 modified", status: "in_progress" },
    ];
    const result = autoMarkTodoCompleted("todo-1", subTodos, baseTodos);
    expect(result).toBeDefined();
    expect(result).toHaveLength(1); // subTodos only had 1 item
    expect(result![0]!.content).toBe("Task 1 modified");
    expect(result![0]!.status).toBe("completed");
  });

  it("returns undefined when neither source has todos", () => {
    expect(autoMarkTodoCompleted("todo-1", undefined, undefined)).toBeUndefined();
  });

  it("leaves non-matching todos unchanged", () => {
    const result = autoMarkTodoCompleted("nonexistent-id", baseTodos, undefined);
    expect(result).toBeDefined();
    // All statuses should remain as-is since none match
    expect(result!.every((t) => t.status !== "completed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: diffFilesByReference
// ---------------------------------------------------------------------------

describe("diffFilesByReference", () => {
  it("returns only files that changed (different reference)", () => {
    const sharedRef = { content: ["hello"] };
    const newRef = { content: ["new content"] };
    const preFiles = {
      "/a.txt": sharedRef,
      "/b.txt": sharedRef,
      "/c.txt": sharedRef,
    };
    const postFiles = {
      "/a.txt": sharedRef, // same reference → unchanged
      "/b.txt": newRef, // different reference → changed
      "/c.txt": sharedRef, // same reference → unchanged
    };
    const result = diffFilesByReference(preFiles, postFiles);
    expect(Object.keys(result)).toEqual(["/b.txt"]);
    expect(result["/b.txt"]).toBe(newRef);
  });

  it("includes new files not in preFiles", () => {
    const preFiles = { "/a.txt": { content: ["a"] } };
    const newFile = { content: ["d"] };
    const postFiles = {
      "/a.txt": preFiles["/a.txt"], // same ref
      "/d.txt": newFile, // new file
    };
    const result = diffFilesByReference(preFiles, postFiles);
    expect(Object.keys(result)).toEqual(["/d.txt"]);
  });

  it("returns empty when nothing changed", () => {
    const ref = { content: ["same"] };
    const preFiles = { "/a.txt": ref, "/b.txt": ref };
    const postFiles = { "/a.txt": ref, "/b.txt": ref };
    const result = diffFilesByReference(preFiles, postFiles);
    expect(Object.keys(result)).toEqual([]);
  });

  it("detects all files as changed when all references differ", () => {
    const preFiles = { "/a.txt": { content: ["a"] }, "/b.txt": { content: ["b"] } };
    const postFiles = { "/a.txt": { content: ["a"] }, "/b.txt": { content: ["b"] } };
    // Even though content is the same, these are different object references
    const result = diffFilesByReference(preFiles, postFiles);
    expect(Object.keys(result)).toEqual(["/a.txt", "/b.txt"]);
  });

  it("handles parallel subagent file write scenario", () => {
    // Parent has 3 files. Each subagent modifies only 1 file.
    const fileA = { content: ["original A"] };
    const fileB = { content: ["original B"] };
    const fileC = { content: ["original C"] };
    const preFiles = { "/a.txt": fileA, "/b.txt": fileB, "/c.txt": fileC };

    // SubagentA modifies /a.txt
    const postA = { "/a.txt": { content: ["modified A"] }, "/b.txt": fileB, "/c.txt": fileC };
    const diffA = diffFilesByReference(preFiles, postA);
    expect(Object.keys(diffA)).toEqual(["/a.txt"]);

    // SubagentB modifies /b.txt
    const postB = { "/a.txt": fileA, "/b.txt": { content: ["modified B"] }, "/c.txt": fileC };
    const diffB = diffFilesByReference(preFiles, postB);
    expect(Object.keys(diffB)).toEqual(["/b.txt"]);

    // Neither diff clobbers the other's files
    expect(diffA["/b.txt"]).toBeUndefined();
    expect(diffB["/a.txt"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit tests: filterStateForSubagent
// ---------------------------------------------------------------------------

describe("filterStateForSubagent", () => {
  it("keeps todos in filtered state (not in EXCLUDED_STATE_KEYS)", () => {
    expect(EXCLUDED_STATE_KEYS_LIST).not.toContain("todos");

    const state = {
      messages: [{ content: "hello" }],
      todos: [{ id: "t1", content: "Task 1", status: "pending" }],
      structuredResponse: { foo: "bar" },
      files: { "/a.txt": {} },
      customKey: "custom",
    };
    const filtered = filterStateForSubagent(state);
    expect(filtered.todos).toEqual(state.todos);
    expect(filtered.files).toEqual(state.files);
    expect(filtered.customKey).toBe("custom");
  });

  it("excludes messages from filtered state", () => {
    const state = {
      messages: [{ content: "hello" }],
      todos: [],
    };
    const filtered = filterStateForSubagent(state);
    expect(filtered.messages).toBeUndefined();
  });

  it("excludes structuredResponse from filtered state", () => {
    const state = {
      structuredResponse: { answer: 42 },
      todos: [],
    };
    const filtered = filterStateForSubagent(state);
    expect(filtered.structuredResponse).toBeUndefined();
  });

  it("excludes skillsMetadata from filtered state", () => {
    const state = {
      skillsMetadata: { skills: ["skill1"] },
      todos: [],
    };
    const filtered = filterStateForSubagent(state);
    expect(filtered.skillsMetadata).toBeUndefined();
  });

  it("excludes memoryContents from filtered state", () => {
    const state = {
      memoryContents: { memories: ["memory1"] },
      todos: [],
    };
    const filtered = filterStateForSubagent(state);
    expect(filtered.memoryContents).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: todoListMiddleware write_todos tool
// ---------------------------------------------------------------------------

describe("todoListMiddleware via createDeepAgent", () => {
  it("auto-generates UUIDs for todos without IDs", async () => {
    const writeTodosCallId = `call_wt_${Date.now()}`;
    const model = new FakeListChatModel({
      responses: [
        // Agent calls write_todos
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: writeTodosCallId,
              name: "write_todos",
              args: {
                todos: [
                  { content: "Task A", status: "pending" },
                  { content: "Task B", status: "pending" },
                ],
              },
            },
          ],
        }) as unknown as string,
        // Agent finishes
        "Done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({ model, checkpointer });

    const result = await agent.invoke(
      { messages: [new HumanMessage("Create some todos")] },
      {
        configurable: { thread_id: `test-uuid-gen-${Date.now()}` },
        recursionLimit: 20,
      },
    );

    // All todos should have UUIDs
    const todos = result.todos as Array<{
      id: string;
      content: string;
      status: string;
    }>;
    expect(todos).toHaveLength(2);
    for (const todo of todos) {
      expect(todo.id).toBeTruthy();
      // UUID format: 8-4-4-4-12 hex characters
      expect(todo.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it("auto-upgrades pending → in_progress", async () => {
    const writeTodosCallId = `call_wt_${Date.now()}`;
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: writeTodosCallId,
              name: "write_todos",
              args: {
                todos: [
                  { content: "Task A", status: "pending" },
                  { content: "Task B", status: "completed" },
                ],
              },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({ model, checkpointer });

    const result = await agent.invoke(
      { messages: [new HumanMessage("Create some todos")] },
      {
        configurable: { thread_id: `test-auto-upgrade-${Date.now()}` },
        recursionLimit: 20,
      },
    );

    const todos = result.todos as Array<{
      id: string;
      content: string;
      status: string;
    }>;
    // pending should be upgraded to in_progress
    expect(todos[0]!.status).toBe("in_progress");
    // completed should remain completed
    expect(todos[1]!.status).toBe("completed");
  });

  it("preserves existing IDs on todos that already have them", async () => {
    const writeTodosCallId = `call_wt_${Date.now()}`;
    const existingId = "00000000-0000-0000-0000-000000000001";
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: writeTodosCallId,
              name: "write_todos",
              args: {
                todos: [
                  { id: existingId, content: "Task A", status: "completed" },
                  { content: "Task B", status: "pending" },
                ],
              },
            },
          ],
        }) as unknown as string,
        "Done",
        "Done",
      ],
    });

    const checkpointer = new MemorySaver();
    const agent = createDeepAgent({ model, checkpointer });

    const result = await agent.invoke(
      { messages: [new HumanMessage("Create todos")] },
      {
        configurable: { thread_id: `test-preserve-id-${Date.now()}` },
        recursionLimit: 20,
      },
    );

    const todos = result.todos as Array<{
      id: string;
      content: string;
      status: string;
    }>;
    // Existing ID should be preserved
    expect(todos[0]!.id).toBe(existingId);
    // New todo should get a generated UUID
    expect(todos[1]!.id).not.toBe(existingId);
    expect(todos[1]!.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Integration: todosReducer + autoMarkTodoCompleted combined flow
// ---------------------------------------------------------------------------

describe("end-to-end: parallel subagent auto-mark with reducer protection", () => {
  /**
   * Simulates the complete flow:
   * 1. Parent creates todos
   * 2. Three subagents run in parallel, each gets assigned a todo_id
   * 3. Each subagent finishes and auto-marks its todo as completed
   * 4. The todosReducer merges all updates without losing any completions
   *
   * This test doesn't need a real LangGraph agent — it directly simulates
   * the reducer + auto-mark flow that happens in production.
   */
  it("all todos end up completed despite stale snapshots", () => {
    // Step 1: Parent creates 3 todos
    const parentTodos = [
      { id: "todo-a", content: "Research", status: "in_progress" },
      { id: "todo-b", content: "Implement", status: "in_progress" },
      { id: "todo-c", content: "Test", status: "in_progress" },
    ];

    // All three subagents get the SAME snapshot (stale after first completes)
    const snapshot = [...parentTodos];

    // Step 2: SubagentA finishes, auto-marks todo-a
    const markedA = autoMarkTodoCompleted("todo-a", snapshot, undefined);
    expect(markedA).toBeDefined();
    // Apply through reducer to current state
    let state = todosReducer(parentTodos, markedA!);
    expect(state.find((t) => t.id === "todo-a")!.status).toBe("completed");
    expect(state.find((t) => t.id === "todo-b")!.status).toBe("in_progress");

    // Step 3: SubagentB finishes with STALE snapshot, auto-marks todo-b
    const markedB = autoMarkTodoCompleted("todo-b", snapshot, undefined);
    // markedB has: [todo-a:in_progress(STALE), todo-b:completed, todo-c:in_progress]
    expect(markedB!.find((t) => t.id === "todo-a")!.status).toBe("in_progress"); // stale!
    expect(markedB!.find((t) => t.id === "todo-b")!.status).toBe("completed");
    // Apply through reducer — todo-a should NOT be downgraded
    state = todosReducer(state, markedB!);
    expect(state.find((t) => t.id === "todo-a")!.status).toBe("completed"); // PROTECTED
    expect(state.find((t) => t.id === "todo-b")!.status).toBe("completed");

    // Step 4: SubagentC finishes with STALE snapshot, auto-marks todo-c
    const markedC = autoMarkTodoCompleted("todo-c", snapshot, undefined);
    // markedC has: [todo-a:in_progress(STALE), todo-b:in_progress(STALE), todo-c:completed]
    state = todosReducer(state, markedC!);
    // All completed, nothing downgraded
    expect(state.map((t) => t.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  it("handles mixed auto-mark + write_todos updates", () => {
    const parentTodos = [
      { id: "todo-1", content: "Build", status: "in_progress" },
      { id: "todo-2", content: "Deploy", status: "in_progress" },
    ];

    // SubagentA auto-marks todo-1 as completed
    const markedA = autoMarkTodoCompleted("todo-1", parentTodos, undefined);
    let state = todosReducer(parentTodos, markedA!);
    expect(state.find((t) => t.id === "todo-1")!.status).toBe("completed");

    // Meanwhile, the main agent calls write_todos to add a new todo
    // (this simulates the reducer receiving an update from write_todos)
    const writeTodosUpdate = [
      { id: "todo-1", content: "Build", status: "in_progress" }, // stale
      { id: "todo-2", content: "Deploy", status: "in_progress" },
      { id: "todo-3", content: "Monitor", status: "in_progress" }, // new
    ];
    state = todosReducer(state, writeTodosUpdate);

    // todo-1 should still be completed (protected by reducer)
    expect(state.find((t) => t.id === "todo-1")!.status).toBe("completed");
    // New todo-3 should be added
    expect(state.find((t) => t.id === "todo-3")).toBeDefined();
    expect(state.find((t) => t.id === "todo-3")!.status).toBe("in_progress");
  });
});
