/**
 * Skill tools supplied by a resolver, through `createDeepAgent` with a skills
 * middleware passed in `middleware`.
 *
 * `RecordingChatModel` takes the path for models without mid-conversation
 * tool definitions, so disclosed tools show up in the tools each model call
 * was bound with. The resolver records every name it is asked for.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command, MemorySaver } from "@langchain/langgraph";
import { z } from "zod/v4";

import { StateBackend } from "../backends/state.js";
import {
  CREATE_ISSUE,
  LINEAR_PATH,
  LIST_ISSUES,
  SKILLS_SOURCE,
  RecordingChatModel,
  ai,
  boundToolNames,
  boundTools,
  call,
  createIssue,
  linearResolver,
  listIssues,
  loggedCreateIssue,
  read,
  recordingResolver,
  searchTickets,
  compacting,
  expectInvalidTool,
  skillPath,
  skillsAgent,
  skillsInput,
  task,
  toolMessages,
} from "../testing/skill_tools.js";
import { createSkillsMiddleware, type SkillToolResolver } from "./skills.js";
import type { SubAgent } from "./subagents.js";

/** Return the name the resolver was asked for just before the tool call `callId` ran. */
function ranVia(calls: string[], callId: string): string {
  return calls[calls.indexOf(`ran ${callId}`) - 1];
}

const otherSearchTickets = tool(async ({ query }) => `other ${query}`, {
  name: "search_tickets",
  description: "Search tickets somewhere else.",
  schema: z.object({ query: z.string() }),
});

const otherLs = tool(async ({ path }) => `other files in ${path}`, {
  name: "ls",
  description: "List files somewhere else.",
  schema: z.object({ path: z.string() }),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolution", () => {
  it("discloses a family of tools for one name", async () => {
    const model = new RecordingChatModel(
      ai(read("r1", LINEAR_PATH)),
      ai(call(CREATE_ISSUE, "c1", { title: "bug" })),
    );

    const result = await skillsAgent(model, {
      skillTools: linearResolver(),
    }).invoke(skillsInput({ linear: "linear" }));

    expect(boundToolNames(model.calls[0])).not.toContain(LIST_ISSUES);
    expect(boundToolNames(model.calls[0])).not.toContain(CREATE_ISSUE);
    expect(boundToolNames(model.calls[1]).slice(-2)).toEqual([
      CREATE_ISSUE,
      LIST_ISSUES,
    ]);
    expect(toolMessages(result, CREATE_ISSUE)[0].content).toBe(
      "issue bug (c1)",
    );
  });

  it("claims exact names without calling the resolver", async () => {
    const resolver = linearResolver();
    const model = new RecordingChatModel(ai(read("r1")));

    await skillsAgent(model, {
      skillTools: resolver,
      tools: [searchTickets],
    }).invoke(skillsInput({ crm: "search_tickets ls linear" }));

    const [deferred] = boundTools(model.calls[1], "search_tickets");
    expect(deferred.extras).toEqual({});
    expect(boundTools(model.calls[1], "ls")).toHaveLength(1);
    expect(resolver.calls).toEqual(["linear"]);
  });

  it("discloses a deferred request tool the resolver returns, ungated", async () => {
    const resolver = recordingResolver({ support: [searchTickets] });
    const model = new RecordingChatModel(
      ai(call("search_tickets", "s1", { query: "before" })),
      ai(read("r1")),
      ai(call("search_tickets", "s2", { query: "after" })),
    );

    const result = await skillsAgent(model, {
      skillTools: resolver,
      tools: [searchTickets],
    }).invoke(skillsInput({ crm: "support" }));

    const [before] = boundTools(model.calls[0], "search_tickets");
    const [after] = boundTools(model.calls[2], "search_tickets");
    expect(before.extras).toEqual({ defer_loading: true });
    expect(after.extras).toEqual({});
    expect(
      toolMessages(result, "search_tickets").map((m) => m.content),
    ).toEqual(["tickets for before", "tickets for after"]);
    // One resolution per model call after the read, and none for the registered tool's call.
    expect(resolver.calls).toEqual(["support", "support"]);
  });

  it("lets a request tool stand for a resolved tool of the same name", async () => {
    const resolver = recordingResolver({
      support: [otherSearchTickets, otherLs, listIssues],
    });
    const model = new RecordingChatModel(
      ai(read("r1")),
      ai(
        call("search_tickets", "s1", { query: "x" }),
        call("ls", "l1", { path: "/" }),
      ),
    );
    const agent = skillsAgent(model, {
      skillTools: resolver,
      tools: [searchTickets],
      checkpointer: new MemorySaver(),
    });
    const config = { configurable: { thread_id: "taken-names" } };

    const result = await agent.invoke(skillsInput({ crm: "support" }), config);

    // The deferred `search_tickets` is disclosed, and the bound `ls` left alone.
    const [disclosed] = boundTools(model.calls[1], "search_tickets");
    expect(disclosed.description).toBe(searchTickets.description);
    expect(disclosed.extras).toEqual({});
    expect(boundTools(model.calls[1], "ls")).toEqual(
      boundTools(model.calls[0], "ls"),
    );
    expect(boundToolNames(model.calls[1]).at(-1)).toBe(LIST_ISSUES);
    expect(toolMessages(result, "search_tickets")[0].content).toBe(
      "tickets for x",
    );
    expect(toolMessages(result, "ls")[0].content).not.toContain("other");
    // Only `LIST_ISSUES` is gated.
    const state = await agent.graph.getState(config);
    expect(state.values._skillToolsDisclosed).toEqual({
      [LIST_ISSUES]: "support",
    });
  });

  it("discloses a tool two names produce once, and looks it up by the first", async () => {
    const resolver = recordingResolver();
    const logged = loggedCreateIssue(resolver.calls);
    resolver.setFamilies({ tracker: [logged], linear: [listIssues, logged] });
    const model = new RecordingChatModel(
      ai(read("r1", LINEAR_PATH)),
      ai(call(CREATE_ISSUE, "c1", { title: "x" })),
    );

    await skillsAgent(model, { skillTools: resolver }).invoke(
      skillsInput({ linear: "tracker linear" }),
    );

    expect(
      boundToolNames(model.calls[1]).filter((n) => n === CREATE_ISSUE),
    ).toHaveLength(1);
    expect(ranVia(resolver.calls, "c1")).toBe("tracker");
  });

  it("moves the lookup to the next producer when compaction drops the anchoring read", async () => {
    const resolver = recordingResolver();
    const logged = loggedCreateIssue(resolver.calls);
    resolver.setFamilies({ linear: [logged], tracker: [logged] });
    const model = new RecordingChatModel(
      ai(read("r1", LINEAR_PATH)),
      ai(read("r2", skillPath("tracker"))),
      ai(call(CREATE_ISSUE, "c1", { title: "a" })),
      // Seven messages: compaction keeps the second read onward, dropping the first.
      "summary",
      ai(call(CREATE_ISSUE, "c2", { title: "b" })),
    );

    await skillsAgent(model, {
      skillTools: resolver,
      middleware: [compacting(7, 4)],
    }).invoke(skillsInput({ linear: "linear", tracker: "tracker" }));

    expect(ranVia(resolver.calls, "c1")).toBe("linear");
    expect(ranVia(resolver.calls, "c2")).toBe("tracker");
  });

  it("resolves each name once per model call, and only for read skills", async () => {
    const resolver = linearResolver();
    const model = new RecordingChatModel(
      ai(read("r1", LINEAR_PATH), read("r2", skillPath("triage"))),
      ai(call("ls", "l1", { path: "/" })),
    );

    await skillsAgent(model, { skillTools: resolver }).invoke(
      skillsInput({
        linear: "linear",
        triage: "linear notion",
        docs: "confluence",
      }),
    );

    // Two model calls follow the reads; the registered `ls` call resolves nothing.
    expect(resolver.calls).toEqual(["linear", "notion", "linear", "notion"]);
  });

  it("resolves names concurrently", async () => {
    let started = 0;
    let release!: () => void;
    const bothInFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Returns only once both names are in flight, so resolving one at a time times out.
    const rendezvous: SkillToolResolver = async (name) => {
      started += 1;
      if (started === 2) release();
      await Promise.race([
        bothInFlight,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("resolved one at a time")), 1000),
        ),
      ]);
      return name === "linear" ? [listIssues] : [];
    };
    const model = new RecordingChatModel(
      ai(read("r1", LINEAR_PATH), read("r2", skillPath("triage"))),
    );

    await skillsAgent(model, { skillTools: rendezvous }).invoke(
      skillsInput({ linear: "linear", triage: "notion" }),
    );

    expect(boundToolNames(model.calls[1]).at(-1)).toBe(LIST_ISSUES);
  });
});

describe("the gate", () => {
  it("rejects a call in the same turn as the read without resolving it", async () => {
    const resolver = linearResolver();
    const model = new RecordingChatModel(
      ai(read("r1", LINEAR_PATH), call(CREATE_ISSUE, "c1", { title: "early" })),
    );

    const result = await skillsAgent(model, { skillTools: resolver }).invoke(
      skillsInput({ linear: "linear" }),
    );

    const [rejected] = toolMessages(result, CREATE_ISSUE);
    expectInvalidTool(rejected, CREATE_ISSUE);
    expect(rejected.status).toBe("error");
    // Only the model call after the read resolved; the rejected call looked nothing up.
    expect(resolver.calls).toEqual(["linear"]);
  });

  it("rejects a tool the resolver stops returning, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: string[] = [];
    const forgetful: SkillToolResolver = (name) => {
      calls.push(name);
      return calls.length === 1 ? [createIssue] : [];
    };
    const model = new RecordingChatModel(
      ai(read("r1", LINEAR_PATH)),
      ai(call(CREATE_ISSUE, "c1", { title: "x" })),
    );

    const result = await skillsAgent(model, { skillTools: forgetful }).invoke(
      skillsInput({ linear: "linear" }),
    );

    expectInvalidTool(toolMessages(result, CREATE_ISSUE)[0], CREATE_ISSUE);
    expect(warn).toHaveBeenCalledWith(
      `Skill tool '${CREATE_ISSUE}' was disclosed via 'linear', but the resolver no longer returns it`,
    );
  });
});

describe("runtime and errors", () => {
  it("passes the runtime, with context, at model and tool time", async () => {
    const seen: unknown[] = [];
    const perTenant: SkillToolResolver<{ tenant: string }> = (
      _name,
      runtime,
    ) => {
      seen.push(runtime.context);
      return [listIssues];
    };
    const model = new RecordingChatModel(
      ai(read("r1", LINEAR_PATH)),
      ai(call(LIST_ISSUES, "c1")),
    );
    const agent = skillsAgent(model, {
      skillTools: perTenant,
      contextSchema: z.object({ tenant: z.string() }),
    });

    const result = await agent.invoke(skillsInput({ linear: "linear" }), {
      context: { tenant: "acme" },
    });

    expect(toolMessages(result, LIST_ISSUES)[0].content).toBe("no issues");
    // Model call, tool call, model call.
    expect(seen).toEqual([
      { tenant: "acme" },
      { tenant: "acme" },
      { tenant: "acme" },
    ]);
  });

  it("runs a disclosed tool when its step resumes in a fresh agent", async () => {
    const checkpointer = new MemorySaver();
    const config = { configurable: { thread_id: "fresh" } };
    const approval = { [CREATE_ISSUE]: true };
    const first = recordingResolver({ linear: [listIssues, createIssue] });
    const model = new RecordingChatModel(
      ai(read("r1", LINEAR_PATH)),
      ai(call(CREATE_ISSUE, "c1", { title: "x" })),
    );
    const agent = skillsAgent(model, {
      skillTools: first,
      interruptOn: approval,
      checkpointer,
    });

    const paused = await agent.invoke(
      skillsInput({ linear: "notion linear" }),
      config,
    );

    const [interrupt] = (paused as any).__interrupt__;
    expect(interrupt.value.actionRequests[0].name).toBe(CREATE_ISSUE);
    expect(toolMessages(paused, CREATE_ISSUE)).toEqual([]);

    const second = recordingResolver();
    second.setFamilies({
      linear: [listIssues, loggedCreateIssue(second.calls)],
    });
    const rebuilt = skillsAgent(new RecordingChatModel(), {
      skillTools: second,
      interruptOn: approval,
      checkpointer,
    });
    const resumed = await rebuilt.invoke(
      new Command({ resume: { decisions: [{ type: "approve" }] } }),
      config,
    );

    expect(toolMessages(resumed, CREATE_ISSUE)[0].content).toBe("issue x (c1)");
    expect(second.calls.slice(0, 2)).toEqual(["linear", "ran c1"]);
  });

  it("propagates a resolver error at model time", async () => {
    const failing: SkillToolResolver = () => {
      throw new Error("linear is down");
    };
    const agent = skillsAgent(
      new RecordingChatModel(ai(read("r1", LINEAR_PATH))),
      { skillTools: failing },
    );

    await expect(
      agent.invoke(skillsInput({ linear: "linear" })),
    ).rejects.toThrow("linear is down");
  });

  it("propagates a resolver error at tool time", async () => {
    const calls: string[] = [];
    const flaky: SkillToolResolver = async (name) => {
      calls.push(name);
      if (calls.length > 1) throw new Error("linear is down");
      return [createIssue];
    };
    const agent = skillsAgent(
      new RecordingChatModel(
        ai(read("r1", LINEAR_PATH)),
        ai(call(CREATE_ISSUE, "c1", { title: "x" })),
      ),
      { skillTools: flaky },
    );

    await expect(
      agent.invoke(skillsInput({ linear: "linear" })),
    ).rejects.toThrow("linear is down");
    expect(calls).toEqual(["linear", "linear"]);
  });

  it.each<[string, unknown, string]>([
    [
      "a non-tool item",
      [{ name: "x" }],
      "skill tool resolver returned a plain object for 'linear'; expected tool instances",
    ],
    [
      "a bare tool",
      listIssues,
      "skill tool resolver must return an array of tools for 'linear', got DynamicStructuredTool",
    ],
  ])("throws a TypeError for %s", async (_label, output, message) => {
    const agent = skillsAgent(
      new RecordingChatModel(ai(read("r1", LINEAR_PATH))),
      { skillTools: (() => output) as unknown as SkillToolResolver },
    );

    const error = await agent
      .invoke(skillsInput({ linear: "linear" }))
      .catch((e: unknown) => e);

    // Surfaced through the middleware's error wrapper, with the TypeError as its cause.
    let cause = error as { name?: string; message?: string; cause?: unknown };
    while (cause.name !== "TypeError" && cause.cause !== undefined) {
      cause = cause.cause as typeof cause;
    }
    expect(cause.name).toBe("TypeError");
    expect(cause.message).toBe(message);
  });
});

describe("subagents", () => {
  it("gives the general-purpose subagent the parent's resolver", async () => {
    const resolver = linearResolver();
    // Parent and general-purpose subagent share the model, so turns interleave.
    const model = new RecordingChatModel(
      task("general-purpose"),
      ai(read("r1", LINEAR_PATH)),
      ai(call(CREATE_ISSUE, "c1", { title: "x" })),
      new AIMessage("subagent done"),
    );

    await skillsAgent(model, { skillTools: resolver }).invoke(
      skillsInput({ linear: "linear" }),
    );

    expect(model.calls[3].messages.at(-1)?.content).toBe("issue x (c1)");
    expect(resolver.calls).toContain("linear");
  });

  it("resolves a fork's skill tools through the parent's resolver", async () => {
    const resolver = linearResolver();
    const workerModel = new RecordingChatModel(
      ai(call(CREATE_ISSUE, "c1", { title: "x" })),
    );
    const worker: SubAgent = {
      name: "worker",
      description: "Continues.",
      model: workerModel,
      mode: "fork",
    };

    await skillsAgent(
      new RecordingChatModel(ai(read("r1", LINEAR_PATH)), task("worker")),
      { skillTools: resolver, subagents: [worker] },
    ).invoke(skillsInput({ linear: "linear" }));

    expect(boundToolNames(workerModel.calls[0])).toContain(CREATE_ISSUE);
    expect(workerModel.calls[1].messages.at(-1)?.content).toBe("issue x (c1)");
  });

  it("resolves a declarative subagent's skill tools only through its own resolver", async () => {
    const parent = linearResolver();
    const own = recordingResolver({ linear: [listIssues] });
    const workerModel = new RecordingChatModel(
      ai(read("r1", LINEAR_PATH)),
      ai(call(CREATE_ISSUE, "c1", { title: "x" })),
    );
    const worker: SubAgent = {
      name: "worker",
      description: "d",
      model: workerModel,
      skills: [SKILLS_SOURCE],
      middleware: [
        createSkillsMiddleware({
          backend: new StateBackend(),
          sources: [SKILLS_SOURCE],
          tools: own,
        }),
      ],
    };

    await skillsAgent(new RecordingChatModel(task("worker")), {
      skillTools: parent,
      subagents: [worker],
    }).invoke(skillsInput({ linear: "linear" }));

    expect(boundToolNames(workerModel.calls[1]).at(-1)).toBe(LIST_ISSUES);
    expect(boundToolNames(workerModel.calls[1])).not.toContain(CREATE_ISSUE);
    expect(workerModel.calls[2].messages.at(-1)?.content).toContain(
      "is not a valid tool",
    );
    expect(own.calls.length).toBeGreaterThan(0);
    expect(parent.calls).toEqual([]);
  });
});
