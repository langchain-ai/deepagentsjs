import { describe, it, expectTypeOf } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  MemorySaver,
  StreamTransformer,
  StreamChannel,
} from "@langchain/langgraph";
import { createAgent, tool } from "langchain";
import { z } from "zod/v4";

import { createDeepAgent } from "./agent.js";
import { collectWithTimeout } from "./testing/utils.js";

describe("streamEvents", () => {
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
    const weatherCall = toolCalls.find((tc) => tc.name === "get_weather");
    if (weatherCall && weatherCall.name === "get_weather") {
      expectTypeOf(weatherCall.name).toEqualTypeOf<"get_weather">();
      expectTypeOf(weatherCall.input).toEqualTypeOf<{ city: string }>();
      expectTypeOf(weatherCall.output).toEqualTypeOf<Promise<string>>();
    }
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

    const pongTool = tool(
      async (input: { value: string }) => `pong:${input.value}`,
      {
        name: "pong",
        description: "A simple pong tool",
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
        .respond(new AIMessage("Research findings: AI is growing fast.")),
      tools: [pingTool],
      name: "researcher",
    });

    const coderAgent = createAgent({
      model: fakeModel()
        .respondWithTools([
          { name: "ping", id: "ping-c", args: { value: "from-coder" } },
        ])
        .respond(new AIMessage("Code written: console.log('hello')")),
      tools: [pongTool],
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

    const subagents = await collectWithTimeout(run.subagents);

    for (const sub of subagents) {
      if (sub.name === "researcher") {
        expectTypeOf(sub.name).toEqualTypeOf<"researcher">();
        expectTypeOf(sub.taskInput).toEqualTypeOf<Promise<string>>();

        const tc = await collectWithTimeout(sub.toolCalls);
        const pingCall = tc.find((t) => t.name === "ping");
        if (pingCall && pingCall.name === "ping") {
          expectTypeOf(pingCall.name).toEqualTypeOf<"ping">();
          expectTypeOf(pingCall.input).toEqualTypeOf<{ value: string }>();
        }
      }

      if (sub.name === "coder") {
        expectTypeOf(sub.name).toEqualTypeOf<"coder">();
        expectTypeOf(sub.taskInput).toEqualTypeOf<Promise<string>>();

        const tc = await collectWithTimeout(sub.toolCalls);
        const pongCall = tc.find((t) => t.name === "pong");
        if (pongCall && pongCall.name === "pong") {
          expectTypeOf(pongCall.name).toEqualTypeOf<"pong">();
          expectTypeOf(pongCall.input).toEqualTypeOf<{ value: string }>();
        }
      }
    }
  });

  it("supports custom stream transformers", async () => {
    const transformer: StreamTransformer<{
      foobar: StreamChannel<number>;
    }> = {
      init: () => ({ foobar: StreamChannel.local<number>() }),
      process: () => {
        return true;
      },
    };
    const agent = createDeepAgent({
      model: "openai:gpt-4o",
      checkpointer: new MemorySaver(),
      streamTransformers: [() => transformer],
    });

    const run = await agent.streamEvents(
      { messages: [new HumanMessage("What's the weather in Paris?")] },
      {
        version: "v3",
      },
    );
    for await (const event of run.extensions.foobar) {
      expectTypeOf(event).toEqualTypeOf<number>();
    }
  });
});
