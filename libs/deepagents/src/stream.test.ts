import { describe, it, expect } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, tool } from "langchain";
import { z } from "zod/v4";

import type { SubagentRunStream } from "./stream.js";
import { createDeepAgent } from "./agent.js";
import { collectWithTimeout } from "./testing/utils.js";

describe("streamEvents", () => {
  it("returns a DeepAgentRunStream with native subagents getter", async () => {
    const model = fakeModel().respond(new AIMessage("Hello!"));
    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("Hi")] },
      {
        version: "v3",
        configurable: { thread_id: `test-instance-${Date.now()}` },
      },
    );

    expect(run.subagents).toBeDefined();
    expect(run.toolCalls).toBeDefined();
    expect(run.messages).toBeDefined();
  });

  it("resolves output with final agent state", async () => {
    const model = fakeModel().respond(new AIMessage("The answer is 42."));
    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("What is the answer?")] },
      {
        version: "v3",
        configurable: { thread_id: `test-output-${Date.now()}` },
      },
    );

    const state = await run.output;
    expect(state).toBeDefined();
    expect(Array.isArray(state.messages)).toBe(true);
    expect(state.messages.length).toBeGreaterThanOrEqual(2);

    const lastMessage = state.messages[state.messages.length - 1];
    expect(lastMessage.content).toContain("The answer is 42.");
  });

  it("streams messages from the model", async () => {
    const model = fakeModel().respond(
      new AIMessage("Streaming works perfectly."),
    );
    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("Stream test")] },
      {
        version: "v3",
        configurable: { thread_id: `test-messages-${Date.now()}` },
      },
    );

    const messages = await collectWithTimeout(run.messages);
    expect(messages.length).toBeGreaterThanOrEqual(1);

    const fullText = await messages[0].text;
    expect(fullText).toContain("Streaming works perfectly.");
  });

  it("streams tool calls with typed input from a custom tool", async () => {
    const weatherTool = tool(
      async (input: { city: string }) => `Sunny in ${input.city}`,
      {
        name: "get_weather",
        description: "Get the weather for a city",
        schema: z.object({ city: z.string() }),
      },
    );

    const model = fakeModel()
      .respondWithTools([
        { name: "get_weather", id: "weather-1", args: { city: "Paris" } },
      ])
      .respond(new AIMessage("The weather in Paris is sunny."));

    const agent = createDeepAgent({
      model,
      tools: [weatherTool],
      checkpointer: new MemorySaver(),
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("What's the weather in Paris?")] },
      {
        version: "v3",
        configurable: { thread_id: `test-tool-calls-${Date.now()}` },
        recursionLimit: 50,
      },
    );

    const toolCalls = await collectWithTimeout(run.toolCalls);
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);

    const weatherCall = toolCalls.find((tc) => tc.name === "get_weather");
    expect(weatherCall).toBeDefined();

    // Discriminated union narrowing by name gives typed input/output
    if (weatherCall && weatherCall.name === "get_weather") {
      expect(weatherCall.callId).toBe("weather-1");
      expect(weatherCall.input).toEqual({ city: "Paris" });
      await expect(weatherCall.output).resolves.toBe("Sunny in Paris");
    }
  });

  it("run.subagents terminates empty when no subagent is spawned", async () => {
    const model = fakeModel().respond(
      new AIMessage("I can handle this directly."),
    );

    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("Simple question")] },
      {
        version: "v3",
        configurable: { thread_id: `test-no-subagents-${Date.now()}` },
      },
    );

    const subagents: SubagentRunStream[] = [];
    const subagentsPromise = (async () => {
      for await (const sub of run.subagents) {
        subagents.push(sub);
      }
    })();

    await run.output;
    await subagentsPromise;

    expect(subagents).toHaveLength(0);
  });

  it("run.subagents yields streams when the model spawns two subagents with tool calls", async () => {
    const pingTool = tool(
      async (input: { value: string }) => `pong:${input.value}`,
      {
        name: "ping",
        description: "A simple ping tool",
        schema: z.object({ value: z.string() }),
      },
    );

    const rootModel = fakeModel()
      .respondWithTools([
        {
          name: "task",
          id: "task-researcher",
          args: {
            description: "Research AI trends",
            subagent_type: "researcher",
          },
        },
        {
          name: "task",
          id: "task-coder",
          args: {
            description: "Write a hello world",
            subagent_type: "coder",
          },
        },
      ])
      .respond(new AIMessage("All subagents completed"));

    const researcherAgent = createAgent({
      model: fakeModel()
        .respondWithTools([
          { name: "ping", id: "ping-r", args: { value: "from-researcher" } },
        ])
        .respond(new AIMessage("pong:from-researcher")),
      tools: [pingTool],
      name: "researcher",
    });

    const coderAgent = createAgent({
      model: fakeModel()
        .respondWithTools([
          { name: "ping", id: "ping-c", args: { value: "from-coder" } },
        ])
        .respond(new AIMessage("pong:from-coder")),
      tools: [pingTool],
      name: "coder",
    });

    const agent = createDeepAgent({
      model: rootModel,
      checkpointer: new MemorySaver(),
      subagents: [
        {
          name: "researcher",
          description: "Research agent",
          runnable: researcherAgent,
        },
        {
          name: "coder",
          description: "Coding agent",
          runnable: coderAgent,
        },
      ],
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("Do both tasks")] },
      {
        version: "v3",
        configurable: { thread_id: `test-two-subagents-${Date.now()}` },
        recursionLimit: 100,
      },
    );

    // Collect root tool calls concurrently; iterating `run.subagents` below
    // drives the underlying stream to completion.
    const rootToolCallsPromise = collectWithTimeout(run.toolCalls);

    // Consume each subagent's tool-call stream inline while the run is live —
    // the per-subagent streams are not replayable once the run ends.
    //
    // NOTE: We intentionally do not assert on `sub.messages` here. When two or
    // more subagents are spawned in a single turn they execute in parallel, and
    // their (callback-based) `messages` events can be emitted after the root
    // stream has already closed, so they are dropped before reaching
    // `sub.messages`. This is a streaming limitation in the underlying
    // `@langchain/langgraph` build, not in deep agents. Per-subagent message
    // streaming is covered by the single-subagent test below, which mirrors the
    // langchain reference (`transformers/tests/subagent.test.ts`).
    const subagentNames: string[] = [];
    for await (const sub of run.subagents) {
      subagentNames.push(sub.name);

      if (sub.name === "researcher") {
        expect(sub.cause).toEqual({
          type: "toolCall",
          tool_call_id: "task-researcher",
        });

        const tc = await collectWithTimeout(sub.toolCalls);
        expect(tc.length).toBeGreaterThanOrEqual(1);
        const pingCall = tc.find((t) => t.name === "ping");
        expect(pingCall).toBeDefined();
        if (pingCall && pingCall.name === "ping") {
          expect(pingCall.input).toEqual({ value: "from-researcher" });
          await expect(pingCall.status).resolves.toBe("finished");
          await expect(pingCall.error).resolves.toBeUndefined();
          await expect(pingCall.output).resolves.toBe("pong:from-researcher");
        }
      }

      if (sub.name === "coder") {
        expect(sub.cause).toEqual({
          type: "toolCall",
          tool_call_id: "task-coder",
        });

        const tc = await collectWithTimeout(sub.toolCalls);
        expect(tc.length).toBeGreaterThanOrEqual(1);
        const pingCall = tc.find((t) => t.name === "ping");
        expect(pingCall).toBeDefined();
        if (pingCall && pingCall.name === "ping") {
          expect(pingCall.input).toEqual({ value: "from-coder" });
          await expect(pingCall.status).resolves.toBe("finished");
          await expect(pingCall.error).resolves.toBeUndefined();
          await expect(pingCall.output).resolves.toBe("pong:from-coder");
        }
      }
    }

    const state = await run.output;
    const rootToolCalls = await rootToolCallsPromise;

    expect(state.messages.length).toBeGreaterThanOrEqual(2);

    // Root stream should see task calls but NOT ping calls from subagents
    const rootTaskCalls = rootToolCalls.filter((tc) => tc.name === "task");
    expect(rootTaskCalls).toHaveLength(2);

    // Both subagents should have surfaced with their declared names
    expect(subagentNames.length).toBeGreaterThanOrEqual(2);
    expect(subagentNames).toContain("researcher");
    expect(subagentNames).toContain("coder");
  });

  it("run.subagents streams a single subagent's messages", async () => {
    const pingTool = tool(
      async (input: { value: string }) => `pong:${input.value}`,
      {
        name: "ping",
        description: "A simple ping tool",
        schema: z.object({ value: z.string() }),
      },
    );

    const rootModel = fakeModel()
      .respondWithTools([
        {
          name: "task",
          id: "task-researcher",
          args: {
            description: "Research AI trends",
            subagent_type: "researcher",
          },
        },
      ])
      .respond(new AIMessage("Subagent completed"));

    const researcherAgent = createAgent({
      model: fakeModel()
        .respondWithTools([
          { name: "ping", id: "ping-r", args: { value: "from-researcher" } },
        ])
        .respond(new AIMessage("pong:from-researcher")),
      tools: [pingTool],
      name: "researcher",
    });

    const agent = createDeepAgent({
      model: rootModel,
      checkpointer: new MemorySaver(),
      subagents: [
        {
          name: "researcher",
          description: "Research agent",
          runnable: researcherAgent,
        },
      ],
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("Do the task")] },
      {
        version: "v3",
        configurable: { thread_id: `test-single-subagent-${Date.now()}` },
        recursionLimit: 100,
      },
    );

    // Consume the subagent's messages inline while the run is live — the
    // per-subagent `messages` stream is not replayable once the run ends.
    const subagentNames: string[] = [];
    for await (const sub of run.subagents) {
      subagentNames.push(sub.name);
      expect(sub.name).toBe("researcher");

      const msgs = await collectWithTimeout(sub.messages);
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      const texts = await Promise.all(msgs.map((m) => m.text));
      expect(texts).toContain("pong:from-researcher");
    }

    await run.output;
    expect(subagentNames).toEqual(["researcher"]);
  });

  it("can iterate raw protocol events", async () => {
    const model = fakeModel().respond(new AIMessage("Hello world."));
    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("Say hello")] },
      {
        version: "v3",
        configurable: { thread_id: `test-raw-events-${Date.now()}` },
      },
    );

    const events = await collectWithTimeout(run);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.type).toBe("event");
      expect(event.method).toBeDefined();
      expect(event.params).toBeDefined();
      expect(event.params.namespace).toBeDefined();
    }
  });

  it("exposes values as state snapshots", async () => {
    const model = fakeModel().respond(new AIMessage("Done."));
    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("values test")] },
      {
        version: "v3",
        configurable: { thread_id: `test-values-${Date.now()}` },
      },
    );

    const finalValues = await run.values;
    expect(finalValues).toBeDefined();
    expect(finalValues.messages).toBeDefined();
  });

  it("path is empty for root stream", async () => {
    const model = fakeModel().respond(new AIMessage("Test."));
    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("path test")] },
      { version: "v3", configurable: { thread_id: `test-path-${Date.now()}` } },
    );

    expect(run.path).toEqual([]);
    await run.output;
  });

  it("interrupted is false for normal completion", async () => {
    const model = fakeModel().respond(new AIMessage("Normal end."));
    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("interrupt test")] },
      {
        version: "v3",
        configurable: { thread_id: `test-interrupted-${Date.now()}` },
      },
    );

    await run.output;
    expect(run.interrupted).toBe(false);
    expect(run.interrupts).toEqual([]);
  });

  it("exposes an AbortSignal on the stream", async () => {
    const model = fakeModel().respond(new AIMessage("Signal test."));
    const agent = createDeepAgent({
      model,
      checkpointer: new MemorySaver(),
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("signal test")] },
      {
        version: "v3",
        configurable: { thread_id: `test-signal-${Date.now()}` },
      },
    );

    expect(run.signal).toBeInstanceOf(AbortSignal);
    expect(run.signal.aborted).toBe(false);
    await run.output;
  });
});
