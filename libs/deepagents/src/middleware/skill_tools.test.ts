/**
 * Skill tool disclosure through `createDeepAgent`, observed at the model's
 * recorded calls.
 *
 * `RecordingChatModel` is neither `ChatAnthropic` nor `ChatOpenAI`, so these
 * tests exercise the path for models without mid-conversation tool
 * definitions, where disclosed tools are appended to `tools`. The gate is the
 * same on every path.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { ContextOverflowError } from "@langchain/core/errors";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type ToolCall,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command, MemorySaver, StateSchema } from "@langchain/langgraph";
import {
  createMiddleware,
  providerStrategy,
  type AgentMiddleware,
} from "langchain";
import { z } from "zod/v4";

import { createDeepAgent } from "../agent.js";
import { StateBackend } from "../backends/state.js";
import { ConfigurationError } from "../errors.js";
import { registerHarnessProfile } from "../profiles/index.js";
import {
  CRM_PATH,
  SKILLS_SOURCE,
  RecordingChatModel,
  ai,
  boundToolNames,
  boundTools,
  call,
  compacting,
  createCustomerRequest,
  expectInvalidTool,
  listCustomerRequests,
  read,
  searchTickets,
  skillFiles,
  skillMd,
  skillsAgent,
  skillsInput,
  task,
  toolMessages,
} from "../testing/skill_tools.js";
import { createSkillsMiddleware, skillsMetadataValue } from "./skills.js";
import type { SubAgent } from "./subagents.js";

const registeredCreateCustomerRequest = tool(
  async ({ title }) => `registered ${title}`,
  {
    name: "create_customer_request",
    description: "Create a customer request (registered).",
    schema: z.object({ title: z.string() }),
  },
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the gate", () => {
  it("binds a skill tool only after its skill is read", async () => {
    const model = new RecordingChatModel(
      ai(read("r1")),
      ai(call("create_customer_request", "c1", { title: "refund" })),
    );

    const result = await skillsAgent(model).invoke(
      skillsInput({ crm: "create_customer_request" }),
    );

    expect(boundToolNames(model.calls[0])).not.toContain(
      "create_customer_request",
    );
    expect(boundToolNames(model.calls[1]).at(-1)).toBe(
      "create_customer_request",
    );
    const [ran] = toolMessages(result, "create_customer_request");
    expect(ran.content).toBe("created refund (c1)");
  });

  it("rejects a call made in the same turn as the read", async () => {
    const model = new RecordingChatModel(
      ai(read("r1"), call("create_customer_request", "c1", { title: "early" })),
      ai(call("create_customer_request", "c2", { title: "late" })),
    );

    const result = await skillsAgent(model).invoke(
      skillsInput({ crm: "create_customer_request" }),
    );

    const [rejected, ran] = toolMessages(result, "create_customer_request");
    expectInvalidTool(rejected, "create_customer_request");
    expect(rejected.tool_call_id).toBe("c1");
    expect(ran.content).toBe("created late (c2)");
  });

  it("rejects a call before any read without running it", async () => {
    const run = vi.fn(async () => "ran");
    const watched = tool(run, {
      name: "create_customer_request",
      description: "Create a customer request.",
      schema: z.object({ title: z.string() }),
    });
    const model = new RecordingChatModel(
      ai(call("create_customer_request", "c1", { title: "x" })),
    );

    const result = await skillsAgent(model, { skillTools: [watched] }).invoke(
      skillsInput({ crm: "create_customer_request" }),
    );

    const [rejected] = toolMessages(result, "create_customer_request");
    expectInvalidTool(rejected, "create_customer_request");
    expect(run).not.toHaveBeenCalled();
    expect(boundToolNames(model.calls[1])).not.toContain(
      "create_customer_request",
    );
  });

  it("never lists skill tools in the invalid-tool error", async () => {
    const model = new RecordingChatModel(
      ai(read("r1")),
      ai(call("no_such_tool", "c1")),
    );

    const result = await skillsAgent(model).invoke(
      skillsInput({ crm: "create_customer_request" }),
    );

    const [error] = toolMessages(result, "no_such_tool");
    expect(error.status).toBe("error");
    expect(error.content).toContain("read_file");
    expect(error.content).not.toContain("create_customer_request");
  });

  it("rejects a skill tool that no read skill names", async () => {
    const model = new RecordingChatModel(
      ai(read("r1")),
      ai(call("create_customer_request", "c1", { title: "x" })),
    );

    const result = await skillsAgent(model, {
      skillTools: [createCustomerRequest, listCustomerRequests],
    }).invoke(skillsInput({ crm: "list_customer_requests" }));

    expectInvalidTool(
      toolMessages(result, "create_customer_request")[0],
      "create_customer_request",
    );
  });

  it("withdraws the tool when compaction drops the read", async () => {
    const model = new RecordingChatModel(
      ai(read("r1")),
      ai(call("create_customer_request", "c1", { title: "a" })),
      // Five messages: compaction keeps only the c1 exchange, dropping the read.
      "summary",
      ai(call("create_customer_request", "c2", { title: "b" })),
    );
    const checkpointer = new MemorySaver();
    const agent = skillsAgent(model, {
      middleware: [compacting(5, 2)],
      checkpointer,
    });
    const config = { configurable: { thread_id: "withdrawal" } };

    const result = await agent.invoke(
      skillsInput({ crm: "create_customer_request" }),
      config,
    );

    expect(boundToolNames(model.calls[1])).toContain("create_customer_request");
    expect(boundToolNames(model.calls[3])).not.toContain(
      "create_customer_request",
    );
    const [ran, rejected] = toolMessages(result, "create_customer_request");
    expect(ran.content).toBe("created a (c1)");
    expectInvalidTool(rejected, "create_customer_request");
    const state = await agent.graph.getState(config);
    expect(state.values._skillToolsDisclosed).toEqual({});
  });

  it("applies interruptOn to a disclosed skill tool, and runs it on approval", async () => {
    const model = new RecordingChatModel(
      ai(read("r1")),
      ai(call("create_customer_request", "c1", { title: "x" })),
    );
    const agent = skillsAgent(model, {
      interruptOn: { create_customer_request: true },
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "hitl" } };

    const paused = await agent.invoke(
      skillsInput({ crm: "create_customer_request" }),
      config,
    );
    const [interrupt] = (paused as any).__interrupt__;
    expect(interrupt.value.actionRequests[0].name).toBe(
      "create_customer_request",
    );
    expect(toolMessages(paused, "create_customer_request")).toEqual([]);

    const resumed = await agent.invoke(
      new Command({ resume: { decisions: [{ type: "approve" }] } }),
      config,
    );

    const [ran] = toolMessages(resumed, "create_customer_request");
    expect(ran.content).toBe("created x (c1)");
  });

  it("rejects a disclosed skill tool that the harness profile excludes", async () => {
    registerHarnessProfile("skilltoolsexclusion", {
      excludedTools: ["create_customer_request"],
    });
    const model = new RecordingChatModel(
      ai(read("r1")),
      ai(call("create_customer_request", "c1", { title: "x" })),
    );
    vi.spyOn(model, "getName").mockReturnValue("ConfigurableModel");
    (model as any)._defaultConfig = {
      modelProvider: "skilltoolsexclusion",
      model: "model",
    };

    const result = await skillsAgent(model).invoke(
      skillsInput({ crm: "create_customer_request" }),
    );

    expect(boundToolNames(model.calls[1])).not.toContain(
      "create_customer_request",
    );
    const [rejected] = toolMessages(result, "create_customer_request");
    expect(rejected.content).toBe(
      "Error: create_customer_request is not available.",
    );
  });
});

describe("the disclosed record", () => {
  it("follows each model call", async () => {
    const model = new RecordingChatModel(
      ai(read("r1")),
      new AIMessage("first run done"),
    );
    const agent = skillsAgent(model, {
      skillTools: [createCustomerRequest, listCustomerRequests],
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "record" } };

    await agent.invoke(
      skillsInput({ crm: "create_customer_request list_customer_requests" }),
      config,
    );

    const state = await agent.graph.getState(config);
    expect(state.values._skillToolsDisclosed).toEqual({
      create_customer_request: "create_customer_request",
      list_customer_requests: "list_customer_requests",
    });
    const again = await agent.invoke(
      { messages: [new HumanMessage("again")] },
      config,
    );
    expect(again).not.toHaveProperty("_skillToolsDisclosed");
  });

  it("is cleared by a rebuild without skill tools, so a checkpointed record admits nothing", async () => {
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: "rebuild" } };
    const approval = { create_customer_request: true };

    // Built with the skill tool: reading the skill records it as disclosed.
    await skillsAgent(new RecordingChatModel(ai(read("r1"))), {
      checkpointer,
    }).invoke(skillsInput({ crm: "create_customer_request" }), config);
    // Rebuilt without skill tools: the model reuses the call from history and pauses for approval.
    const without = skillsAgent(
      new RecordingChatModel(
        ai(call("create_customer_request", "c1", { title: "x" })),
      ),
      { skillTools: undefined, interruptOn: approval, checkpointer },
    );
    const paused = await without.invoke(
      { messages: [new HumanMessage("file it")] },
      config,
    );
    expect((paused as any).__interrupt__).toHaveLength(1);
    const state = await without.graph.getState(config);
    expect(state.values._skillToolsDisclosed).toEqual({});
    // Rebuilt with the skill tool again: resuming runs the tools without a new model call.
    const withTools = skillsAgent(new RecordingChatModel(), {
      interruptOn: approval,
      checkpointer,
    });
    const result = await withTools.invoke(
      new Command({ resume: { decisions: [{ type: "approve" }] } }),
      config,
    );

    expectInvalidTool(
      toolMessages(result, "create_customer_request")[0],
      "create_customer_request",
    );
  });
});

describe("what counts as a skill read", () => {
  /**
   * Return whether one model call is shown `create_customer_request` after
   * `readCall` and its result, built from `result`'s fields.
   */
  async function disclosesAfter(
    readCall: ToolCall,
    result: Record<string, unknown>,
  ) {
    const model = new RecordingChatModel();
    const readResult = new ToolMessage({
      content: "# crm",
      tool_call_id: readCall.id!,
      name: readCall.name,
      ...result,
    });
    await skillsAgent(model).invoke(
      skillsInput({ crm: "create_customer_request" }, [
        new HumanMessage("go"),
        ai(readCall),
        readResult,
      ]),
    );
    return boundToolNames(model.calls[0]).includes("create_customer_request");
  }

  it.each<[string, ToolCall, Record<string, unknown>, boolean]>([
    ["a plain read", read("r1"), {}, true],
    [
      "a read with offset and limit",
      read("r1", CRM_PATH, { offset: 10, limit: 5 }),
      {},
      true,
    ],
    [
      "a read through the path alias",
      { name: "read_file", id: "r1", args: { path: CRM_PATH } },
      {},
      true,
    ],
    [
      "a path that normalizes to the skill's",
      read("r1", "/skills//crm/./SKILL.md"),
      {},
      true,
    ],
    ["a relative path", read("r1", "skills/crm/SKILL.md"), {}, true],
    ["a path starting with ~", read("r1", "~/skills/crm/SKILL.md"), {}, false],
    ["a read with an error status", read("r1"), { status: "error" }, false],
    [
      "a read whose text is a backend error",
      read("r1"),
      { content: "Error: file not found" },
      false,
    ],
    [
      "a read whose first text block is a backend error",
      read("r1"),
      { content: [{ type: "text", text: "Error: file not found" }] },
      false,
    ],
    ["a read of another file", read("r1", "/skills/crm/notes.md"), {}, false],
    [
      "a path with a .. segment",
      read("r1", "/skills/../skills/crm/SKILL.md"),
      {},
      false,
    ],
    [
      "a call other than read_file",
      call("ls", "r1", { path: CRM_PATH }),
      {},
      false,
    ],
  ])("%s → %s", async (_label, readCall, result, expected) => {
    expect(await disclosesAfter(readCall, result)).toBe(expected);
  });

  it("counts a read whose result was compacted after a context overflow", async () => {
    const body = Array.from(
      { length: 60 },
      (_, i) => `Step ${i}: ${"x".repeat(100)}`,
    ).join("\n");
    const model = new RecordingChatModel(
      ai(read("r1", CRM_PATH, { limit: 1000 })),
      new ContextOverflowError("prompt is too long"),
      ai(call("create_customer_request", "c1", { title: "x" })),
    );
    model.modelProfile = { maxInputTokens: 2000 };

    const result = await skillsAgent(model, {
      middleware: [compacting(1000, 0)],
    }).invoke(
      skillsInput({
        crm: { content: skillMd("crm", "create_customer_request") + body },
      }),
    );

    const compactedRead = model.calls[2].messages.at(-1) as ToolMessage;
    expect(compactedRead.text).toContain("...(result truncated)");
    expect(compactedRead.status).not.toBe("error");
    expect(boundToolNames(model.calls[2])).toContain("create_customer_request");
    const [ran] = toolMessages(result, "create_customer_request");
    expect(ran.content).toBe("created x (c1)");
  });
});

describe("precedence", () => {
  it("discloses a deferred tool a skill names without gating it", async () => {
    const model = new RecordingChatModel(
      ai(call("search_tickets", "s1", { query: "before" })),
      ai(read("r1")),
    );

    const result = await skillsAgent(model, {
      tools: [searchTickets],
      skillTools: undefined,
    }).invoke(skillsInput({ crm: "search_tickets" }));

    const [before] = boundTools(model.calls[0], "search_tickets");
    const [after] = boundTools(model.calls[2], "search_tickets");
    expect(before.extras).toEqual({ defer_loading: true });
    expect(after.extras).toEqual({});
    expect(toolMessages(result, "search_tickets")[0].content).toBe(
      "tickets for before",
    );
  });

  it("changes nothing for a skill naming an already-bound tool", async () => {
    const model = new RecordingChatModel(ai(read("r1")));

    await skillsAgent(model).invoke(skillsInput({ crm: "ls" }));

    expect(boundToolNames(model.calls[1])).toEqual(
      boundToolNames(model.calls[0]),
    );
    expect(model.calls[1].tools).toEqual(model.calls[0].tools);
  });

  it("lets a registered tool win over a skill tool of the same name", async () => {
    const model = new RecordingChatModel(
      ai(call("create_customer_request", "c1", { title: "x" })),
      ai(read("r1")),
    );

    const result = await skillsAgent(model, {
      tools: [registeredCreateCustomerRequest],
    }).invoke(skillsInput({ crm: "create_customer_request" }));

    const [ran] = toolMessages(result, "create_customer_request");
    expect(ran.content).toBe("registered x");
    expect(
      boundToolNames(model.calls[2]).filter(
        (n) => n === "create_customer_request",
      ),
    ).toHaveLength(1);
  });

  it("lets a tool another middleware exposes win", async () => {
    const addsCreateCustomerRequest = createMiddleware({
      name: "AddsCreateCustomerRequest",
      wrapModelCall: (request, handler) =>
        handler({
          ...request,
          tools: [...request.tools, registeredCreateCustomerRequest],
        }),
      wrapToolCall: (request, handler) =>
        handler(
          request.toolCall.name === "create_customer_request"
            ? { ...request, tool: registeredCreateCustomerRequest }
            : request,
        ),
    });
    const model = new RecordingChatModel(
      ai(read("r1")),
      ai(call("create_customer_request", "c1", { title: "x" })),
    );

    const result = await skillsAgent(model, {
      middleware: [addsCreateCustomerRequest],
    }).invoke(skillsInput({ crm: "create_customer_request" }));

    expect(boundTools(model.calls[1], "create_customer_request")).toEqual([
      registeredCreateCustomerRequest,
    ]);
    const [ran] = toolMessages(result, "create_customer_request");
    expect(ran.content).toBe("registered x");
  });

  it("logs a name that resolves to nothing at debug level only", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = new RecordingChatModel(ai(read("r1")));

    await skillsAgent(model).invoke(
      skillsInput({ crm: "create_customer_request missing_tool" }),
    );

    expect(debug).toHaveBeenCalledWith(
      "Skill 'crm' names tool 'missing_tool', which is not available in this request",
    );
    expect(
      warn.mock.calls
        .flat()
        .some((arg) => String(arg).includes("missing_tool")),
    ).toBe(false);
  });
});

describe("frontmatter", () => {
  it("splits include_tools on any whitespace", async () => {
    const content =
      '---\nname: crm\ndescription: CRM\nmetadata:\n  include_tools: "create_customer_request\\n\\t list_customer_requests"\n---\n';
    const model = new RecordingChatModel(ai(read("r1")));

    await skillsAgent(model, {
      skillTools: [createCustomerRequest, listCustomerRequests],
    }).invoke(skillsInput({ crm: { content } }));

    expect(boundToolNames(model.calls[1]).slice(-2)).toEqual([
      "create_customer_request",
      "list_customer_requests",
    ]);
  });

  it("warns when include_tools is written as a YAML list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content =
      "---\nname: crm\ndescription: CRM\nmetadata:\n  include_tools: [create_customer_request, list_customer_requests]\n---\n";
    const model = new RecordingChatModel();

    const result = await skillsAgent(model).invoke(
      skillsInput({ crm: { content } }),
    );

    expect(warn).toHaveBeenCalledWith(
      `metadata.include_tools in ${CRM_PATH} should be a space-separated string of tool names; got ["create_customer_request","list_customer_requests"]`,
    );
    expect(model.calls[0].messages[0].text).not.toContain("include_tools");
    expect(result.messages.at(-1)?.text).toBe("done");
  });
});

describe("reloading skills", () => {
  it("follows include_tools edited by a reload mid-run", async () => {
    // Rewrites the crm skill to name a second tool, and nulls `skillsMetadata`
    // so the next model call reloads it.
    const editSkill = tool(
      async (_input, config) =>
        new Command({
          update: {
            files: skillFiles({
              crm: "create_customer_request list_customer_requests",
            }),
            skillsMetadata: null,
            messages: [
              new ToolMessage({
                content: "edited",
                tool_call_id: config.toolCall!.id!,
                name: "edit_skill",
              }),
            ],
          },
        }),
      {
        name: "edit_skill",
        description: "Edit the skill.",
        schema: z.object({}),
      },
    );
    const model = new RecordingChatModel(
      ai(read("r1")),
      ai(call("edit_skill", "e1")),
    );

    await skillsAgent(model, {
      tools: [editSkill],
      skillTools: [createCustomerRequest, listCustomerRequests],
    }).invoke(skillsInput({ crm: "create_customer_request" }));

    expect(boundToolNames(model.calls[1])).not.toContain(
      "list_customer_requests",
    );
    expect(boundToolNames(model.calls[2]).slice(-2)).toEqual([
      "create_customer_request",
      "list_customer_requests",
    ]);
  });
});

describe("structured responses", () => {
  it("keeps a native structured response through the record write", async () => {
    const model = new RecordingChatModel('{"answer":"42"}');

    const result = await skillsAgent(model, {
      responseFormat: providerStrategy(z.object({ answer: z.string() })),
    }).invoke(skillsInput({ crm: "create_customer_request" }));

    expect(result.structuredResponse).toEqual({ answer: "42" });
  });
});

describe("construction", () => {
  function expectConfigurationError(
    build: () => unknown,
    code: string,
    message: string,
  ) {
    let error: unknown;
    try {
      build();
    } catch (e) {
      error = e;
    }
    expect(ConfigurationError.isInstance(error)).toBe(true);
    expect((error as ConfigurationError).code).toBe(code);
    expect((error as ConfigurationError).message).toBe(message);
  }

  function skillsMiddleware(tools: unknown) {
    return createSkillsMiddleware({
      backend: new StateBackend(),
      sources: [SKILLS_SOURCE],
      tools: tools as never,
    });
  }

  it("rejects duplicate names", () => {
    for (const duplicate of [
      registeredCreateCustomerRequest,
      createCustomerRequest,
    ]) {
      expectConfigurationError(
        () => skillsMiddleware([createCustomerRequest, duplicate]),
        "SKILL_TOOLS_DUPLICATE_NAME",
        "tools contains duplicate tool name(s): create_customer_request",
      );
    }
  });

  it("rejects provider-native and plain-object entries", () => {
    const webSearch = { type: "web_search_20250305", name: "web_search" };
    const plain = {
      name: "plain",
      description: "Plain.",
      schema: z.object({}),
    };
    for (const entry of [webSearch, plain]) {
      expectConfigurationError(
        () => skillsMiddleware([entry]),
        "SKILL_TOOLS_UNSUPPORTED_TYPE",
        "tools entries must be client tools; provider-native tool objects are not supported",
      );
    }
  });

  it("rejects a single tool passed without an array", () => {
    expectConfigurationError(
      () => skillsMiddleware(createCustomerRequest),
      "SKILL_TOOLS_UNSUPPORTED_TYPE",
      "tools must be an array of tools or a resolver function, got DynamicStructuredTool; wrap a single tool in an array",
    );
  });

  it("never registers skill tools", () => {
    const middleware = skillsMiddleware([createCustomerRequest]);
    const agent = createDeepAgent({
      model: new RecordingChatModel(),
      skills: [SKILLS_SOURCE],
      middleware: [middleware],
    });

    // `createAgent` registers a middleware's `tools` with the tool node.
    expect(middleware.tools ?? []).toEqual([]);
    const registered = (agent as any).graph.nodes.tools.bound.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(registered).toContain("read_file");
    expect(registered).not.toContain("create_customer_request");
  });

  it("mounts a skills middleware passed without skills in the default's slot", async () => {
    const model = new RecordingChatModel(
      ai(read("r1")),
      ai(call("create_customer_request", "c1", { title: "x" })),
    );
    const agent = createDeepAgent({
      model,
      middleware: [skillsMiddleware([createCustomerRequest])],
    });

    const result = await agent.invoke(
      skillsInput({ crm: "create_customer_request" }),
    );

    expect(boundToolNames(model.calls[1])).toContain("create_customer_request");
    expect(toolMessages(result, "create_customer_request")[0].content).toBe(
      "created x (c1)",
    );
  });
});

describe("subagents", () => {
  /** Records the state keys a (sub)agent starts with. */
  function recordsInputState() {
    const keys = new Set<string>();
    const middleware = createMiddleware({
      name: "RecordsInputState",
      stateSchema: new StateSchema({
        skillsMetadata: skillsMetadataValue,
        _skillToolsDisclosed: z.unknown(),
      }),
      beforeAgent: (state) => {
        for (const key of Object.keys(state)) {
          if ((state as Record<string, unknown>)[key] !== undefined) {
            keys.add(key);
          }
        }
      },
    });
    return { middleware: middleware as AgentMiddleware, keys };
  }

  it("gives the general-purpose subagent the parent's skill tools", async () => {
    // Parent and general-purpose subagent share the model, so turns interleave.
    const model = new RecordingChatModel(
      task("general-purpose"),
      ai(read("r1")),
      ai(call("create_customer_request", "c1", { title: "x" })),
      new AIMessage("subagent done"),
    );

    await skillsAgent(model).invoke(
      skillsInput({ crm: "create_customer_request" }),
    );

    expect(model.calls[3].messages.at(-1)?.content).toBe("created x (c1)");
  });

  it("gives a declarative subagent only the skill tools of its own skills middleware", async () => {
    const workerModel = new RecordingChatModel(
      ai(read("r1")),
      ai(call("create_customer_request", "c1", { title: "x" })),
    );
    const worker: SubAgent = {
      name: "worker",
      description: "Files requests.",
      model: workerModel,
      skills: [SKILLS_SOURCE],
      middleware: [
        createSkillsMiddleware({
          backend: new StateBackend(),
          sources: [SKILLS_SOURCE],
          tools: [listCustomerRequests],
        }),
      ],
    };

    await skillsAgent(new RecordingChatModel(task("worker")), {
      subagents: [worker],
    }).invoke(
      skillsInput({ crm: "create_customer_request list_customer_requests" }),
    );

    const disclosed = boundToolNames(workerModel.calls[1]);
    expect(disclosed).toContain("list_customer_requests");
    expect(disclosed).not.toContain("create_customer_request");
    expect(workerModel.calls[2].messages.at(-1)?.content).toContain(
      "is not a valid tool",
    );
  });

  it("gives a declarative subagent without its own skills middleware no skill tools", async () => {
    const workerModel = new RecordingChatModel(ai(read("r1")));
    const worker: SubAgent = {
      name: "worker",
      description: "Files requests.",
      model: workerModel,
      skills: [SKILLS_SOURCE],
    };

    await skillsAgent(new RecordingChatModel(task("worker")), {
      subagents: [worker],
    }).invoke(skillsInput({ crm: "create_customer_request" }));

    expect(boundToolNames(workerModel.calls[1])).not.toContain(
      "create_customer_request",
    );
  });

  it("mirrors the parent's skill tools into a fork, without the parent's record", async () => {
    const workerModel = new RecordingChatModel(
      ai(call("create_customer_request", "c1", { title: "x" })),
    );
    const recorder = recordsInputState();
    const worker: SubAgent = {
      name: "worker",
      description: "Continues.",
      model: workerModel,
      mode: "fork",
      middleware: [recorder.middleware],
    };

    await skillsAgent(new RecordingChatModel(ai(read("r1")), task("worker")), {
      subagents: [worker],
    }).invoke(skillsInput({ crm: "create_customer_request" }));

    expect(recorder.keys).toContain("skillsMetadata");
    expect(recorder.keys).not.toContain("_skillToolsDisclosed");
    expect(boundToolNames(workerModel.calls[0])).toContain(
      "create_customer_request",
    );
    expect(workerModel.calls[1].messages.at(-1)?.content).toBe(
      "created x (c1)",
    );
  });

  it("leaves the record out of an isolated subagent's input", async () => {
    const recorder = recordsInputState();
    const worker: SubAgent = {
      name: "worker",
      description: "d",
      model: new RecordingChatModel(),
      middleware: [recorder.middleware],
    };

    await skillsAgent(new RecordingChatModel(ai(read("r1")), task("worker")), {
      subagents: [worker],
    }).invoke(skillsInput({ crm: "create_customer_request" }));

    expect(recorder.keys.size).toBeGreaterThan(0);
    expect(recorder.keys).not.toContain("_skillToolsDisclosed");
  });
});
