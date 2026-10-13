import { describe, expect, it, vi } from "vitest";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { AIMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { registerHarnessProfile, StateBackend } from "deepagents";
import { DeepAgentsServer } from "./server.js";
import type { DeepAgentConfig, SessionState, ToolCallInfo } from "./types.js";

function selected(optionId: string) {
  return { outcome: { outcome: "selected", optionId } };
}

function connection(response: unknown = selected("allow-once")) {
  return {
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
    requestPermission: vi.fn().mockResolvedValue(response),
  };
}

function session(): SessionState {
  return {
    id: "session-one",
    threadId: "thread-one",
    agentName: "test-agent",
    messages: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
  };
}

function call(
  args: Record<string, unknown> = { command: "ls -la" },
): ToolCallInfo {
  return { id: "execute-one", name: "execute", args, status: "pending" };
}

function permissionFixture(response: unknown = selected("allow-always")) {
  const config: DeepAgentConfig = {
    name: "test-agent",
    model: "openai:test-model",
  };
  const server = new DeepAgentsServer({
    agents: config,
    workspaceRoot: "/workspace/project",
  });
  const conn = connection(response);
  const state = session();
  const request = (toolCall = call(), currentSession = state) =>
    server.requestToolPermission(
      currentSession,
      conn as unknown as AgentSideConnection,
      toolCall,
    );
  return { config, server, conn, state, request };
}

describe("ACP reusable permissions", () => {
  it("remembers only the unchanged execute arguments and shows the full command", async () => {
    const { request, conn } = permissionFixture();
    const command = `printf '${"long-command ".repeat(30)}'`;
    await expect(request(call({ command, timeout: 10 }))).resolves.toBe(
      "allow",
    );
    await expect(request(call({ timeout: 10, command }))).resolves.toBe(
      "allow",
    );
    expect(conn.requestPermission).toHaveBeenCalledOnce();
    const prompt = conn.requestPermission.mock.calls[0][0];
    expect(prompt.toolCall.title).toContain(command);
    expect(prompt.toolCall.input).toEqual({ command, timeout: 10 });
    expect(prompt.options).toContainEqual(
      expect.objectContaining({
        optionId: "allow-always",
        name: "Always allow this exact command in this session",
      }),
    );
  });

  it.each([
    { command: "ls -l" },
    { command: "ls -la && printf unreviewed" },
    { command: "ls -la; printf unreviewed #'" },
    { command: "ls -la && printf unreviewed #'" },
    { command: " ls -la" },
    { command: "ls -la", timeout: 10 },
    { command: "ls -la", env: { NAME: "changed" } },
  ])("prompts again for changed execute arguments %j", async (args) => {
    const { request, conn } = permissionFixture();
    await request();
    conn.requestPermission.mockResolvedValue(selected("reject-once"));
    await expect(request(call(args))).resolves.toBe("reject");
    expect(conn.requestPermission).toHaveBeenCalledTimes(2);
  });

  it.each([
    { id: "different-session" },
    { threadId: "different-thread" },
    { mode: "plan" },
    { agentName: "different-agent" },
  ])("prompts after session context changes %j", async (change) => {
    const { request, conn, state } = permissionFixture();
    await request();
    Object.assign(state, change);
    conn.requestPermission.mockResolvedValue(selected("reject-once"));
    await expect(request()).resolves.toBe("reject");
    expect(conn.requestPermission).toHaveBeenCalledTimes(2);
  });

  it.each(["model", "backend"] as const)(
    "prompts when the configured %s changes",
    async (field) => {
      const { request, conn, config } = permissionFixture();
      await request();
      if (field === "model") config.model = "openai:other-model";
      else config.backend = new StateBackend();
      conn.requestPermission.mockResolvedValue(selected("reject-once"));
      await expect(request()).resolves.toBe("reject");
      expect(conn.requestPermission).toHaveBeenCalledTimes(2);
    },
  );

  it("does not copy reusable execute grants into another session or server", async () => {
    const { request, conn } = permissionFixture();
    await request();
    conn.requestPermission.mockResolvedValue(selected("reject-once"));
    await expect(request(call(), session())).resolves.toBe("reject");
    const other = permissionFixture(selected("reject-once"));
    await expect(other.request()).resolves.toBe("reject");
    expect(other.conn.requestPermission).toHaveBeenCalledOnce();
  });

  it("ignores a legacy tool-wide execute allowance", async () => {
    const { request, state, conn } = permissionFixture(selected("reject-once"));
    state.permissionDecisions = new Map([["execute", "allow_always"]]);
    await expect(request()).resolves.toBe("reject");
    expect(conn.requestPermission).toHaveBeenCalledOnce();
  });

  it("keeps reusable non-execute approvals tool-wide", async () => {
    const { request, conn } = permissionFixture();
    await request({
      ...call(),
      name: "write_file",
      args: { path: "one.txt", content: "one" },
    });
    await expect(
      request({
        ...call(),
        name: "write_file",
        args: { path: "two.txt", content: "two" },
      }),
    ).resolves.toBe("allow");
    expect(conn.requestPermission).toHaveBeenCalledOnce();
  });

  it.each(["allow-once", "reject-once"])(
    "does not remember %s",
    async (optionId) => {
      const { request, conn } = permissionFixture(selected(optionId));
      await request();
      await request();
      expect(conn.requestPermission).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    {},
    { command: "" },
    { command: "  " },
    { command: 42 },
    { command: "ls -la", extra: undefined },
    { command: "ls -la", extra: Number.NaN },
    { command: "ls -la", extra: -0 },
    { command: "ls -la", extra: new Date() },
    { command: "ls -la", extra: () => "value" },
    { command: "ls -la", extra: [undefined] },
  ])(
    "does not offer or accept reusable approval for unsupported args %j",
    async (args) => {
      const { request, conn } = permissionFixture();
      await expect(request(call(args))).resolves.toBe("reject");
      expect(
        conn.requestPermission.mock.calls[0][0].options,
      ).not.toContainEqual(
        expect.objectContaining({ optionId: "allow-always" }),
      );
    },
  );

  it("does not offer reusable grants for cyclic or accessor arguments", async () => {
    const cyclic: Record<string, unknown> = { command: "ls -la" };
    cyclic.extra = cyclic;
    const accessor = Object.defineProperty({ command: "ls -la" }, "extra", {
      enumerable: true,
      get: () => "dynamic",
    });
    for (const args of [cyclic, accessor]) {
      const { request, conn } = permissionFixture();
      await expect(request(call(args))).resolves.toBe("reject");
      expect(
        conn.requestPermission.mock.calls[0][0].options,
      ).not.toContainEqual(
        expect.objectContaining({ optionId: "allow-always" }),
      );
    }
  });

  it.each([
    selected("unknown"),
    { outcome: { outcome: "selected" } },
    { outcome: { outcome: "other", optionId: "allow-once" } },
    { outcome: { outcome: "other", optionId: "allow-always" } },
  ])(
    "rejects unrecognized responses %j without remembering them",
    async (response) => {
      const { request, conn } = permissionFixture(response);
      await expect(request()).resolves.toBe("reject");
      conn.requestPermission.mockResolvedValue(selected("reject-once"));
      await expect(request()).resolves.toBe("reject");
      expect(conn.requestPermission).toHaveBeenCalledTimes(2);
    },
  );

  it.each([undefined, {}, { outcome: { outcome: "cancelled" } }])(
    "treats missing/cancelled responses %j as cancelled",
    async (response) => {
      const { request, conn } = permissionFixture();
      conn.requestPermission.mockResolvedValue(response);
      await expect(request()).resolves.toBe("cancelled");
    },
  );

  it("rejects a permission RPC failure", async () => {
    const { request, conn } = permissionFixture();
    conn.requestPermission.mockRejectedValue(
      new Error("Permission connection lost"),
    );
    await expect(request()).resolves.toBe("reject");
  });
});

function fakeModel(responses: Array<string | AIMessage>) {
  const model = new FakeListChatModel({
    responses: responses as unknown as string[],
  });
  model.disableStreaming = true;
  model.bindTools = () => model;
  return model as unknown as NonNullable<DeepAgentConfig["model"]>;
}

function aiCall(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ content: "", tool_calls: [{ name, args, id }] });
}

type ServerHandlers = {
  handleNewSession: (
    params: Record<string, unknown>,
    conn: unknown,
  ) => Promise<{ sessionId: string }>;
  handlePrompt: (
    params: Record<string, unknown>,
    conn: unknown,
  ) => Promise<{ stopReason: string }>;
  handleCancel: (params: Record<string, unknown>) => Promise<void>;
};

async function graphFixture(
  target = "root",
  response: unknown = selected("reject-once"),
) {
  const execute = vi
    .fn()
    .mockResolvedValue({ output: "spy output", exitCode: 0, truncated: false });
  const backend = Object.assign(new StateBackend(), {
    id: "permission-test",
    execute,
  });
  const shell = aiCall("execute", { command: "never-run-a-shell" }, "shell");
  const delegation = aiCall(
    "task",
    { description: "Run the tool", subagent_type: target },
    "delegate",
  );
  const model = fakeModel(
    target === "root"
      ? [shell, "Done"]
      : target === "general-purpose"
        ? [delegation, shell, "Child done", "Parent done"]
        : [delegation, "Done"],
  );
  const server = new DeepAgentsServer({
    agents: {
      name: "test-agent",
      model,
      backend,
      ...(target === "worker"
        ? {
            subagents: [
              {
                name: "worker",
                description: "Test worker",
                systemPrompt: "Work.",
                model: fakeModel([shell, "Child done"]),
              },
            ],
          }
        : {}),
    },
  });
  const handlers = server as unknown as ServerHandlers;
  const conn = connection(response);
  if (target !== "root") {
    conn.requestPermission.mockImplementation(async (request) =>
      request.toolCall.toolCallId === "delegate"
        ? selected("allow-once")
        : response,
    );
  }
  const { sessionId } = await handlers.handleNewSession({}, conn);
  const prompt = () =>
    handlers.handlePrompt(
      { sessionId, prompt: [{ type: "text", text: "Run the tool" }] },
      conn,
    );
  return { handlers, sessionId, prompt, conn, execute };
}

type Middleware = NonNullable<DeepAgentConfig["middleware"]>[number];
type ToolRequest = Parameters<NonNullable<Middleware["wrapToolCall"]>>[0];

function gateFixture(toolCall = call()) {
  const { server, conn, state } = permissionFixture();
  const controller = new AbortController();
  const internals = server as unknown as {
    permissionMiddleware: (model: DeepAgentConfig["model"]) => Middleware[];
    permissionContexts: Map<
      string,
      {
        session: SessionState;
        conn: AgentSideConnection;
        controller: AbortController;
        signal: AbortSignal;
      }
    >;
  };
  internals.permissionContexts.set(state.threadId, {
    session: state,
    conn: conn as unknown as AgentSideConnection,
    controller,
    signal: controller.signal,
  });
  const gate = internals.permissionMiddleware("openai:test-model").at(-1)!;
  const handler = vi.fn().mockResolvedValue(undefined);
  const invoke = () =>
    gate.wrapToolCall!(
      {
        toolCall,
        runtime: { configurable: { thread_id: state.threadId } },
        state: { messages: [] },
      } as unknown as ToolRequest,
      handler,
    );
  return { conn, state, controller, internals, handler, invoke, toolCall };
}

describe("ACP execution boundary", () => {
  it("denies unsupported arguments before requesting permission or executing", async () => {
    const { invoke, handler, conn } = gateFixture(
      call({ command: "reviewed", extra: undefined }),
    );
    await invoke();
    expect(handler).not.toHaveBeenCalled();
    expect(conn.requestPermission).not.toHaveBeenCalled();
  });

  it("denies execution without an active invocation context", async () => {
    const { invoke, handler, conn, state, internals } = gateFixture();
    internals.permissionContexts.delete(state.threadId);
    await invoke();
    expect(handler).not.toHaveBeenCalled();
    expect(conn.requestPermission).not.toHaveBeenCalled();
  });

  it.each(["execute", "write_file"])(
    "rejects changed %s arguments without remembering approval",
    async (name) => {
      const toolCall =
        name === "execute"
          ? call()
          : { ...call(), name, args: { path: "one.txt", content: "reviewed" } };
      const { invoke, handler, conn } = gateFixture(toolCall);
      const original = { ...toolCall.args };
      conn.requestPermission.mockImplementationOnce(async () => {
        if (name === "execute") toolCall.args.command = "changed-after-prompt";
        else toolCall.args.content = "changed-after-prompt";
        return selected("allow-always");
      });
      await invoke();
      toolCall.args = original;
      conn.requestPermission.mockResolvedValue(selected("reject-once"));
      await invoke();
      expect(handler).not.toHaveBeenCalled();
      expect(conn.requestPermission).toHaveBeenCalledTimes(2);
    },
  );

  it("does not remember an allow-always response after cancellation", async () => {
    const { invoke, handler, conn, controller, state, internals } =
      gateFixture();
    conn.requestPermission.mockImplementationOnce(async () => {
      controller.abort();
      return selected("allow-always");
    });
    await invoke();
    const next = new AbortController();
    internals.permissionContexts.set(state.threadId, {
      session: state,
      conn: conn as unknown as AgentSideConnection,
      controller: next,
      signal: next.signal,
    });
    conn.requestPermission.mockResolvedValue(selected("reject-once"));
    await invoke();
    expect(handler).not.toHaveBeenCalled();
    expect(conn.requestPermission).toHaveBeenCalledTimes(2);
  });

  it("rejects a model-instance provider fallback that excludes permission middleware", () => {
    const provider = `permission-${crypto.randomUUID()}`;
    registerHarnessProfile(provider, {
      excludedMiddleware: ["patchToolCallsMiddleware"],
    });
    const model = {
      getName: () => "ConfigurableModel",
      _defaultConfig: { modelProvider: provider, model: "missing:profile" },
    } as unknown as DeepAgentConfig["model"];
    const { internals } = gateFixture();
    expect(() => internals.permissionMiddleware(model)).toThrow(
      /permissions.*patchToolCallsMiddleware/i,
    );
  });
  it.each([
    selected("reject-once"),
    selected("unknown"),
    { outcome: { outcome: "cancelled" } },
    {},
  ])("does not execute after a non-allow response %j", async (response) => {
    const { prompt, conn, execute } = await graphFixture("root", response);
    await prompt();
    expect(conn.requestPermission).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not execute after a permission RPC failure", async () => {
    const { prompt, conn, execute } = await graphFixture();
    conn.requestPermission.mockRejectedValue(
      new Error("Permission connection lost"),
    );
    await prompt();
    expect(conn.requestPermission).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes exactly once after explicit permission", async () => {
    const { prompt, conn, execute } = await graphFixture(
      "root",
      selected("allow-once"),
    );
    await prompt();
    expect(conn.requestPermission).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledExactlyOnceWith("never-run-a-shell");
  });

  it.each(["worker", "general-purpose"])(
    "gates %s execution even after parent task approval",
    async (target) => {
      const { prompt, conn, execute } = await graphFixture(target);
      await prompt();
      expect(
        conn.requestPermission.mock.calls.map(
          ([request]) => request.toolCall.toolCallId,
        ),
      ).toEqual(["delegate", "shell"]);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("does not execute when cancellation races an allow response", async () => {
    const { handlers, sessionId, prompt, conn, execute } = await graphFixture();
    let approve!: (response: unknown) => void;
    let started!: () => void;
    const pending = new Promise<unknown>((resolve) => {
      approve = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    conn.requestPermission.mockImplementation(() => {
      started();
      return pending;
    });
    const running = prompt();
    await requested;
    await handlers.handleCancel({ sessionId });
    approve(selected("allow-once"));
    await running;
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps simultaneous session decisions isolated", async () => {
    const execute = vi.fn().mockResolvedValue({
      output: "spy output",
      exitCode: 0,
      truncated: false,
    });
    const backend = Object.assign(new StateBackend(), {
      id: "concurrent-test",
      execute,
    });
    const configs = ["first", "second"].map((name) => ({
      name,
      backend,
      model: fakeModel([
        aiCall("execute", { command: `never-run-${name}` }, name),
        "Done",
      ]),
    }));
    const server = new DeepAgentsServer({ agents: configs });
    const handlers = server as unknown as ServerHandlers;
    const conn = connection();
    const sessions = await Promise.all(
      configs.map(({ name }) =>
        handlers.handleNewSession({ configOptions: { agent: name } }, conn),
      ),
    );
    const responses = new Map<string, (response: unknown) => void>();
    let ready!: () => void;
    const requested = new Promise<void>((resolve) => {
      ready = resolve;
    });
    conn.requestPermission.mockImplementation(
      ({ sessionId }) =>
        new Promise((resolve) => {
          responses.set(sessionId, resolve);
          if (responses.size === 2) ready();
        }),
    );
    const running = sessions.map(({ sessionId }) =>
      handlers.handlePrompt(
        {
          sessionId,
          prompt: [{ type: "text", text: "Run the tool" }],
        },
        conn,
      ),
    );
    await requested;
    responses.get(sessions[0].sessionId)!(selected("reject-once"));
    responses.get(sessions[1].sessionId)!({
      outcome: { outcome: "cancelled" },
    });
    await Promise.all(running);
    expect(conn.requestPermission).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires a new decision before executing changed command text", async () => {
    const execute = vi.fn().mockResolvedValue({
      output: "spy output",
      exitCode: 0,
      truncated: false,
    });
    const backend = Object.assign(new StateBackend(), {
      id: "changed-command-test",
      execute,
    });
    const server = new DeepAgentsServer({
      agents: {
        name: "test-agent",
        backend,
        model: fakeModel([
          aiCall("execute", { command: "ls -la" }, "original"),
          aiCall(
            "execute",
            { command: "ls -la && printf unreviewed #'" },
            "changed",
          ),
          "Done",
        ]),
      },
    });
    const handlers = server as unknown as ServerHandlers;
    const conn = connection(selected("reject-once"));
    conn.requestPermission.mockResolvedValueOnce(selected("allow-always"));
    const { sessionId } = await handlers.handleNewSession({}, conn);
    const params = {
      sessionId,
      prompt: [{ type: "text", text: "Run the tool" }],
    };
    await handlers.handlePrompt(params, conn);
    expect(conn.requestPermission).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledExactlyOnceWith("ls -la");
  });

  it.each(["graphId", "runnable"])(
    "rejects opaque %s delegates that cannot be instrumented",
    async (kind) => {
      const server = new DeepAgentsServer({
        agents: {
          name: "test-agent",
          model: fakeModel(["Done"]),
          subagents: [
            {
              name: "opaque",
              description: "Opaque delegate",
              [kind]: kind === "graphId" ? "remote-graph" : { invoke: vi.fn() },
            },
          ] as DeepAgentConfig["subagents"],
        },
      });
      await expect(
        (server as unknown as ServerHandlers).handleNewSession(
          {},
          connection(),
        ),
      ).rejects.toThrow(/permission|opaque|compiled|remote|subagent/i);
    },
  );

  it.each(["root", "worker"])(
    "rejects profiles excluding the gate for %s",
    async (target) => {
      const spec = `permission-test:${crypto.randomUUID()}`;
      registerHarnessProfile(spec, {
        excludedMiddleware: ["patchToolCallsMiddleware"],
      });
      const server = new DeepAgentsServer({
        agents: {
          name: "test-agent",
          model: target === "root" ? spec : fakeModel(["Done"]),
          ...(target === "worker"
            ? {
                subagents: [
                  {
                    name: "worker",
                    description: "Worker",
                    systemPrompt: "Work.",
                    model: spec,
                  },
                ],
              }
            : {}),
        },
      });
      await expect(
        (server as unknown as ServerHandlers).handleNewSession(
          {},
          connection(),
        ),
      ).rejects.toThrow(/permission|patchToolCallsMiddleware/i);
    },
  );
});
