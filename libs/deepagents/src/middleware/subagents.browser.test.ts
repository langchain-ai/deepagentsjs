import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/langgraph")>();
  return {
    ...actual,
    getCurrentTaskInput: vi.fn(() => {
      throw new Error(
        "browser task tool should use runtime.state instead of getCurrentTaskInput",
      );
    }),
  };
});

import { createAgent, type ToolRuntime } from "langchain";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import { createSubAgentMiddleware } from "../index.js";
import { extractToolsFromAgent, SAMPLE_MODEL } from "../testing/utils.js";

type BrowserToolState = {
  messages?: unknown[];
  todos?: string[];
  files?: Record<string, unknown>;
  custom?: string;
};

describe("browser subagent task tool", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses runtime.state when invoking a subagent", async () => {
    const invoke = vi.fn(async () => ({
      messages: [new AIMessage("Subagent finished")],
    }));

    const agent = createAgent({
      model: SAMPLE_MODEL,
      middleware: [
        createSubAgentMiddleware({
          defaultModel: SAMPLE_MODEL,
          subagents: [
            {
              name: "worker",
              description: "Browser-safe worker",
              runnable: { invoke } as any,
            },
          ],
        }),
      ],
    });

    const tools = extractToolsFromAgent(agent);
    const runtime = {
      toolCall: { id: "call-task-1" },
      toolCallId: "call-task-1",
      config: {
        configurable: {
          thread_id: "parent-thread-1",
        },
      },
      context: undefined,
      store: null,
      writer: null,
      state: {
        messages: [new HumanMessage("Parent message")],
        todos: ["keep out of subagent state"],
        files: {
          "/workspace/input.txt": {
            content: ["seed"],
            created_at: "2024-01-01",
            modified_at: "2024-01-01",
          },
        },
        custom: "keep me",
      },
    } as unknown as ToolRuntime<BrowserToolState>;

    const result = await tools.task.invoke(
      {
        description: "Inspect /workspace/input.txt",
        subagent_type: "worker",
      },
      runtime,
    );

    expect(vi.mocked(getCurrentTaskInput)).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [subagentState, subagentConfig] = invoke.mock.calls[0] as any[];
    expect(subagentConfig).toEqual(runtime.config);
    expect(subagentState).toMatchObject({
      files: runtime.state.files,
      custom: "keep me",
    });
    expect(subagentState.messages).toEqual([
      new HumanMessage({ content: "Inspect /workspace/input.txt" }),
    ]);
    expect(subagentState.todos).toBeUndefined();
    expect(result).toBeInstanceOf(Command);
  });
});
