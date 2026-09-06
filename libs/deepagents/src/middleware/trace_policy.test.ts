import { describe, expect, it } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { BaseTracer, type Run } from "@langchain/core/tracers/base";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { createAgent, createMiddleware, tool } from "langchain";
import { z } from "zod/v4";

import { createDeepAgent } from "../agent.js";
import { createFileData } from "../backends/utils.js";
import { createFilesystemMiddleware } from "./fs.js";
import { createPatchToolCallsMiddleware } from "./patch_tool_calls.js";

class RecordingTracer extends BaseTracer {
  name = "recording_tracer";
  roots: Run[] = [];

  protected async persistRun(run: Run): Promise<void> {
    this.roots.push(run);
  }

  get runs(): Run[] {
    const flatten = (run: Run): Run[] => [
      run,
      ...run.child_runs.flatMap(flatten),
    ];
    return this.roots.flatMap(flatten);
  }
}

const LARGE_MESSAGE = "Conversation context. ".repeat(2048);
const LIFECYCLE_NAMES = [
  "FilesystemMiddleware.before_agent",
  "patchToolCallsMiddleware.before_agent",
  "MemoryMiddleware.before_agent",
  "SkillsMiddleware.before_agent",
];

describe("middleware trace inputs", () => {
  it("omits built-in state payloads while retaining user middleware and model/tool traces", async () => {
    const tracer = new RecordingTracer();
    const userMiddleware = createMiddleware({
      name: "UserMiddleware",
      beforeModel: () => undefined,
    });
    const echo = tool(({ text }) => text, {
      name: "echo",
      description: "Echo text",
      schema: z.object({ text: z.string() }),
    });
    const model = fakeModel()
      .respondWithTools([
        { id: "echo-call", name: "echo", args: { text: "tool result" } },
      ])
      .respond(new AIMessage("Done"));
    const agent = createDeepAgent({
      model,
      tools: [echo],
      memory: ["/AGENTS.md"],
      skills: ["/skills/"],
      middleware: [userMiddleware],
    });
    const result = await agent.invoke(
      {
        messages: [new HumanMessage(LARGE_MESSAGE)],
        files: {
          "/AGENTS.md": createFileData("Remember the project conventions."),
          "/large.txt": createFileData(LARGE_MESSAGE),
          "/skills/example/SKILL.md": createFileData(
            "---\nname: example\ndescription: Example skill\n---\nFollow these instructions.",
          ),
        },
      },
      { callbacks: [tracer] },
    );

    expect(result.messages[0].content).toBe(LARGE_MESSAGE);
    expect(result.messages.at(-1)?.content).toBe("Done");
    expect(result.messages.find(ToolMessage.isInstance)?.content).toBe(
      "tool result",
    );
    for (const name of LIFECYCLE_NAMES) {
      const runs = tracer.runs.filter((run) => run.name === name);
      expect(runs.length, name).toBeGreaterThan(0);
      for (const run of runs) {
        expect(Object.keys(run.inputs), name).toEqual([]);
        expect(run.end_time).toBeDefined();
        expect(run.parent_run_id).toBeDefined();
      }
    }
    const userRun = tracer.runs.find(
      (run) => run.name === "UserMiddleware.before_model",
    );
    expect(JSON.stringify(userRun?.inputs)).toContain(LARGE_MESSAGE);
    const modelRuns = tracer.runs.filter((run) => run.run_type === "llm");
    expect(modelRuns.length).toBeGreaterThan(0);
    expect(JSON.stringify(modelRuns[0].inputs)).toContain(LARGE_MESSAGE);
    expect(modelRuns[0].parent_run_id).toBeDefined();
    const toolRun = tracer.runs.find(
      (run) => run.name === "echo" && run.run_type === "tool",
    );
    expect(JSON.stringify(toolRun?.inputs)).toContain("tool result");
    expect(JSON.stringify(toolRun?.outputs)).toContain("tool result");
    expect(toolRun?.parent_run_id).toBeDefined();
  });

  it("preserves explicit policies on replacement middleware", async () => {
    const replacement = {
      ...createFilesystemMiddleware(),
      tracePolicy: { processInputs: () => ({ recorded: "custom" }) },
    };
    const tracer = new RecordingTracer();
    await createDeepAgent({
      model: fakeModel().respond(new AIMessage("Done")),
      middleware: [replacement],
    }).invoke(
      { messages: [new HumanMessage("Hello")] },
      { callbacks: [tracer] },
    );

    expect(
      tracer.runs.find(
        (run) => run.name === "FilesystemMiddleware.before_agent",
      )?.inputs,
    ).toEqual({ recorded: "custom" });
    expect(
      tracer.runs.find(
        (run) => run.name === "patchToolCallsMiddleware.before_agent",
      )?.inputs,
    ).toEqual({});
  });

  it("keeps repaired messages in lifecycle outputs and streaming events", async () => {
    const agent = createAgent({
      model: new FakeStreamingChatModel({ responses: [new AIMessage("Done")] }),
      middleware: [createPatchToolCallsMiddleware()],
    });
    const events = [];
    for await (const event of agent.streamEvents(
      {
        messages: [
          new HumanMessage("Hello"),
          new AIMessage({
            content: "",
            tool_calls: [{ id: "unanswered", name: "echo", args: {} }],
          }),
        ],
      },
      { version: "v2" },
    )) {
      events.push(event);
    }

    const start = events.find(
      (event) =>
        event.name === "patchToolCallsMiddleware.before_agent" &&
        event.event === "on_chain_start",
    );
    const end = events.find(
      (event) =>
        event.name === "patchToolCallsMiddleware.before_agent" &&
        event.event === "on_chain_end",
    );
    expect(start?.data.input).toEqual({});
    expect(JSON.stringify(end?.data.output)).toContain("unanswered");
    expect(events.some((event) => event.event === "on_chat_model_stream")).toBe(
      true,
    );
  });

  it.each(["fresh", "fork"] as const)(
    "applies defaults inside %s subagents",
    async (mode) => {
      const tracer = new RecordingTracer();
      const model = fakeModel()
        .respondWithTools([
          {
            id: "delegate",
            name: "task",
            args: { description: "Complete the task", subagent_type: "worker" },
          },
        ])
        .respond(new AIMessage("Parent done"));
      const agent = createDeepAgent({
        model,
        subagents: [
          {
            name: "worker",
            description: "Worker",
            model: fakeModel().respond(new AIMessage("Worker done")),
            ...(mode === "fork" ? { mode: "fork" as const } : {}),
          },
        ],
      });
      const result = await agent.invoke(
        { messages: [new HumanMessage("Delegate this task")] },
        { callbacks: [tracer] },
      );

      expect(result.messages.at(-1)?.content).toBe("Parent done");
      expect(result.messages.find(ToolMessage.isInstance)?.content).toContain(
        "Worker done",
      );
      for (const name of LIFECYCLE_NAMES.slice(0, 2)) {
        const runs = tracer.runs.filter((run) => run.name === name);
        expect(runs.length, name).toBeGreaterThanOrEqual(2);
        expect(
          runs.every((run) => Object.keys(run.inputs).length === 0),
          name,
        ).toBe(true);
      }
      if (mode === "fork") {
        expect(
          tracer.runs.find(
            (run) => run.name === "forkTaskToolMiddleware.before_agent",
          )?.inputs,
        ).toEqual({});
      }
    },
  );
});
