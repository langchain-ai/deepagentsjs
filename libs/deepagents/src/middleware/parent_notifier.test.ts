import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GraphInterrupt,
  MemorySaver,
  MessagesAnnotation,
  StateGraph,
} from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { Client } from "@langchain/langgraph-sdk";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createAgent, fakeModel } from "langchain";

import { createParentNotifierMiddleware } from "./parent_notifier.js";

const PARENT = { thread_id: "parent-thread", assistant_id: "lead" };

/** Config of a subagent run launched by `start_async_task`. */
function taskRunConfig(
  overrides: Record<string, unknown> = {},
): LangGraphRunnableConfig {
  return {
    configurable: {
      thread_id: "task-thread",
      run_id: "run-1",
      graph_id: "helper",
      deepagents_parent: PARENT,
      ...overrides,
    },
  };
}

/** An agent whose model answers with `reply` (a message, or an error to throw). */
function subagent(
  reply: AIMessage | Error | (() => Error) = new AIMessage("All done."),
) {
  return createAgent({
    model: fakeModel().respond(reply),
    middleware: [createParentNotifierMiddleware()],
    checkpointer: new MemorySaver(),
  });
}

const ask = { messages: [new HumanMessage("Go.")] };

describe("createParentNotifierMiddleware", () => {
  let threadsGet: ReturnType<typeof vi.fn>;
  let runsCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const client = new Client({ apiUrl: "http://localhost:1" });
    threadsGet = vi
      .spyOn(Object.getPrototypeOf(client.threads), "get")
      .mockResolvedValue({ status: "idle" }) as unknown as ReturnType<
      typeof vi.fn
    >;
    runsCreate = vi
      .spyOn(Object.getPrototypeOf(client.runs), "create")
      .mockResolvedValue({ run_id: "wake" }) as unknown as ReturnType<
      typeof vi.fn
    >;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wakes an idle parent with the subagent's answer", async () => {
    await subagent().invoke(ask, taskRunConfig());

    expect(threadsGet).toHaveBeenCalledWith("parent-thread");
    const [threadId, assistantId, payload] = runsCreate.mock.calls[0];
    expect([threadId, assistantId]).toEqual(["parent-thread", "lead"]);
    expect(payload.multitaskStrategy).toBe("reject");
    const [message] = payload.input.messages;
    expect(message.additional_kwargs.deepagents_notification).toEqual({
      task_id: "task-thread",
      agent_name: "helper",
      status: "success",
      run_id: "run-1",
    });
    expect(JSON.stringify(message.content)).toContain("All done.");
  });

  it("does nothing for a run no async subagent tool started", async () => {
    await subagent().invoke(
      ask,
      taskRunConfig({ deepagents_parent: undefined }),
    );

    expect(threadsGet).not.toHaveBeenCalled();
  });

  it("leaves reporting to the top-level graph", async () => {
    const agent = subagent();
    const outer = new StateGraph(MessagesAnnotation)
      .addNode("agent", (state, config) => agent.invoke(state, config))
      .addEdge("__start__", "agent")
      .compile();

    await outer.invoke(ask, taskRunConfig());

    expect(threadsGet).not.toHaveBeenCalled();
  });

  it("names the subagent as its parent knows it, and hands back the run's context", async () => {
    await subagent().invoke(ask, {
      ...taskRunConfig(),
      metadata: { subagent_name: "researcher" },
      context: { team: "eng", deepagents_parent: PARENT },
    });

    const [, , options] = runsCreate.mock.calls[0];
    expect(
      options.input.messages[0].additional_kwargs.deepagents_notification
        .agent_name,
    ).toBe("researcher");
    expect(options.context).toEqual({ team: "eng" });
  });

  it("doesn't start a run on a busy or paused parent", async () => {
    threadsGet.mockResolvedValue({ status: "interrupted" });

    await subagent().invoke(ask, taskRunConfig());

    expect(runsCreate).not.toHaveBeenCalled();
  });

  it("doesn't fail the run when the parent can't be woken", async () => {
    runsCreate.mockRejectedValue(new Error("unreachable"));

    await expect(
      subagent().invoke(ask, taskRunConfig()),
    ).resolves.toBeDefined();
  });

  it("reports a failed model call by error type only, and rethrows", async () => {
    await expect(
      subagent(new TypeError("secret internals")).invoke(ask, taskRunConfig()),
    ).rejects.toThrow("secret internals");

    const [message] = runsCreate.mock.calls[0][2].input.messages;
    const body = JSON.stringify(message.content);
    expect(body).toContain("The subagent failed (TypeError).");
    expect(body).not.toContain("secret internals");
  });

  it("doesn't report a cancelled, replaced or timed-out run as a failure", async () => {
    const controller = new AbortController();
    const agent = subagent(() => {
      controller.abort();
      return Object.assign(new Error("aborted"), { name: "AbortError" });
    });

    await expect(
      agent.invoke(ask, { ...taskRunConfig(), signal: controller.signal }),
    ).rejects.toThrow();

    expect(runsCreate).not.toHaveBeenCalled();
  });

  it("doesn't report an interrupt as a failure", async () => {
    await subagent(() => new GraphInterrupt()).invoke(ask, taskRunConfig());

    expect(runsCreate).not.toHaveBeenCalled();
  });
});
