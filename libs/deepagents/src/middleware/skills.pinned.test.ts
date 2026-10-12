/**
 * Skill pinning: the skills named in `pinnedSkills`, which the skills
 * middleware appends to the conversation before the next model call.
 *
 * Every test runs a deep agent end to end over skills in a `StoreBackend`, so
 * a test can edit, delete or grow a `SKILL.md` between turns, and observes
 * the messages the model receives and the thread's stored state.
 */

import { describe, it, expect } from "vitest";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { fakeModel } from "@langchain/core/testing";
import { tool } from "@langchain/core/tools";
import { Command, InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { z } from "zod/v4";

import { createDeepAgent } from "../agent.js";
import { StoreBackend } from "../backends/store.js";
import { MAX_SKILL_FILE_SIZE } from "./skills.js";

const NAMESPACE = ["filesystem"];
const SKILLS_SOURCE = "/skills/";

/** Return a `SKILL.md` with frontmatter and `body`. */
function skillMd(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

const CRM = skillMd(
  "crm",
  "Manage customer requests",
  "File the request in the CRM.",
);
const CRM_PINNED =
  '<skill name="crm" path="/skills/crm/SKILL.md">\nFile the request in the CRM.\n</skill>';
const HOUSE_STYLE = skillMd(
  "house-style",
  "Follow house style",
  "Use snake_case.",
);
const HOUSE_STYLE_PINNED =
  '<skill name="house-style" path="/skills/house-style/SKILL.md">\nUse snake_case.\n</skill>';

/** Write `content` as the `SKILL.md` of the skill `name`. */
function putSkill(store: InMemoryStore, name: string, content: string) {
  const now = new Date().toISOString();
  return store.put(NAMESPACE, `/skills/${name}/SKILL.md`, {
    content,
    mimeType: "text/plain",
    created_at: now,
    modified_at: now,
  });
}

/** Return a fake model that plays `turns`, then answers "done" to every later call. */
function scripted(...turns: AIMessage[]) {
  const model = fakeModel();
  for (const turn of turns) model.respond(turn);
  for (let i = 0; i < 10; i += 1) model.respond(() => new AIMessage("done"));
  return model;
}

type AgentOptions = NonNullable<Parameters<typeof createDeepAgent>[0]>;

/**
 * Build a deep agent over `skills`, each a `SKILL.md` keyed by skill name,
 * with a checkpointer. Returns the store and backend, so a test can change a
 * skill or fail its read between turns.
 */
async function pinningAgent(
  skills: Record<string, string>,
  model: ReturnType<typeof fakeModel>,
  options: Partial<AgentOptions> = {},
) {
  const store = new InMemoryStore();
  for (const [name, content] of Object.entries(skills)) {
    await putSkill(store, name, content);
  }
  const backend = new StoreBackend({ store, namespace: NAMESPACE });
  const agent = createDeepAgent({
    model,
    backend,
    skills: [SKILLS_SOURCE],
    store,
    checkpointer: new MemorySaver(),
    ...options,
  });
  return { agent, store, backend };
}

const config = { configurable: { thread_id: "pinning" } };

/** Return the content of every pinned skill message in `messages`. */
function pinnedContents(messages: BaseMessage[]): unknown[] {
  return messages
    .filter((m) => m.additional_kwargs?.lc_source === "pinned_skill")
    .map((m) => m.content);
}

describe("pinned skills", () => {
  it("follow the user's message, one per name in list order", async () => {
    const model = scripted();
    const { agent } = await pinningAgent(
      {
        "write-tests": skillMd(
          "write-tests",
          "Write tests first",
          "Start with a failing test.",
        ),
        "house-style": HOUSE_STYLE,
      },
      model,
    );

    await agent.invoke(
      {
        messages: [new HumanMessage("/write-tests /house-style for auth.py")],
        pinnedSkills: ["write-tests", "house-style"],
      },
      config,
    );

    const [, user, ...skills] = model.calls[0].messages;
    expect([user.type, user.content]).toEqual([
      "human",
      "/write-tests /house-style for auth.py",
    ]);
    expect(skills.map((m) => [m.type, m.content, m.additional_kwargs])).toEqual(
      [
        [
          "human",
          '<skill name="write-tests" path="/skills/write-tests/SKILL.md">\nStart with a failing test.\n</skill>',
          {
            lc_source: "pinned_skill",
            skill: {
              name: "write-tests",
              path: "/skills/write-tests/SKILL.md",
              description: "Write tests first",
            },
          },
        ],
        [
          "human",
          HOUSE_STYLE_PINNED,
          {
            lc_source: "pinned_skill",
            skill: {
              name: "house-style",
              path: "/skills/house-style/SKILL.md",
              description: "Follow house style",
            },
          },
        ],
      ],
    );
  });

  it("are stored once and cleared from the result", async () => {
    const { agent } = await pinningAgent({ crm: CRM }, scripted());

    const result = await agent.invoke(
      { messages: [new HumanMessage("turn 1")], pinnedSkills: ["crm"] },
      config,
    );
    await agent.invoke({ messages: [new HumanMessage("turn 2")] }, config);

    expect(result.pinnedSkills).toEqual([]);
    const state = await agent.graph.getState(config);
    expect(state.values.messages.map((m: BaseMessage) => m.content)).toEqual([
      "turn 1",
      CRM_PINNED,
      "done",
      "turn 2",
      "done",
    ]);
  });

  it("are a snapshot, and pinning again appends the current text", async () => {
    const model = scripted();
    const { agent, store } = await pinningAgent(
      { crm: skillMd("crm", "Manage customer requests", "Version one.") },
      model,
    );
    const v1 =
      '<skill name="crm" path="/skills/crm/SKILL.md">\nVersion one.\n</skill>';
    const v2 =
      '<skill name="crm" path="/skills/crm/SKILL.md">\nVersion two.\n</skill>';

    await agent.invoke(
      { messages: [new HumanMessage("turn 1")], pinnedSkills: ["crm"] },
      config,
    );
    await putSkill(
      store,
      "crm",
      skillMd("crm", "Manage customer requests", "Version two."),
    );
    await agent.invoke({ messages: [new HumanMessage("turn 2")] }, config);
    const turn2 = pinnedContents(model.calls.at(-1)!.messages);
    await agent.invoke(
      { messages: [new HumanMessage("turn 3")], pinnedSkills: ["crm"] },
      config,
    );

    expect(turn2).toEqual([v1]);
    expect(pinnedContents(model.calls.at(-1)!.messages)).toEqual([v1, v2]);
  });

  it("pin a repeated name once", async () => {
    const model = scripted();
    const { agent } = await pinningAgent(
      { crm: CRM, "house-style": HOUSE_STYLE },
      model,
    );

    await agent.invoke(
      {
        messages: [new HumanMessage("go")],
        pinnedSkills: ["crm", "crm", "house-style"],
      },
      config,
    );

    expect(pinnedContents(model.calls[0].messages)).toEqual([
      CRM_PINNED,
      HOUSE_STYLE_PINNED,
    ]);
  });

  it("skip an unknown name, and clear it", async () => {
    const model = scripted();
    const { agent } = await pinningAgent({ crm: CRM }, model);

    await agent.invoke(
      {
        messages: [new HumanMessage("turn 1")],
        pinnedSkills: ["no-such-skill", "crm"],
      },
      config,
    );
    await agent.invoke({ messages: [new HumanMessage("turn 2")] }, config);

    expect(pinnedContents(model.calls[0].messages)).toEqual([CRM_PINNED]);
    expect(pinnedContents(model.calls[1].messages)).toEqual([CRM_PINNED]);
  });

  it("pin nothing when every name is unknown, and clear them", async () => {
    const model = scripted();
    const { agent } = await pinningAgent({ crm: CRM }, model);

    const result = await agent.invoke(
      { messages: [new HumanMessage("go")], pinnedSkills: ["no-such-skill"] },
      config,
    );

    expect(result.messages.at(-1)?.content).toBe("done");
    expect(pinnedContents(model.calls[0].messages)).toEqual([]);
    const state = await agent.graph.getState(config);
    expect(state.values.pinnedSkills).toEqual([]);
  });

  it.each<[string, (store: InMemoryStore) => Promise<unknown>]>([
    ["deleted", (store) => store.delete(NAMESPACE, "/skills/crm/SKILL.md")],
    ["emptied", (store) => putSkill(store, "crm", "")],
    [
      "grown past the size limit",
      (store) => putSkill(store, "crm", CRM + "x".repeat(MAX_SKILL_FILE_SIZE)),
    ],
  ])("skip a skill %s since it was loaded", async (_label, makeUnreadable) => {
    const model = scripted();
    const { agent, store } = await pinningAgent(
      { crm: CRM, "house-style": HOUSE_STYLE },
      model,
    );
    await agent.invoke({ messages: [new HumanMessage("load")] }, config);
    await makeUnreadable(store);

    const result = await agent.invoke(
      {
        messages: [new HumanMessage("go")],
        pinnedSkills: ["crm", "house-style"],
      },
      config,
    );

    expect(result.messages.at(-1)?.content).toBe("done");
    expect(pinnedContents(model.calls.at(-1)!.messages)).toEqual([
      HOUSE_STYLE_PINNED,
    ]);
  });

  it("skip a skill whose read throws, and clear it", async () => {
    const model = scripted();
    const { agent, backend } = await pinningAgent(
      { crm: CRM, "house-style": HOUSE_STYLE },
      model,
    );
    await agent.invoke({ messages: [new HumanMessage("load")] }, config);
    const downloadFiles = backend.downloadFiles.bind(backend);
    backend.downloadFiles = async (paths) => {
      if (paths.includes("/skills/crm/SKILL.md")) throw new Error("offline");
      return downloadFiles(paths);
    };

    const result = await agent.invoke(
      {
        messages: [new HumanMessage("go")],
        pinnedSkills: ["crm", "house-style"],
      },
      config,
    );

    expect(result.messages.at(-1)?.content).toBe("done");
    expect(pinnedContents(model.calls.at(-1)!.messages)).toEqual([
      HOUSE_STYLE_PINNED,
    ]);
    expect(result.pinnedSkills).toEqual([]);
  });

  it("can be pinned by parallel tool calls", async () => {
    const pinSkill = tool(
      async ({ skill }, runtime) =>
        new Command({
          update: {
            pinnedSkills: [skill],
            messages: [
              new ToolMessage({
                content: `pinning ${skill}`,
                tool_call_id: runtime.toolCall!.id!,
              }),
            ],
          },
        }),
      {
        name: "pin_skill",
        description: "Pin a skill.",
        schema: z.object({ skill: z.string() }),
      },
    );
    const model = scripted(
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "pin_skill", id: "a1", args: { skill: "crm" } },
          { name: "pin_skill", id: "a2", args: { skill: "house-style" } },
        ],
      }),
    );
    const { agent } = await pinningAgent(
      { crm: CRM, "house-style": HOUSE_STYLE },
      model,
      { tools: [pinSkill] },
    );

    await agent.invoke({ messages: [new HumanMessage("go")] }, config);

    const [, , , ...rest] = model.calls[1].messages;
    expect(rest.map((m) => m.content)).toEqual([
      "pinning crm",
      "pinning house-style",
      CRM_PINNED,
      HOUSE_STYLE_PINNED,
    ]);
  });

  it("can name a skill published since loading, when reset in the same invoke", async () => {
    const model = scripted();
    const { agent, store } = await pinningAgent({ crm: CRM }, model);
    await agent.invoke({ messages: [new HumanMessage("turn 1")] }, config);
    await putSkill(store, "house-style", HOUSE_STYLE);

    await agent.invoke(
      {
        messages: [new HumanMessage("turn 2")],
        skillsMetadata: null,
        pinnedSkills: ["house-style"],
      },
      config,
    );

    expect(pinnedContents(model.calls[1].messages)).toEqual([
      HOUSE_STYLE_PINNED,
    ]);
  });

  it("pin a name set with updateState once", async () => {
    const model = scripted();
    const { agent } = await pinningAgent({ crm: CRM }, model);
    await agent.invoke({ messages: [new HumanMessage("turn 1")] }, config);

    await agent.updateState(config, { pinnedSkills: ["crm"] });
    await agent.invoke({ messages: [new HumanMessage("turn 2")] }, config);

    expect(pinnedContents(model.calls[1].messages)).toEqual([CRM_PINNED]);
  });

  it("are never pinned in the parent by a subagent's result", async () => {
    const worker = RunnableLambda.from(() => ({
      messages: [new AIMessage("worker done")],
      pinnedSkills: ["crm"],
    }));
    const model = scripted(
      new AIMessage({
        content: "",
        tool_calls: [
          {
            name: "task",
            id: "t1",
            args: { description: "do it", subagent_type: "worker" },
          },
        ],
      }),
    );
    const { agent } = await pinningAgent({ crm: CRM }, model, {
      subagents: [
        { name: "worker", description: "Does work.", runnable: worker },
      ],
    });

    await agent.invoke({ messages: [new HumanMessage("delegate")] }, config);

    expect(model.calls[1].messages.at(-1)?.content).toBe("worker done");
    expect(pinnedContents(model.calls[1].messages)).toEqual([]);
  });
});
