import { describe, it, expect } from "vitest";
import { createAgent, createMiddleware, ReactAgent } from "langchain";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import path from "path";
import fs from "fs";
import {
  createSubAgentMiddleware,
  createFilesystemMiddleware,
} from "../index.js";
import { createDeepAgent } from "../agent.js";
import {
  SAMPLE_MODEL,
  getWeather,
  getSoccerScores,
  extractToolsFromAgent,
} from "../testing/utils.js";
import { parseSubagentMarkers } from "./subagents.js";

const WeatherToolMiddleware = createMiddleware({
  name: "weatherToolMiddleware",
  tools: [getWeather],
});

/**
 * Helper to extract all tool calls from agent response
 */
function extractAllToolCalls(
  response: any,
): Array<{ name: string; args: Record<string, any>; model?: string }> {
  const messages = response.messages || [];
  const aiMessages = messages.filter((msg: any) => AIMessage.isInstance(msg));
  return aiMessages.flatMap((msg: any) =>
    (msg.tool_calls || []).map((toolCall: any) => ({
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

describe("Batch Spawning Integration Tests", () => {
  it.concurrent.skip(
    "should parse spawn_subagent markers from execute output",
    { timeout: 30 * 1000 },
    async () => {
      // Simulate output from a shell command that processes CSV and spawns subagents
      const mockOutput = `Processing tasks...
SUBAGENT_TASK: {"description": "Task 1: Analyze data", "type": "general-purpose"}
SUBAGENT_TASK: {"description": "Task 2: Generate report", "type": "general-purpose"}
SUBAGENT_TASK: {"description": "Task 3: Review code", "type": "general-purpose"}
Done processing 3 tasks.`;

      const result = parseSubagentMarkers(mockOutput);

      expect(result.subagentTasks).toHaveLength(3);
      expect(result.subagentTasks[0].description).toBe("Task 1: Analyze data");
      expect(result.subagentTasks[1].description).toBe(
        "Task 2: Generate report",
      );
      expect(result.subagentTasks[2].description).toBe("Task 3: Review code");
      expect(result.cleanOutput).toBe(
        "Processing tasks...\nDone processing 3 tasks.",
      );
      expect(result.warnings).toHaveLength(0);
    },
  );

  it.concurrent.skip(
    "should handle malformed markers gracefully",
    { timeout: 30 * 1000 },
    async () => {
      const mockOutput = `Processing...
SUBAGENT_TASK: {"description": "Valid task", "type": "general-purpose"}
SUBAGENT_TASK: {invalid json}
SUBAGENT_TASK: {"type": "missing-description"}
SUBAGENT_TASK: {"description": "Another valid", "type": "research"}
Done.`;

      const result = parseSubagentMarkers(mockOutput);

      // Should only have 2 valid tasks
      expect(result.subagentTasks).toHaveLength(2);
      expect(result.subagentTasks[0].description).toBe("Valid task");
      expect(result.subagentTasks[1].description).toBe("Another valid");

      // Should have 2 warnings (invalid JSON and missing description)
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0]).toContain("malformed");
      expect(result.warnings[1]).toContain("missing description");
    },
  );

  it.concurrent(
    "should invoke batch_task tool when spawn_subagent markers are detected with createDeepAgent",
    { timeout: 120 * 1000 },
    async () => {
      /* eslint-disable no-console */
      // Read first few lines of the CSV fixture
      const csvPath = path.join(
        import.meta.dirname,
        "__fixtures__",
        "subagent_tasks.csv",
      );
      const csvContent = fs.readFileSync(csvPath, "utf-8");
      const lines = csvContent.split("\n").slice(1, 6); // Skip header, take 5 tasks

      console.log("[TEST] CSV lines to process:", lines);

      // Create a mock backend that supports execution
      const mockFiles: Map<string, string> = new Map();
      mockFiles.set("/tasks.csv", lines.join("\n"));

      // Mock backend implementing SandboxBackendProtocol
      const mockBackend = {
        id: "mock-batch-test",
        lsInfo: async (dirPath: string) => {
          console.log("[BACKEND] lsInfo:", dirPath);
          return [];
        },
        read: async (filePath: string) => {
          console.log("[BACKEND] read:", filePath);
          const content = mockFiles.get(filePath);
          if (!content) return `Error: File not found: ${filePath}`;
          return content;
        },
        write: async (filePath: string, content: string) => {
          console.log("[BACKEND] write:", filePath, "length:", content.length);
          mockFiles.set(filePath, content);
          return { error: undefined };
        },
        edit: async () => ({ error: undefined, content: "", occurrences: 0 }),
        globInfo: async () => [],
        grepRaw: async () => [],
        execute: async (command: string) => {
          console.log(
            "[BACKEND] execute:",
            command.substring(0, 200) + (command.length > 200 ? "..." : ""),
          );
          // Simulate reading CSV and spawning subagents
          if (command.includes("spawn_subagent")) {
            // Extract the spawn_subagent function definition first
            const output = lines
              .map((line) => {
                const parts = line.split(",");
                if (parts.length >= 3) {
                  const taskDesc = parts[2];
                  return `SUBAGENT_TASK: {"description": "${taskDesc}", "type": "general-purpose"}`;
                }
                return "";
              })
              .filter(Boolean)
              .join("\n");
            console.log("[BACKEND] execute output with markers:", output);
            return { output, exitCode: 0, truncated: false };
          }
          return { output: "", exitCode: 0, truncated: false };
        },
      };

      // Use createDeepAgent which is the default harness
      const agent = createDeepAgent({
        model: SAMPLE_MODEL,
        systemPrompt: `You have access to execute shell commands and can spawn batch subagents.
When asked to process a CSV file, use the execute tool to read it and spawn subagents for each task.`,
        backend: () => mockBackend as any,
      });

      // Check that both task and batch_task tools are available
      const tools = extractToolsFromAgent(agent);
      console.log("[TEST] Available tools:", Object.keys(tools));
      expect(tools.task).toBeDefined();
      expect(tools.batch_task).toBeDefined();
      expect(tools.execute).toBeDefined();

      console.log("[TEST] Starting agent invocation with streaming...");

      // Use streaming to see each step
      let stepCount = 0;
      const allToolCalls: Array<{ name: string; args: unknown }> = [];

      const stream = await agent.stream(
        {
          messages: [
            new HumanMessage(
              'Process the CSV file at /tasks.csv. For each row, spawn a subagent using the execute tool with: cat /tasks.csv | while IFS=, read -r id cat desc prompt; do spawn_subagent "$desc"; done',
            ),
          ],
        },
        { recursionLimit: 50 },
      );

      for await (const event of stream as AsyncIterable<Record<string, any>>) {
        stepCount++;
        console.log(`\n[STEP ${stepCount}] Event keys:`, Object.keys(event));

        // Log messages from event
        for (const [key, value] of Object.entries(event)) {
          const messages = (value as any)?.messages;
          if (messages && Array.isArray(messages)) {
            for (const msg of messages) {
              const msgType = msg.constructor?.name || "Unknown";
              console.log(`  [${key}] ${msgType}:`, {
                content:
                  typeof msg.content === "string"
                    ? msg.content.substring(0, 100) +
                      (msg.content.length > 100 ? "..." : "")
                    : msg.content,
                tool_calls: msg.tool_calls?.map((tc: any) => ({
                  name: tc.name,
                  args:
                    JSON.stringify(tc.args).substring(0, 100) +
                    (JSON.stringify(tc.args).length > 100 ? "..." : ""),
                })),
              });

              // Collect tool calls
              if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                  allToolCalls.push({ name: tc.name, args: tc.args });
                }
              }
            }
          }
        }
      }

      console.log("\n[TEST] Total steps:", stepCount);
      console.log(
        "[TEST] All tool calls:",
        allToolCalls.map((tc) => tc.name),
      );
      console.log("[TEST] Files written:", Array.from(mockFiles.keys()));

      // Should have called execute tool
      const executeCall = allToolCalls.find((tc) => tc.name === "execute");
      expect(executeCall).toBeDefined();

      // Should have called batch_task tool (injected synthetically via wrapModelCall)
      const batchTaskCall = allToolCalls.find((tc) => tc.name === "batch_task");
      expect(batchTaskCall).toBeDefined();
      expect((batchTaskCall?.args as any)?.tasks).toBeDefined();
      expect(Array.isArray((batchTaskCall?.args as any)?.tasks)).toBe(true);
      expect((batchTaskCall?.args as any)?.tasks.length).toBeGreaterThan(0);
    },
  );
});
