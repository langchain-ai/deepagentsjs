import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const { getConfig } = vi.hoisted(() => ({ getConfig: vi.fn() }));
vi.mock("@langchain/langgraph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/langgraph")>()),
  getConfig,
}));
import { GraphInterrupt } from "@langchain/langgraph";
import { Client } from "@langchain/langgraph-sdk";
import { AIMessage } from "@langchain/core/messages";

import { createParentNotifierMiddleware } from "./parent_notifier.js";

const PARENT = { thread_id: "parent-thread", assistant_id: "lead" };

/** Config of a subagent run launched by `start_async_task`. */
function taskRunConfig(overrides: Record<string, unknown> = {}) {
  return {
    configurable: {
      thread_id: "task-thread",
      run_id: "run-1",
      graph_id: "helper",
      checkpoint_ns: "model_request:abc",
      deepagents_parent: PARENT,
      ...overrides,
    },
  };
}

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
    getConfig.mockReset();
  });

  // Hooks get an empty `runtime.context` (the middleware declares no context schema),
  // so the run's context must come from its config.
  const finish = (middleware = createParentNotifierMiddleware()) =>
    (
      middleware.afterAgent as (
        state: unknown,
        runtime: unknown,
      ) => Promise<unknown>
    )({ messages: [new AIMessage("All done.")] }, { context: {} });

  it("wakes an idle parent with the subagent's answer", async () => {
    getConfig.mockReturnValue(taskRunConfig());

    await finish();

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
    getConfig.mockReturnValue(taskRunConfig({ deepagents_parent: undefined }));

    await finish();

    expect(threadsGet).not.toHaveBeenCalled();
  });

  it("leaves reporting to the top-level graph", async () => {
    getConfig.mockReturnValue(
      taskRunConfig({ checkpoint_ns: "tools:1|model_request:2" }),
    );

    await finish();

    expect(threadsGet).not.toHaveBeenCalled();
  });

  it("reports each run once", async () => {
    getConfig.mockReturnValue(taskRunConfig());
    const middleware = createParentNotifierMiddleware();

    await finish(middleware);
    await finish(middleware);

    expect(runsCreate).toHaveBeenCalledTimes(1);
  });

  it("names the subagent as its parent knows it, and hands back the run's context", async () => {
    getConfig.mockReturnValue({
      ...taskRunConfig(),
      metadata: { subagent_name: "researcher" },
      context: { team: "eng", deepagents_parent: PARENT },
    });

    await finish();

    const [, , options] = runsCreate.mock.calls[0];
    expect(
      options.input.messages[0].additional_kwargs.deepagents_notification
        .agent_name,
    ).toBe("researcher");
    expect(options.context).toEqual({ team: "eng" });
  });

  it("doesn't start a run on a busy or paused parent", async () => {
    getConfig.mockReturnValue(taskRunConfig());
    threadsGet.mockResolvedValue({ status: "interrupted" });

    await finish();

    expect(runsCreate).not.toHaveBeenCalled();
  });

  it("stays quiet when the parent became busy", async () => {
    getConfig.mockReturnValue(taskRunConfig());
    runsCreate.mockRejectedValue(
      Object.assign(new Error("busy"), { status: 409 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await finish();

    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a failed model call by error type only, and rethrows", async () => {
    getConfig.mockReturnValue(taskRunConfig());
    const wrap = createParentNotifierMiddleware().wrapModelCall as (
      request: unknown,
      handler: () => Promise<unknown>,
    ) => Promise<unknown>;

    await expect(
      wrap({ runtime: {} }, async () => {
        throw new TypeError("secret internals");
      }),
    ).rejects.toThrow("secret internals");

    const [message] = runsCreate.mock.calls[0][2].input.messages;
    const body = JSON.stringify(message.content);
    expect(body).toContain("The subagent failed (TypeError).");
    expect(body).not.toContain("secret internals");
  });

  it.each([
    ["the run's signal aborted", "Error", true],
    ["an AbortError", "AbortError", false],
  ])(
    "doesn't report a cancelled, replaced or timed-out run as a failure (%s)",
    async (_case, errorName, abortSignal) => {
      getConfig.mockReturnValue(taskRunConfig());
      const wrap = createParentNotifierMiddleware().wrapModelCall as (
        request: unknown,
        handler: () => Promise<unknown>,
      ) => Promise<unknown>;
      const controller = new AbortController();
      if (abortSignal) controller.abort();

      await expect(
        wrap({ runtime: { signal: controller.signal } }, async () => {
          throw Object.assign(new Error("aborted"), { name: errorName });
        }),
      ).rejects.toThrow("aborted");

      expect(runsCreate).not.toHaveBeenCalled();
    },
  );

  it("doesn't report an interrupt as a failure", async () => {
    getConfig.mockReturnValue(taskRunConfig());
    const wrap = createParentNotifierMiddleware().wrapModelCall as (
      request: unknown,
      handler: () => Promise<unknown>,
    ) => Promise<unknown>;

    await expect(
      wrap({}, async () => {
        throw new GraphInterrupt();
      }),
    ).rejects.toBeInstanceOf(GraphInterrupt);

    expect(runsCreate).not.toHaveBeenCalled();
  });
});
