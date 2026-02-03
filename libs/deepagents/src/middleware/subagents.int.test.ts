import { describe, it, expect } from "vitest";
import { createAgent, createMiddleware, ReactAgent } from "langchain";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import {
  createSubAgentMiddleware,
  createFilesystemMiddleware,
} from "../index.js";
import {
  SAMPLE_MODEL,
  getWeather,
  getSoccerScores,
  extractToolsFromAgent,
} from "../testing/utils.js";

const WeatherToolMiddleware = createMiddleware({
  name: "weatherToolMiddleware",
  tools: [getWeather],
});

/**
 * Helper to extract all tool calls from agent response
 */
function extractAllToolCalls(response: {
  messages: BaseMessage[];
}): Array<{ name: string; args: Record<string, unknown>; model?: string }> {
  const messages = response.messages || [];
  const aiMessages = messages.filter(AIMessage.isInstance);
  return aiMessages.flatMap((msg) =>
    (msg.tool_calls || []).map((toolCall) => ({
      name: toolCall.name,
      args: toolCall.args,
      model: msg.response_metadata?.model_name || undefined,
    })),
  );
}

/**
 * Helper to assert expected actions in subgraph
 * This collects all tool calls from the agent execution
 */
async function assertExpectedSubgraphActions(
  expectedToolCalls: Array<{
    name: string;
    args?: Record<string, any>;
    model?: string;
  }>,
  agent: ReactAgent,
  input: any,
) {
  const actualToolCalls: Array<{
    name: string;
    args: Record<string, any>;
    model?: string;
  }> = [];

  for await (const chunk of await agent.graph.stream(input, {
    streamMode: ["updates"],
    subgraphs: true,
  })) {
    const update = chunk[2] ?? {};

    if (!("model_request" in update)) continue;
    const messages = update.model_request.messages as BaseMessage[];

    const lastAiMessage = messages.filter(AIMessage.isInstance).at(-1);

    if (!lastAiMessage) continue;

    actualToolCalls.push(
      ...(lastAiMessage.tool_calls ?? []).map((toolCall) => ({
        name: toolCall.name,
        args: toolCall.args,
        model: lastAiMessage.response_metadata?.model_name || undefined,
      })),
    );
  }

  expect(actualToolCalls).toMatchObject(expectedToolCalls);
}

describe("Subagent Middleware Integration Tests", () => {
  it.concurrent(
    "should invoke general-purpose subagent",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "Use the general-purpose subagent to get the weather in a city.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [getWeather] as any,
          }),
        ],
      });

      // Check that task tool is available
      const tools = extractToolsFromAgent(agent);
      expect(tools.task).toBeDefined();

      const response = await agent.invoke({
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });

      const toolCalls = extractAllToolCalls(response);
      const taskCall = toolCalls.find((tc) => tc.name === "task");

      expect(taskCall).toBeDefined();
      expect(taskCall!.args.subagent_type).toBe("general-purpose");
    },
  );

  it.concurrent(
    "should invoke defined subagent",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call a subagent.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather",
                description: "This subagent can get weather in cities.",
                systemPrompt:
                  "Use the get_weather tool to get the weather in a city.",
                tools: [getWeather],
              },
            ],
          }),
        ],
      });

      // Check that task tool is available
      const tools = extractToolsFromAgent(agent);
      expect(tools.task).toBeDefined();

      const response = await agent.invoke({
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });

      const toolCalls = extractAllToolCalls(response);
      const taskCall = toolCalls.find((tc) => tc.name === "task");

      expect(taskCall).toBeDefined();
      expect(taskCall!.args.subagent_type).toBe("weather");
    },
  );

  it.concurrent(
    "should make tool calls within subagent",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call a subagent.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather",
                description: "This subagent can get weather in cities.",
                systemPrompt:
                  "Use the get_weather tool to get the weather in a city.",
                tools: [getWeather],
              },
            ],
          }),
        ],
      });

      const expectedToolCalls = [
        { name: "task", args: { subagent_type: "weather" } },
        { name: "get_weather" },
      ];

      await assertExpectedSubgraphActions(expectedToolCalls, agent, {
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });
    },
  );

  it.concurrent(
    "should use custom model in subagent",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call a subagent.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather",
                description: "This subagent can get weather in cities.",
                systemPrompt:
                  "Use the get_weather tool to get the weather in a city.",
                tools: [getWeather],
                model: "gpt-4.1", // Custom model for subagent
              },
            ],
          }),
        ],
      });

      const expectedToolCalls = [
        { name: "task", args: { subagent_type: "weather" } },
        { name: "get_weather" },
      ];

      await assertExpectedSubgraphActions(expectedToolCalls, agent, {
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });
    },
  );

  it.concurrent(
    "should use custom middleware in subagent",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call a subagent.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather",
                description: "This subagent can get weather in cities.",
                systemPrompt:
                  "Use the get_weather tool to get the weather in a city.",
                tools: [], // No tools directly, only via middleware
                model: "gpt-4.1",
                middleware: [WeatherToolMiddleware],
              },
            ],
          }),
        ],
      });

      const expectedToolCalls = [
        { name: "task", args: { subagent_type: "weather" } },
        { name: "get_weather" },
      ];

      await assertExpectedSubgraphActions(expectedToolCalls, agent, {
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });
    },
  );

  it.concurrent(
    "should use pre-compiled subagent",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const customSubagent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the get_weather tool to get the weather in a city.",
        tools: [getWeather],
      });

      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call a subagent.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather",
                description: "This subagent can get weather in cities.",
                runnable: customSubagent,
              },
            ],
          }),
        ],
      });

      const expectedToolCalls = [
        { name: "task", args: { subagent_type: "weather" } },
        { name: "get_weather" },
      ];

      await assertExpectedSubgraphActions(expectedToolCalls, agent, {
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });
    },
  );

  it.concurrent(
    "should handle multiple subagents without middleware accumulation",
    { timeout: 120000 },
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call subagents.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather",
                description: "Get weather information",
                systemPrompt: "Use get_weather tool",
                tools: [getWeather],
              },
              {
                name: "soccer",
                description: "Get soccer scores",
                systemPrompt: "Use get_soccer_scores tool",
                tools: [getSoccerScores],
              },
            ],
          }),
        ],
      });

      // Verify both subagents work independently
      const response1 = await agent.invoke({
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });

      const toolCalls1 = extractAllToolCalls(response1);
      const taskCall1 = toolCalls1.find((tc) => tc.name === "task");
      expect(taskCall1?.args.subagent_type).toBe("weather");

      const response2 = await agent.invoke({
        messages: [
          new HumanMessage("What are the latest scores for Manchester United?"),
        ],
      });

      const toolCalls2 = extractAllToolCalls(response2);
      const taskCall2 = toolCalls2.find((tc) => tc.name === "task");
      expect(taskCall2?.args.subagent_type).toBe("soccer");
    },
  );

  it.concurrent(
    "should initialize subagent middleware with default settings",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const middleware = createSubAgentMiddleware({
        defaultModel: SAMPLE_MODEL,
        defaultTools: [],
        subagents: [],
      });

      expect(middleware).toBeDefined();
      expect(middleware.name).toBe("subAgentMiddleware");
      expect(middleware.tools).toBeDefined();
      expect(middleware.tools).toHaveLength(1);
      expect(middleware.tools![0].name).toBe("task");

      const agent = createAgent({
        model: SAMPLE_MODEL,
        middleware: [middleware],
      });

      const tools = extractToolsFromAgent(agent);
      expect(tools.task).toBeDefined();
      expect(tools.task.description).toContain("general-purpose");
    },
  );

  it.concurrent(
    "should initialize general-purpose subagent with default tools",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the general-purpose subagent to call tools.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [getWeather, getSoccerScores],
          }),
        ],
      });

      const response = await agent.invoke({
        messages: [
          new HumanMessage(
            "Use the general-purpose subagent to get the weather in Tokyo",
          ),
        ],
      });

      const toolCalls = extractAllToolCalls(response);
      const taskCall = toolCalls.find((tc) => tc.name === "task");

      expect(taskCall).toBeDefined();
      expect(taskCall!.args.subagent_type).toBe("general-purpose");
    },
  );

  it.concurrent(
    "should use custom system prompt in general-purpose subagent",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      const customPrompt =
        "You are a specialized assistant. In every response, you must include the word 'specialized'.";

      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "Use the general-purpose subagent to answer the user's question.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            systemPrompt: customPrompt,
          }),
        ],
      });

      const response = await agent.invoke({
        messages: [
          new HumanMessage(
            "Use the general-purpose subagent to tell me about your capabilities",
          ),
        ],
      });

      const toolCalls = extractAllToolCalls(response);
      const taskCall = toolCalls.find((tc) => tc.name === "task");
      expect(taskCall).toBeDefined();
      expect(taskCall!.args.subagent_type).toBe("general-purpose");
      expect(response.messages.length).toBeGreaterThan(0);
    },
  );

  it.concurrent(
    "should handle parallel subagents writing files simultaneously without LastValue errors",
    { timeout: 120 * 1000 }, // 120s
    async () => {
      // This test verifies the fix for the LangGraph LastValue error:
      // "Invalid update for channel 'files' with values [...]:
      // LastValue can only receive one value per step."
      //
      // When multiple subagents run in parallel and each writes files,
      // the fileDataReducer should properly merge their updates.

      // Create filesystem middleware that all subagents will use
      const filesystemMiddleware = createFilesystemMiddleware({});

      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: `You are an assistant that delegates file writing tasks to subagents.
When asked to write multiple files, you MUST use the task tool to spawn multiple subagents IN PARALLEL (in a single response with multiple tool calls).
Each subagent should write ONE file. Do NOT write files sequentially - spawn all subagents at once.`,
        middleware: [
          filesystemMiddleware,
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            defaultMiddleware: [filesystemMiddleware],
            subagents: [
              {
                name: "file-writer-1",
                description:
                  "Writes content to file1.txt. Use this to write the first file.",
                systemPrompt:
                  "You are a file writer. When asked to write content, use the write_file tool to write to /file1.txt. Write the exact content requested.",
              },
              {
                name: "file-writer-2",
                description:
                  "Writes content to file2.txt. Use this to write the second file.",
                systemPrompt:
                  "You are a file writer. When asked to write content, use the write_file tool to write to /file2.txt. Write the exact content requested.",
              },
              {
                name: "file-writer-3",
                description:
                  "Writes content to file3.txt. Use this to write the third file.",
                systemPrompt:
                  "You are a file writer. When asked to write content, use the write_file tool to write to /file3.txt. Write the exact content requested.",
              },
            ],
          }),
        ],
      });

      // Request parallel file writes
      const response = await agent.invoke({
        messages: [
          new HumanMessage(
            'Write three files in parallel: file1.txt should contain "Content for file 1", file2.txt should contain "Content for file 2", and file3.txt should contain "Content for file 3". Use all three file-writer subagents simultaneously.',
          ),
        ],
      });

      // Extract all tool calls to verify subagents were invoked
      const toolCalls = extractAllToolCalls(response);
      const taskCalls = toolCalls.filter((tc) => tc.name === "task");

      // Verify multiple subagents were invoked (at least 2 for parallel execution)
      expect(taskCalls.length).toBeGreaterThanOrEqual(2);

      // Verify different subagents were used
      const subagentTypes = new Set(
        taskCalls.map((tc) => tc.args.subagent_type),
      );
      expect(subagentTypes.size).toBeGreaterThanOrEqual(2);

      // Verify the files state was properly merged (no LastValue error occurred)
      // If the reducer wasn't working, the agent.invoke would have thrown:
      // "Invalid update for channel 'files' with values [...]: LastValue can only receive one value per step."
      const responseWithFiles = response as unknown as {
        files?: Record<string, unknown>;
      };
      expect(responseWithFiles.files).toBeDefined();

      // The files state should contain entries from the parallel writes
      // (The exact content depends on which subagents successfully wrote)
      const filesCount = Object.keys(responseWithFiles.files || {}).length;
      expect(filesCount).toBeGreaterThanOrEqual(0); // At minimum, no error occurred
    },
  );
});
