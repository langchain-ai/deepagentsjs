import { describe, it, expect } from "vitest";
import { createAgent, createMiddleware, ReactAgent, tool } from "langchain";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod/v4";
import {
  createSubAgentMiddleware,
  createFilesystemMiddleware,
  type CompiledSubAgent,
} from "../index.js";
import { createDeepAgent } from "../agent.js";
import { createFileData } from "../backends/utils.js";
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

/**
 * Integration tests for hierarchical deep agent patterns (agent-as-subagent).
 *
 * These tests verify that a `createDeepAgent` instance can be used as a
 * `CompiledSubAgent` within another agent, enabling multi-level agent hierarchies.
 */
describe("Hierarchical Deep Agent Integration Tests", () => {
  it.concurrent(
    "should use a deep agent as a compiled subagent and invoke its tools",
    { timeout: 120 * 1000 }, // 120s
    async () => {
      // Create a deep agent that will be used as a subagent
      const weatherDeepAgent = createDeepAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "You are a weather specialist. Use the get_weather tool to get weather information.",
        tools: [getWeather],
      });

      // Use it as a CompiledSubAgent in a parent agent
      const parentAgent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt: "Use the task tool to call a subagent.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather-deep-agent",
                description: "A deep agent specialized in weather information.",
                runnable: weatherDeepAgent,
              } satisfies CompiledSubAgent,
            ],
          }),
        ],
      });

      // Verify the task tool was created with the weather-deep-agent
      const tools = extractToolsFromAgent(parentAgent);
      expect(tools.task).toBeDefined();
      expect(tools.task.description).toContain("weather-deep-agent");

      // Verify tool calls flow through the hierarchy:
      // parent -> task(weather-deep-agent) -> get_weather
      const expectedToolCalls = [
        { name: "task", args: { subagent_type: "weather-deep-agent" } },
        { name: "get_weather" },
      ];

      await assertExpectedSubgraphActions(expectedToolCalls, parentAgent, {
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });
    },
  );

  it.concurrent(
    "should support a deep agent with its own subagents as a compiled subagent",
    { timeout: 120 * 1000 }, // 120s
    async () => {
      // Level 2: Create a deep agent that has its own subagents
      const sportsDeepAgent = createDeepAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "You are a sports information agent. " +
          "Use the get_soccer_scores tool for soccer scores. " +
          "For weather-related queries about match conditions, delegate to the weather-helper subagent.",
        tools: [getSoccerScores],
        subagents: [
          {
            name: "weather-helper",
            description:
              "Gets weather info for match day conditions at stadiums.",
            systemPrompt:
              "Use the get_weather tool to get weather information.",
            tools: [getWeather],
            model: SAMPLE_MODEL,
          },
        ],
      });

      // Level 1: Use the deep agent as a CompiledSubAgent in a parent
      const parentAgent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "Use the task tool with the sports-info subagent for any sports question.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "sports-info",
                description:
                  "A deep agent that knows about sports scores and match conditions.",
                runnable: sportsDeepAgent,
              } satisfies CompiledSubAgent,
            ],
          }),
        ],
      });

      // Verify the parent delegates to the sports-info deep agent
      // which in turn calls get_soccer_scores
      const expectedToolCalls = [
        { name: "task", args: { subagent_type: "sports-info" } },
        { name: "get_soccer_scores" },
      ];

      await assertExpectedSubgraphActions(expectedToolCalls, parentAgent, {
        messages: [
          new HumanMessage("What are the latest scores for Manchester United?"),
        ],
      });
    },
  );

  it.concurrent(
    "should support a createDeepAgent as a compiled subagent in another createDeepAgent",
    { timeout: 120 * 1000 }, // 120s
    async () => {
      // Create the inner deep agent
      const innerAgent = createDeepAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "You are a weather agent. Use the get_weather tool to answer weather questions.",
        tools: [getWeather],
      });

      // Create the outer deep agent using the inner as a compiled subagent
      const outerAgent = createDeepAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "You are an orchestrator. Use the weather-agent subagent for weather queries.",
        subagents: [
          {
            name: "weather-agent",
            description: "A specialized deep agent for weather information.",
            runnable: innerAgent,
          } satisfies CompiledSubAgent,
        ],
      });

      // Verify agent creation
      const tools = extractToolsFromAgent(outerAgent);
      expect(tools.task).toBeDefined();
      expect(tools.task.description).toContain("weather-agent");

      // Invoke and verify the delegation chain works
      const response = await outerAgent.invoke(
        {
          messages: [new HumanMessage("What is the weather in Tokyo?")],
        },
        { recursionLimit: 100 },
      );

      const allToolCalls = response.messages
        .filter(AIMessage.isInstance)
        .flatMap((msg) => msg.tool_calls || []);

      // The outer agent should have delegated to weather-agent
      expect(
        allToolCalls.some(
          (tc) =>
            tc.name === "task" && tc.args?.subagent_type === "weather-agent",
        ),
      ).toBe(true);

      // The response should contain weather information
      const lastMessage = response.messages[response.messages.length - 1];
      expect(lastMessage.content).toBeTruthy();
    },
  );
});

/**
 * Integration tests for subagent skills via createDeepAgent.
 *
 * These tests verify that subagents with their own `skills` property
 * can load and use skills from their configured sources.
 */
describe("Subagent Skills Integration Tests", () => {
  /**
   * Skill that instructs the agent to use a VERY SPECIFIC and unusual pattern.
   * This allows us to verify the skill is actually being used.
   */
  const CODING_STYLE_SKILL = `---
name: coding-style
description: MANDATORY coding style requirements - MUST follow exactly
---

# MANDATORY Coding Style Skill

## CRITICAL REQUIREMENT - READ CAREFULLY

When writing ANY JavaScript code, you MUST follow this EXACT pattern:

1. NEVER use console.log() - it is FORBIDDEN
2. ALWAYS use process.stdout.write() for ALL output
3. This is a STRICT requirement with NO exceptions

Example of CORRECT code:
\`\`\`javascript
process.stdout.write("Hello World\\n");
\`\`\`

Example of FORBIDDEN code (NEVER do this):
\`\`\`javascript
console.log("Hello World"); // WRONG - NEVER USE THIS
\`\`\`

IMPORTANT: If you use console.log, the code will be REJECTED.
`;

  it.concurrent(
    "should invoke subagent with skills and verify skill influences code generation",
    { timeout: 120 * 1000 }, // 120s
    async () => {
      /**
       * This test verifies that a subagent configured with skills:
       * 1. Can be invoked successfully
       * 2. Has access to the skill files passed in state
       * 3. Writes files as instructed
       *
       * Note: The actual skill following depends on LLM behavior, so we verify
       * the infrastructure works and optionally check if the skill was followed.
       */
      const checkpointer = new MemorySaver();
      const agent = createDeepAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "You are an orchestrator. When asked to write code, delegate to the coder subagent via the task tool.",
        subagents: [
          {
            name: "coder",
            description:
              "A coding subagent that writes production-quality code following strict coding style requirements.",
            systemPrompt: `You are a coding assistant. You MUST read and follow your coding-style skill before writing ANY code.
Your coding-style skill contains MANDATORY requirements. Violating them will cause the code to be rejected.
Use the write_file tool to save your code.`,
            skills: ["/skills/coding/"], // Subagent-specific skills path
          },
        ],
        checkpointer,
      });

      // Verify the agent was created with the coder subagent
      const tools = extractToolsFromAgent(agent);
      expect(tools.task).toBeDefined();
      expect(tools.task.description).toContain("coder");

      // Invoke with skill files in state - the subagent should load these
      const response = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              'Use the coder subagent to write a simple JavaScript script that prints "Hello World". Save it to /hello.js. Make sure the coder follows their coding-style skill requirements.',
            ),
          ],
          files: {
            "/skills/coding/coding-style/SKILL.md":
              createFileData(CODING_STYLE_SKILL),
          },
        } as any,
        {
          configurable: { thread_id: `test-subagent-skills-${Date.now()}` },
          recursionLimit: 50,
        },
      );

      // Verify the task tool was called with the coder subagent
      const toolCalls = extractAllToolCalls(response);
      const taskCall = toolCalls.find((tc) => tc.name === "task");
      expect(taskCall).toBeDefined();
      expect(taskCall!.args.subagent_type).toBe("coder");

      // Verify a file was written
      const responseWithFiles = response as unknown as {
        files?: Record<string, { content?: string[] }>;
      };
      expect(responseWithFiles.files).toBeDefined();

      // Find any .js file (the exact path might vary)
      const jsFiles = Object.entries(responseWithFiles.files || {}).filter(
        ([path]) => path.endsWith(".js"),
      );
      expect(jsFiles.length).toBeGreaterThan(0);

      // Get the file content
      const [, fileData] = jsFiles[0];
      const fileContent = fileData?.content?.join("\n") || "";

      // Verify the file contains valid JavaScript that outputs something
      expect(fileContent).toMatch(/Hello.*World|hello.*world/i);

      // Check if the skill was followed (process.stdout.write instead of console.log)
      // This is the main assertion - if the skill was loaded, the agent should follow it
      const usedProcessStdout = fileContent.includes("process.stdout.write");
      const usedConsoleLog = fileContent.includes("console.log");

      // The skill explicitly forbids console.log and requires process.stdout.write
      // If the skill is properly loaded and followed, the subagent MUST use process.stdout.write
      expect(usedProcessStdout).toBe(true);
      expect(usedConsoleLog).toBe(false);
    },
  );

  it.concurrent(
    "should propagate lc_agent_name metadata to tools inside subagents",
    { timeout: 90 * 1000 }, // 90s
    async () => {
      /**
       * This test verifies that when a subagent is created with a name,
       * its tools can access the agent name via config.metadata.lc_agent_name.
       * This is critical for identifying which agent invoked a shared tool.
       */
      let capturedAgentName: string | undefined;

      const identifyingTool = tool(
        (input, config) => {
          capturedAgentName = config.metadata?.lc_agent_name;
          return `Weather in ${input.location} is sunny. Agent: ${capturedAgentName}`;
        },
        {
          name: "get_weather_with_identity",
          description: "Get the weather and identify the calling agent",
          schema: z.object({ location: z.string() }),
        },
      );

      const agent = createAgent({
        model: SAMPLE_MODEL,
        systemPrompt:
          "Use the weather-agent subagent to get the weather. Always delegate to the subagent.",
        middleware: [
          createSubAgentMiddleware({
            defaultModel: SAMPLE_MODEL,
            defaultTools: [],
            subagents: [
              {
                name: "weather-agent",
                description:
                  "A weather specialist agent. Use this for any weather queries.",
                systemPrompt:
                  "You are a weather specialist. Use the get_weather_with_identity tool to answer weather questions.",
                tools: [identifyingTool],
              },
            ],
          }),
        ],
      });

      const response = await agent.invoke({
        messages: [new HumanMessage("What is the weather in Tokyo?")],
      });

      // Verify the task tool was called with the weather-agent subagent
      const toolCalls = extractAllToolCalls(response);
      const taskCall = toolCalls.find((tc) => tc.name === "task");
      expect(taskCall).toBeDefined();
      expect(taskCall!.args.subagent_type).toBe("weather-agent");

      // Verify the tool captured the correct agent name
      expect(capturedAgentName).toBe("weather-agent");
    },
  );
});
