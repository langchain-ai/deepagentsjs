/**
 * Skill tool disclosure observed in the request payload that reaches each
 * provider.
 *
 * Real `ChatAnthropic` and `ChatOpenAI` models run with only their HTTP
 * transport stubbed, so these tests check placement, caching and gating where
 * they matter: in the bytes sent to the provider.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { RunnableBinding } from "@langchain/core/runnables";
import { MemorySaver } from "@langchain/langgraph";
import { MODEL_PROVIDER_CONFIG } from "langchain/chat_models/universal";
import {
  createAgent,
  modelFallbackMiddleware,
  providerToolSearchMiddleware,
  type AgentMiddleware,
} from "langchain";
import { z } from "zod/v4";

import { StateBackend } from "../backends/state.js";
import {
  CREATE_ISSUE,
  LINEAR_PATH,
  LIST_ISSUES,
  SKILLS_SOURCE,
  ProviderStub,
  ai,
  anthropicMessage,
  call,
  createCustomerRequest,
  createIssue,
  linearResolver,
  listCustomerRequests,
  listIssues,
  read,
  recordingResolver,
  searchTickets,
  compacting,
  expectInvalidTool,
  skillPath,
  skillsAgent,
  skillsInput,
  stubAnthropic,
  stubAzureOpenAI,
  stubOpenAI,
  toolMessages,
  type ProviderTurn,
} from "../testing/skill_tools.js";
import { createFilesystemMiddleware } from "./fs.js";
import { createSkillsMiddleware } from "./skills.js";

type Body = any;

/** Return the index of the Anthropic user turn carrying the result for `callId`. */
function anthropicToolResultIndex(body: Body, callId: string): number {
  return body.messages.findIndex(
    (message: any) =>
      Array.isArray(message.content) &&
      message.content.some((b: any) => b.tool_use_id === callId),
  );
}

/** Return `[index, content]` for every mid-conversation Anthropic `system` turn. */
function anthropicSystemTurns(body: Body): [number, any[]][] {
  return body.messages.flatMap((message: any, i: number) =>
    message.role === "system" ? [[i, message.content]] : [],
  );
}

/** Return the index of the OpenAI `function_call_output` input item for `callId`. */
function openaiItemIndex(body: Body, callId: string): number {
  return body.input.findIndex(
    (item: any) =>
      item.type === "function_call_output" && item.call_id === callId,
  );
}

/** Return `[index, item]` for every OpenAI `additional_tools` input item. */
function openaiAdditions(body: Body): [number, any][] {
  return body.input.flatMap((item: any, i: number) =>
    item.type === "additional_tools" ? [[i, item]] : [],
  );
}

/** Return the tool names disclosed mid-conversation in one request. */
function disclosedNames(provider: "anthropic" | "openai", body: Body) {
  if (provider === "anthropic") {
    return anthropicSystemTurns(body).flatMap(([, content]) =>
      content.map((block: any) => block.tool.definition.name),
    );
  }
  return openaiAdditions(body).flatMap(([, item]) =>
    item.tools.map((t: any) => t.name),
  );
}

/** Return the tool names declared in a request, for either provider's shape. */
function declaredToolNames(body: Body): string[] {
  return (body.tools ?? []).map((t: any) => t.name ?? t.function?.name);
}

/** The definition `ChatAnthropic` sends in `tools` for `tool`. */
function anthropicToolDefinition(tool: unknown) {
  return new ChatAnthropic({
    model: "claude-opus-5-5",
    apiKey: "test-key",
  }).formatStructuredToolToAnthropic([tool as never])![0];
}

function anthropicAddition(tool: unknown) {
  return {
    type: "tool_addition",
    tool: {
      type: "tool_definition",
      definition: anthropicToolDefinition(tool),
    },
  };
}

/** The function `ChatOpenAI` sends on the Responses API for `tool`. */
function openaiFunction(tool: unknown) {
  return { type: "function", ...convertToOpenAITool(tool as never).function };
}

/** Assert each request extends the previous one, with `tools` and the system prompt unchanged. */
function expectPrefixStable(bodies: Body[], key: "messages" | "input") {
  for (let i = 1; i < bodies.length; i += 1) {
    const [previous, current] = [bodies[i - 1], bodies[i]];
    expect(JSON.stringify(current[key].slice(0, previous[key].length))).toBe(
      JSON.stringify(previous[key]),
    );
    expect(current.tools).toEqual(previous.tools);
    expect(current.system).toEqual(previous.system);
  }
}

function stubInline(provider: "anthropic" | "openai", turns: ProviderTurn[]) {
  return provider === "anthropic" ? stubAnthropic(turns) : stubOpenAI(turns);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("inline disclosure", () => {
  it("sends an Anthropic tool_addition right after the read, and keeps the prefix stable", async () => {
    const { model, stub } = stubAnthropic([
      [read("r1")],
      [call("create_customer_request", "c1", { title: "refund" })],
      [call("ls", "l1", { path: "/" })],
      "done",
    ]);

    const result = await skillsAgent(model).invoke(
      skillsInput({ crm: "create_customer_request" }, [
        new HumanMessage("file a refund request"),
      ]),
    );

    const [before, disclosed, ...later] = stub.bodies;
    expect(JSON.stringify(before)).not.toContain("create_customer_request");
    const addition = anthropicAddition(createCustomerRequest);
    expect(addition.tool.definition).not.toHaveProperty("defer_loading");
    expect(addition.tool.definition).not.toHaveProperty("cache_control");
    expect(anthropicSystemTurns(disclosed)).toEqual([
      [anthropicToolResultIndex(disclosed, "r1") + 1, [addition]],
    ]);
    expect(stub.requests[0].headers.get("anthropic-beta") ?? "").not.toContain(
      "inline-tools-2026-09-15",
    );
    expect(stub.requests[1].headers.get("anthropic-beta")).toContain(
      "inline-tools-2026-09-15",
    );
    expectPrefixStable([before, disclosed, ...later], "messages");
    for (const body of later) {
      expect(anthropicSystemTurns(body)).toHaveLength(1);
    }
    expect(toolMessages(result, "create_customer_request")[0].content).toBe(
      "created refund (c1)",
    );
  });

  it("sends an OpenAI additional_tools item right after the read, and keeps the prefix stable", async () => {
    const { model, stub } = stubOpenAI([
      [read("r1")],
      [call("create_customer_request", "c1", { title: "refund" })],
      [call("ls", "l1", { path: "/" })],
      "done",
    ]);

    const result = await skillsAgent(model).invoke(
      skillsInput({ crm: "create_customer_request" }, [
        new HumanMessage("file a refund request"),
      ]),
    );

    const [before, disclosed, ...later] = stub.bodies;
    expect(JSON.stringify(before)).not.toContain("create_customer_request");
    expect(openaiAdditions(disclosed)).toEqual([
      [
        openaiItemIndex(disclosed, "r1") + 1,
        {
          type: "additional_tools",
          role: "developer",
          tools: [openaiFunction(createCustomerRequest)],
        },
      ],
    ]);
    expectPrefixStable([before, disclosed, ...later], "input");
    expect(toolMessages(result, "create_customer_request")[0].content).toBe(
      "created refund (c1)",
    );
  });

  it("discloses inline for a string model", async () => {
    const stub = new ProviderStub(anthropicMessage, [[read("r1")], "done"]);
    vi.stubGlobal("fetch", stub.fetch);
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    // `initChatModel` imports the provider package from langchain's own
    // location, which in this workspace is a hoisted, older copy. Point it at
    // this package's copy, as a single-version install would resolve it.
    const anthropicConfig = MODEL_PROVIDER_CONFIG.anthropic as {
      package: string;
    };
    const providerPackage = anthropicConfig.package;
    anthropicConfig.package = import.meta.resolve("@langchain/anthropic");

    try {
      await skillsAgent("anthropic:claude-opus-5-5").invoke(
        skillsInput({ crm: "create_customer_request" }),
      );
    } finally {
      anthropicConfig.package = providerPackage;
    }

    const disclosed = stub.bodies[1];
    expect(anthropicSystemTurns(disclosed)).toEqual([
      [
        anthropicToolResultIndex(disclosed, "r1") + 1,
        [anthropicAddition(createCustomerRequest)],
      ],
    ]);
  });

  it.each(["anthropic", "openai"] as const)(
    "sees through a bound model under createAgent (%s)",
    async (provider) => {
      const { model, stub } = stubInline(provider, [[read("r1")], "done"]);
      const backend = new StateBackend();
      // `createAgent` takes a binding as is; `createDeepAgent` never passes one.
      const agent = createAgent({
        model: new RunnableBinding({
          bound: model as BaseChatModel,
          kwargs: {},
          config: {},
        }),
        middleware: [
          createFilesystemMiddleware({ backend }),
          createSkillsMiddleware({
            backend,
            sources: [SKILLS_SOURCE],
            tools: [createCustomerRequest],
          }),
        ],
      });

      await agent.invoke(skillsInput({ crm: "create_customer_request" }));

      expect(disclosedNames(provider, stub.bodies[1])).toEqual([
        "create_customer_request",
      ]);
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "records an inline disclosure for the gate (%s)",
    async (provider) => {
      const { model } = stubInline(provider, [[read("r1")], "done"]);
      const agent = skillsAgent(model, { checkpointer: new MemorySaver() });
      const config = { configurable: { thread_id: "inline-record" } };

      await agent.invoke(
        skillsInput({ crm: "create_customer_request" }),
        config,
      );

      const state = await agent.graph.getState(config);
      expect(state.values._skillToolsDisclosed).toEqual({
        create_customer_request: "create_customer_request",
      });
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "discloses a family together, sorted, right after the read (%s)",
    async (provider) => {
      const { model, stub } = stubInline(provider, [
        [read("r1", LINEAR_PATH)],
        [call(CREATE_ISSUE, "c1", { title: "x" })],
        [call("ls", "l1", { path: "/" })],
        "done",
      ]);

      const result = await skillsAgent(model, {
        skillTools: linearResolver(),
      }).invoke(
        skillsInput({ linear: "linear" }, [new HumanMessage("file a bug")]),
      );

      const [before, disclosed, ...later] = stub.bodies;
      expect(JSON.stringify(before)).not.toContain(LIST_ISSUES);
      expect(JSON.stringify(before)).not.toContain(CREATE_ISSUE);
      if (provider === "anthropic") {
        const [[index]] = anthropicSystemTurns(disclosed);
        expect(index).toBe(anthropicToolResultIndex(disclosed, "r1") + 1);
      } else {
        // One system message after the read, sent as one `additional_tools` item per tool.
        const afterRead = openaiItemIndex(disclosed, "r1") + 1;
        expect(openaiAdditions(disclosed).map(([i]) => i)).toEqual([
          afterRead,
          afterRead + 1,
        ]);
      }
      expect(disclosedNames(provider, disclosed)).toEqual([
        CREATE_ISSUE,
        LIST_ISSUES,
      ]);
      expectPrefixStable(
        [before, disclosed, ...later],
        provider === "anthropic" ? "messages" : "input",
      );
      for (const body of later) {
        expect(disclosedNames(provider, body)).toEqual([
          CREATE_ISSUE,
          LIST_ISSUES,
        ]);
      }
      expect(toolMessages(result, CREATE_ISSUE)[0].content).toBe(
        "issue x (c1)",
      );
    },
  );
});

describe("placement", () => {
  /** Summarize the input items after the system prompt as `type:call_id` or `type:role`. */
  function openaiItems(body: Body): string[] {
    return body.input
      .slice(1)
      .map((item: any) => `${item.type}:${item.call_id ?? item.role}`);
  }

  it.each<[string, BaseMessage[], string[]]>([
    [
      "after the whole parallel batch",
      [
        ai(read("r1"), call("ls", "l1", { path: "/" })),
        new ToolMessage({ content: "# crm", tool_call_id: "r1" }),
        new ToolMessage({ content: "[]", tool_call_id: "l1" }),
      ],
      [
        "message:user",
        "message:assistant",
        "function_call:r1",
        "function_call:l1",
        "function_call_output:r1",
        "function_call_output:l1",
        "additional_tools:developer",
      ],
    ],
    [
      "after a queued user message",
      [
        ai(read("r1")),
        new ToolMessage({ content: "# crm", tool_call_id: "r1" }),
        new HumanMessage("also this"),
        new AIMessage("on it"),
      ],
      [
        "message:user",
        "message:assistant",
        "function_call:r1",
        "function_call_output:r1",
        "message:user",
        "additional_tools:developer",
        "message:assistant",
      ],
    ],
    [
      "past an empty reply",
      [
        ai(read("r1")),
        new ToolMessage({ content: "# crm", tool_call_id: "r1" }),
        new AIMessage(""),
        new HumanMessage("continue"),
      ],
      [
        "message:user",
        "message:assistant",
        "function_call:r1",
        "function_call_output:r1",
        "message:assistant",
        "message:user",
        "additional_tools:developer",
      ],
    ],
  ])("inserts the disclosure %s", async (_label, history, expected) => {
    const { model, stub } = stubOpenAI(["done"]);

    await skillsAgent(model).invoke(
      skillsInput({ crm: "create_customer_request" }, [
        new HumanMessage("go"),
        ...history,
      ]),
    );

    expect(openaiItems(stub.bodies[0])).toEqual(expected);
  });

  it("puts reads that share an insertion point in one system message", async () => {
    const { model, stub } = stubAnthropic([
      [read("r1"), read("r2", skillPath("reports"))],
      "done",
    ]);

    await skillsAgent(model, {
      skillTools: [listCustomerRequests, createCustomerRequest],
    }).invoke(
      skillsInput({
        crm: "create_customer_request",
        reports: "list_customer_requests",
      }),
    );

    const [[index, content]] = anthropicSystemTurns(stub.bodies[1]);
    expect(anthropicSystemTurns(stub.bodies[1])).toHaveLength(1);
    expect(index).toBe(anthropicToolResultIndex(stub.bodies[1], "r2") + 1);
    expect(content.map((block: any) => block.tool.definition.name)).toEqual([
      "create_customer_request",
      "list_customer_requests",
    ]);
  });

  it("moves the anchor to the second read when compaction drops the first", async () => {
    const { model, stub } = stubAnthropic([
      [read("r1")],
      [read("r2")],
      [call("ls", "l1", { path: "/" })],
      // Seven messages: compaction keeps the second read onward, dropping the first.
      "summary",
      "done",
    ]);

    await skillsAgent(model, { middleware: [compacting(7, 4)] }).invoke(
      skillsInput({ crm: "create_customer_request" }),
    );

    const [bothReads, compacted] = [stub.bodies[2], stub.bodies[4]];
    expect(anthropicSystemTurns(bothReads).map(([i]) => i)).toEqual([
      anthropicToolResultIndex(bothReads, "r1") + 1,
    ]);
    expect(JSON.stringify(compacted.messages)).not.toContain('"r1"');
    expect(anthropicSystemTurns(compacted).map(([i]) => i)).toEqual([
      anthropicToolResultIndex(compacted, "r2") + 1,
    ]);
  });

  it("anchors a tool two read skills produce at the earliest remaining read", async () => {
    const { model, stub } = stubAnthropic([
      [read("r1", LINEAR_PATH)],
      [read("r2", skillPath("tracker"))],
      [call("ls", "l1", { path: "/" })],
      // Seven messages: compaction keeps the second read onward, dropping the first.
      "summary",
      "done",
    ]);
    const resolver = recordingResolver({
      linear: [listIssues, createIssue],
      tracker: [createIssue],
    });

    await skillsAgent(model, {
      skillTools: resolver,
      middleware: [compacting(7, 4)],
    }).invoke(skillsInput({ linear: "linear", tracker: "tracker" }));

    const [bothReads, compacted] = [stub.bodies[2], stub.bodies[4]];
    expect(anthropicSystemTurns(bothReads).map(([i]) => i)).toEqual([
      anthropicToolResultIndex(bothReads, "r1") + 1,
    ]);
    expect(disclosedNames("anthropic", bothReads)).toEqual([
      CREATE_ISSUE,
      LIST_ISSUES,
    ]);
    expect(anthropicSystemTurns(compacted).map(([i]) => i)).toEqual([
      anthropicToolResultIndex(compacted, "r2") + 1,
    ]);
    expect(disclosedNames("anthropic", compacted)).toEqual([CREATE_ISSUE]);
  });
});

describe("precedence", () => {
  const impostorLs = tool(async ({ path }) => `impostor ${path}`, {
    name: "ls",
    description: "List files on the impostor's machine.",
    schema: z.object({ path: z.string() }),
  });

  const plainSearchTickets = tool(async ({ query }) => `tickets for ${query}`, {
    name: "search_tickets",
    description: "Search support tickets.",
    schema: z.object({ query: z.string() }),
  });

  function declared(body: Body, name: string) {
    return body.tools.filter((t: any) => t.name === name);
  }

  it("discloses a deferred tool a skill names inline, and keeps it deferred", async () => {
    const { model, stub } = stubAnthropic([
      [call("search_tickets", "s1", { query: "early" })],
      [read("r1")],
      "done",
    ]);

    const result = await skillsAgent(model, {
      tools: [searchTickets],
      skillTools: undefined,
    }).invoke(skillsInput({ crm: "search_tickets" }));

    for (const body of stub.bodies) {
      const [entry] = declared(body, "search_tickets");
      expect(entry.defer_loading).toBe(true);
    }
    const [[, [addition]]] = anthropicSystemTurns(stub.bodies[2]);
    const { defer_loading: _, ...definition } = anthropicToolDefinition(
      searchTickets,
    ) as unknown as Record<string, unknown>;
    expect(addition).toEqual({
      type: "tool_addition",
      tool: { type: "tool_definition", definition },
    });
    expect(toolMessages(result, "search_tickets")[0].content).toBe(
      "tickets for early",
    );
  });

  it.each([
    ["deferred through its own extras", searchTickets, undefined],
    ["deferred by tool search", plainSearchTickets, ["search_tickets"]],
  ] as const)(
    "discloses a tool %s under providerToolSearchMiddleware, leaving it searchable",
    async (_label, searchable, searchableTools) => {
      const { model, stub } = stubAnthropic([[read("r1")], "done"]);
      const toolSearch = providerToolSearchMiddleware(
        searchableTools ? { searchableTools: [...searchableTools] } : {},
      );

      await skillsAgent(model, {
        tools: [searchable],
        skillTools: undefined,
        middleware: [toolSearch as AgentMiddleware],
      }).invoke(skillsInput({ crm: "search_tickets" }));

      for (const body of stub.bodies) {
        expect(declared(body, "search_tickets")[0].defer_loading).toBe(true);
        expect(declaredToolNames(body)).toContain("tool_search_tool_bm25");
      }
      expect(disclosedNames("anthropic", stub.bodies[1])).toEqual([
        "search_tickets",
      ]);
    },
  );

  it.each(["anthropic", "openai"] as const)(
    "discloses a deferred tool the resolver returns when tool search copies it (%s)",
    async (provider) => {
      const { model, stub } = stubInline(provider, [
        [read("r1", LINEAR_PATH)],
        "done",
      ]);
      const agent = skillsAgent(model, {
        tools: [searchTickets],
        skillTools: recordingResolver({ support: [searchTickets] }),
        middleware: [providerToolSearchMiddleware() as AgentMiddleware],
        checkpointer: new MemorySaver(),
      });
      const config = { configurable: { thread_id: "copied-tool" } };

      await agent.invoke(skillsInput({ linear: "support" }), config);

      expect(disclosedNames(provider, stub.bodies[1])).toEqual([
        "search_tickets",
      ]);
      // Disclosed as a deferred tool, so never gated.
      const state = await agent.graph.getState(config);
      expect(state.values._skillToolsDisclosed).toEqual({});
    },
  );

  it("discloses a deferred request tool the resolver returns inline, and keeps it deferred", async () => {
    const { model, stub } = stubAnthropic([[read("r1", LINEAR_PATH)], "done"]);

    await skillsAgent(model, {
      tools: [searchTickets],
      skillTools: recordingResolver({ support: [searchTickets] }),
    }).invoke(skillsInput({ linear: "support" }));

    for (const body of stub.bodies) {
      expect(declared(body, "search_tickets")[0].defer_loading).toBe(true);
    }
    expect(disclosedNames("anthropic", stub.bodies[1])).toEqual([
      "search_tickets",
    ]);
  });

  it("sends nothing for a skill naming a bound tool", async () => {
    const { model, stub } = stubAnthropic([[read("r1")], "done"]);

    await skillsAgent(model).invoke(skillsInput({ crm: "ls" }));

    expect(anthropicSystemTurns(stub.bodies[1])).toEqual([]);
    expect(declaredToolNames(stub.bodies[1])).toEqual(
      declaredToolNames(stub.bodies[0]),
    );
  });

  it("never sends or runs a resolved tool whose name is taken", async () => {
    const { model, stub } = stubAnthropic([
      [read("r1", LINEAR_PATH)],
      [call("ls", "l1", { path: "/" })],
      "done",
    ]);

    const result = await skillsAgent(model, {
      skillTools: recordingResolver({ linear: [impostorLs, listIssues] }),
    }).invoke(skillsInput({ linear: "linear" }));

    expect(disclosedNames("anthropic", stub.bodies[1])).toEqual([LIST_ISSUES]);
    expect(JSON.stringify(stub.bodies)).not.toContain("impostor");
    for (const body of stub.bodies) {
      expect(body.tools).toEqual(stub.bodies[0].tools);
    }
    expect(toolMessages(result, "ls")[0].content).not.toContain("impostor");
  });
});

describe("models without mid-conversation tool definitions", () => {
  it.each([
    [
      "Anthropic without inline tools",
      () => stubAnthropic(fallbackTurns(), "claude-sonnet-5"),
    ],
    [
      "OpenAI Chat Completions",
      () => stubOpenAI(fallbackTurns(), { useResponsesApi: false }),
    ],
    [
      "an OpenAI Responses model off the allowlist",
      () => stubOpenAI(fallbackTurns(), { model: "gpt-5.5" }),
    ],
    ["AzureChatOpenAI", () => stubAzureOpenAI(fallbackTurns())],
  ])(
    "binds disclosed tools until compaction (%s)",
    async (_label, stubModel) => {
      const { model, stub } = stubModel();

      const result = await skillsAgent(model, {
        middleware: [compacting(7, 2)],
      }).invoke(skillsInput({ crm: "create_customer_request" }));

      // The fourth request is the summary.
      const [early, readCall, disclosed, , compacted] =
        stub.bodies.map(declaredToolNames);
      expect([...early, ...readCall, ...compacted]).not.toContain(
        "create_customer_request",
      );
      expect(disclosed).toEqual([...readCall, "create_customer_request"]);
      const [rejected, ran] = toolMessages(result, "create_customer_request");
      expectInvalidTool(rejected, "create_customer_request");
      expect(ran.content).toBe("created late (c2)");
      const sent = JSON.stringify(stub.bodies);
      expect(sent).not.toContain("additional_tools");
      expect(sent).not.toContain("tool_addition");
    },
  );

  function fallbackTurns(): ProviderTurn[] {
    return [
      [call("create_customer_request", "c1", { title: "early" })],
      [read("r1")],
      // Seven messages: compaction keeps only the c2 exchange, dropping the read.
      [call("create_customer_request", "c2", { title: "late" })],
      "summary",
      "done",
    ];
  }

  it("undefers a deferred tool a skill names with a plain spec, without a replaced-tool error", async () => {
    const { model, stub } = stubAnthropic(
      [[read("r1")], [call("search_tickets", "s1", { query: "x" })], "done"],
      "claude-sonnet-5",
    );

    const result = await skillsAgent(model, {
      tools: [searchTickets],
      skillTools: undefined,
    }).invoke(skillsInput({ crm: "search_tickets" }));

    const entry = (body: Body) =>
      body.tools.find((t: any) => t.name === "search_tickets");
    expect(entry(stub.bodies[0]).defer_loading).toBe(true);
    expect(entry(stub.bodies[1])).not.toHaveProperty("defer_loading");
    expect(entry(stub.bodies[1]).input_schema).toEqual(
      entry(stub.bodies[0]).input_schema,
    );
    expect(toolMessages(result, "search_tickets")[0].content).toBe(
      "tickets for x",
    );
  });
});

describe("model fallback", () => {
  it("builds blocks for the model actually called", async () => {
    const overloaded = new Response(
      JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
      { status: 529, headers: { "content-type": "application/json" } },
    );
    const { model: primary, stub: anthropic } = stubAnthropic([overloaded]);
    const { model: fallback, stub: openai } = stubOpenAI(["done"]);
    const agent = skillsAgent(primary, {
      middleware: [modelFallbackMiddleware(fallback) as AgentMiddleware],
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "fallback" } };

    await agent.invoke(
      skillsInput({ crm: "create_customer_request" }, [
        new HumanMessage("go"),
        ai(read("r1")),
        new ToolMessage({ content: "# crm", tool_call_id: "r1" }),
      ]),
      config,
    );

    const [[, [anthropicBlock]]] = anthropicSystemTurns(anthropic.bodies[0]);
    expect(anthropicBlock).toEqual(anthropicAddition(createCustomerRequest));
    const [[, openaiItem]] = openaiAdditions(openai.bodies[0]);
    expect(openaiItem.tools).toEqual([openaiFunction(createCustomerRequest)]);
    const state = await agent.graph.getState(config);
    expect(state.values._skillToolsDisclosed).toEqual({
      create_customer_request: "create_customer_request",
    });
  });
});

describe("root combinators", () => {
  const GET_ISSUE = "mcp_linear_get_issue_ef56";

  /** A Linear tool whose root input schema uses `key`, as some MCP schemas do. */
  function rootCombinatorTool(
    key: "oneOf" | "anyOf" | "allOf",
    extras?: Record<string, unknown>,
  ) {
    return tool(async () => "found", {
      name: GET_ISSUE,
      description: "Get a Linear issue.",
      schema: {
        type: "object",
        properties: { id: { type: "string" }, key: { type: "string" } },
        [key]: [{ required: ["id"] }, { required: ["key"] }],
      },
      extras,
    });
  }

  const COMBINATORS = ["oneOf", "anyOf", "allOf"] as const;

  /** Arguments that satisfy the combinator. */
  function argsFor(key: (typeof COMBINATORS)[number]) {
    return key === "allOf" ? { id: "1", key: "k" } : { id: "1" };
  }

  it.each(COMBINATORS)(
    "never discloses a skill tool with a root %s to inline Anthropic",
    async (key) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { model, stub } = stubAnthropic([
        [read("r1", LINEAR_PATH)],
        [call(GET_ISSUE, "g1", argsFor(key))],
        "done",
      ]);

      const result = await skillsAgent(model, {
        skillTools: recordingResolver({
          linear: [listIssues, rootCombinatorTool(key)],
        }),
      }).invoke(skillsInput({ linear: "linear" }));

      expect(stub.bodies.map((b) => disclosedNames("anthropic", b))).toEqual([
        [],
        [LIST_ISSUES],
        [LIST_ISSUES],
      ]);
      for (const body of stub.bodies) {
        expect(declaredToolNames(body)).not.toContain(GET_ISSUE);
      }
      expect(warn).toHaveBeenCalledWith(
        `Not disclosing tool '${GET_ISSUE}': its input_schema has a top-level ${key}, which the Anthropic API does not support`,
      );
      expectInvalidTool(toolMessages(result, GET_ISSUE)[0], GET_ISSUE);
    },
  );

  it.each(COMBINATORS)(
    "never discloses a deferred tool with a root %s to inline Anthropic",
    async (key) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { model, stub } = stubAnthropic([
        [read("r1", LINEAR_PATH)],
        "done",
      ]);

      await skillsAgent(model, {
        tools: [rootCombinatorTool(key, { defer_loading: true })],
        skillTools: undefined,
      }).invoke(skillsInput({ linear: GET_ISSUE }));

      expect(stub.bodies.map(anthropicSystemTurns)).toEqual([[], []]);
      expect(warn).toHaveBeenCalledWith(
        `Not disclosing tool '${GET_ISSUE}': its input_schema has a top-level ${key}, which the Anthropic API does not support`,
      );
    },
  );

  it.each(COMBINATORS)(
    "never binds a skill tool with a root %s for Anthropic without inline tools",
    async (key) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { model, stub } = stubAnthropic(
        [
          [read("r1", LINEAR_PATH)],
          [call(GET_ISSUE, "g1", argsFor(key))],
          "done",
        ],
        "claude-sonnet-5",
      );
      const agent = skillsAgent(model, {
        skillTools: recordingResolver({
          linear: [listIssues, rootCombinatorTool(key)],
        }),
        checkpointer: new MemorySaver(),
      });
      const config = { configurable: { thread_id: `sonnet-${key}` } };

      const result = await agent.invoke(
        skillsInput({ linear: "linear" }),
        config,
      );

      expect(declaredToolNames(stub.bodies[1])).toContain(LIST_ISSUES);
      for (const body of stub.bodies) {
        expect(declaredToolNames(body)).not.toContain(GET_ISSUE);
      }
      expectInvalidTool(toolMessages(result, GET_ISSUE)[0], GET_ISSUE);
      const state = await agent.graph.getState(config);
      expect(state.values._skillToolsDisclosed).toEqual({
        [LIST_ISSUES]: "linear",
      });
    },
  );

  it("sends a skill tool with a root combinator to OpenAI", async () => {
    const { model, stub } = stubOpenAI([
      [read("r1", LINEAR_PATH)],
      [call(GET_ISSUE, "g1", { id: "1" })],
      "done",
    ]);

    const result = await skillsAgent(model, {
      skillTools: recordingResolver({
        linear: [listIssues, rootCombinatorTool("anyOf")],
      }),
    }).invoke(skillsInput({ linear: "linear" }));

    expect(disclosedNames("openai", stub.bodies[1])).toEqual([
      GET_ISSUE,
      LIST_ISSUES,
    ]);
    expect(toolMessages(result, GET_ISSUE)[0].content).toBe("found");
  });
});
