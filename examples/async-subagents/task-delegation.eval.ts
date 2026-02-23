import * as ls from "langsmith/vitest";
import { expect } from "vitest";
import { createAgent, createMiddleware, tool, SystemMessage } from "langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessageChunk } from "@langchain/core/messages";
import { z } from "zod/v4";
import type { LanguageModelLike } from "@langchain/core/language_models/base";

const subagentDescriptions = [
  `- general-purpose: General-purpose agent for researching complex questions, searching for files and content, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. This agent has access to all tools as the main agent.`,
];

function getTaskToolDescription(descriptions: string[]): string {
  return `
Launch an ephemeral subagent to handle complex, multi-step independent tasks with isolated context windows. Tasks run **asynchronously** — the tool returns immediately and the subagent works in the background.

Available agent types and the tools they have access to:
${descriptions.join("\n")}

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

## Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses. Since tasks run in the background, they naturally execute in parallel.
2. The tool returns immediately. If you have other independent tool calls to make, continue with those. Otherwise, respond with a brief status message (e.g., "I've dispatched the tasks, working on it...") and **stop**. Do NOT attempt to answer the user's question yourself that you've already delegated to subagents. When the subagent finishes, its result will be delivered to you as a \`[Task Result]\` message. The result is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary.
3. Each agent invocation is stateless. You will not be able to send additional messages to the agent, nor will the agent be able to communicate with you outside of its final report. Therefore, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.
4. The agent's outputs should generally be trusted
5. Clearly tell the agent whether you expect it to create content, perform analysis, or just do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
6. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
7. When only the general-purpose agent is provided, you should use it for all tasks. It is great for isolating context and token usage, and completing specific, complex tasks, as it has all the same capabilities as the main agent.

### Example usage of the general-purpose agent:

<example_agent_descriptions>
"general-purpose": use this agent for general purpose tasks, it has access to all tools as the main agent.
</example_agent_descriptions>

<example>
User: "I want to conduct research on the accomplishments of Lebron James, Michael Jordan, and Kobe Bryant, and then compare them."
Assistant: *Launches three task tool calls in parallel — one per player — then emits a brief acknowledgment and stops*
Assistant: *As each [Task Result] arrives, reads the synthesized research*
Assistant: *Once all three results are in, compares the players and responds to the User*
<commentary>
Research is a complex, multi-step task in it of itself.
The research of each individual player is not dependent on the research of the other players.
The assistant launches all three tasks at once — they run in the background simultaneously.
Each research task dives deep on one player and returns synthesized information as its result.
The assistant emits a brief acknowledgment and stops — it does NOT try to answer the question itself.
</commentary>
</example>

<example>
User: "Analyze a single large code repository for security vulnerabilities and generate a report."
Assistant: *Launches a single \`task\` subagent for the repository analysis, emits a brief acknowledgment, and stops*
Assistant: *Receives the [Task Result] and integrates it into a final summary for the user*
<commentary>
Subagent is used to isolate a large, context-heavy task, even though there is only one. This prevents the main thread from being overloaded with details.
If the user then asks followup questions, we have a concise report to reference instead of the entire history of analysis and tool calls, which is good and saves us time and money.
</commentary>
</example>

<example>
User: "Schedule two meetings for me and prepare agendas for each."
Assistant: *Launches two \`task\` subagents in parallel (one per meeting) to prepare agendas, then stops*
Assistant: *As [Task Result] messages arrive, assembles final schedules and agendas*
<commentary>
Tasks are simple individually, but subagents help silo agenda preparation.
Each subagent only needs to worry about the agenda for one meeting.
Both run simultaneously in the background. The assistant stops and waits for results.
</commentary>
</example>

<example>
User: "I want to order a pizza from Dominos, order a burger from McDonald's, and order a salad from Subway."
Assistant: *Calls tools directly in parallel to order a pizza from Dominos, a burger from McDonald's, and a salad from Subway*
<commentary>
The assistant did not use the task tool because the objective is super simple and clear and only requires a few trivial tool calls.
It is better to just complete the task directly and NOT use the \`task\` tool.
</commentary>
</example>

### Example usage with custom agents:

<example_agent_descriptions>
"content-reviewer": use this agent after you are done creating significant content or documents
"greeting-responder": use this agent when to respond to user greetings with a friendly joke
"research-analyst": use this agent to conduct thorough research on complex topics
</example_agent_descriptions>

<example>
user: "Please write a function that checks if a number is prime"
assistant: Sure let me write a function that checks if a number is prime
assistant: First let me use the Write tool to write a function that checks if a number is prime
assistant: I'm going to use the Write tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since significant content was created and the task was completed, now use the content-reviewer agent to review the work
</commentary>
assistant: Now let me use the content-reviewer agent to review the code
assistant: Uses the Task tool to launch with the content-reviewer agent
</example>

<example>
user: "Can you help me research the environmental impact of different renewable energy sources and create a comprehensive report?"
<commentary>
This is a complex research task that would benefit from using the research-analyst agent to conduct thorough analysis
</commentary>
assistant: I'll help you research the environmental impact of renewable energy sources. Let me use the research-analyst agent to conduct comprehensive research on this topic.
assistant: Uses the Task tool to launch with the research-analyst agent, providing detailed instructions about what research to conduct and what format the report should take
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the Task tool to launch with the greeting-responder agent"
</example>
  `.trim();
}

const TASK_SYSTEM_PROMPT = `## \`task\` (subagent spawner)

You have access to a \`task\` tool to launch short-lived subagents that handle isolated tasks. Tasks run **asynchronously** — the tool returns immediately and the subagent works in the background. When a subagent finishes, its result is delivered to you as a \`[Task Result]\` message.

When to use the task tool:
- When a task is complex and multi-step, and can be fully delegated in isolation
- When a task is independent of other tasks and can run in parallel
- When a task requires focused reasoning or heavy token/context usage that would bloat the orchestrator thread
- When sandboxing improves reliability (e.g. code execution, structured searches, data formatting)
- When you only care about the output of the subagent, and not the intermediate steps (ex. performing a lot of research and then returned a synthesized report, performing a series of computations or lookups to achieve a concise, relevant answer.)

Subagent lifecycle:
1. **Spawn** → Call the \`task\` tool with a clear role, instructions, and expected output. The tool returns immediately.
2. **Run** → The subagent works in the background while you continue with other work.
3. **Result** → When the subagent finishes, you receive a \`[Task Result]\` message with its output.
4. **Reconcile** → Incorporate or synthesize the result into the main thread.

When NOT to use the task tool:
- If you need to see the intermediate reasoning or steps after the subagent has completed (the task tool hides them)
- If the task is trivial (a few tool calls or simple lookup)
- If delegating does not reduce token usage, complexity, or context switching
- If splitting would add latency without benefit

## Important Task Tool Usage Notes to Remember
- Whenever possible, parallelize the work that you do. This is true for both tool_calls, and for tasks. Since tasks run in the background, launching multiple tasks in a single message means they all execute simultaneously — take advantage of this.
- Remember to use the \`task\` tool to silo independent tasks within a multi-part objective.
- You should use the \`task\` tool whenever you have a complex task that will take multiple steps, and is independent from other tasks that the agent needs to complete. These agents are highly competent and efficient.
- After launching tasks, if you have other independent tool calls to make, continue with those. Otherwise, emit a brief acknowledgment and **stop** — do NOT answer the user's question yourself. Results will arrive as \`[Task Result]\` messages when the subagents finish.`;

const taskTool = tool(async () => "Task scheduled successfully.", {
  name: "task",
  description: getTaskToolDescription(subagentDescriptions),
  schema: z.object({
    description: z
      .string()
      .describe("The task to execute with the selected agent"),
    subagent_type: z
      .string()
      .describe("Name of the agent to use. Available: general-purpose"),
  }),
});

function buildAgent(model: LanguageModelLike) {
  const middleware = createMiddleware({
    name: "subAgentMiddleware",
    tools: [taskTool],
    wrapModelCall: async (request, handler) => {
      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(
          new SystemMessage({ content: TASK_SYSTEM_PROMPT }),
        ),
      });
    },
  });

  return createAgent({
    model,
    systemPrompt:
      "You are a helpful assistant.\n\nIn order to complete the objective that the user asks of you, you have access to a number of standard tools.",
    tools: [],
    middleware: [middleware],
    name: "orchestrator",
  });
}

const MODELS: Record<string, () => LanguageModelLike> = {
  "claude-sonnet-4-5-20250929": () =>
    new ChatAnthropic({ model: "claude-sonnet-4-5-20250929" }),
  "claude-sonnet-4-6": () => new ChatAnthropic({ model: "claude-sonnet-4-6" }),
  "claude-opus-4-6": () => new ChatAnthropic({ model: "claude-opus-4-6" }),
  "gpt-4.1": () => new ChatOpenAI({ model: "gpt-4.1" }),
  "gpt-4.1-mini": () => new ChatOpenAI({ model: "gpt-4.1-mini" }),
  "o4-mini": () => new ChatOpenAI({ model: "o4-mini" }),
};

const TEST_CASES = [
  {
    userMessage:
      "Research the pros and cons of React vs Svelte for building web apps.",
    shouldDelegate: true,
    minTaskCalls: 1,
  },
  {
    userMessage:
      "I want to conduct research on the accomplishments of Lebron James, Michael Jordan, and Kobe Bryant, and then compare them.",
    shouldDelegate: true,
    minTaskCalls: 2,
  },
  {
    userMessage:
      "Analyze my codebase for security vulnerabilities and generate a detailed report.",
    shouldDelegate: true,
    minTaskCalls: 1,
  },
  {
    userMessage:
      "Find all the TypeScript files in my project that import from 'lodash', check if there are newer native alternatives, and create a migration plan.",
    shouldDelegate: true,
    minTaskCalls: 1,
  },
  {
    userMessage: "What is 2 + 2?",
    shouldDelegate: false,
    minTaskCalls: 0,
  },
  {
    userMessage: "Hello, how are you?",
    shouldDelegate: false,
    minTaskCalls: 0,
  },
];

// ── Dataset: every (model × testCase) combination ──────────────────────────

function createModel(modelName: string): LanguageModelLike {
  return MODELS[modelName]();
}

const DELEGATE_ONLY = process.env.EVAL_DELEGATE_ONLY === "true";

const DATASET = Object.keys(MODELS).flatMap((modelName) =>
  TEST_CASES.filter((tc) => !DELEGATE_ONLY || tc.shouldDelegate).map((tc) => ({
    inputs: { model: modelName, userMessage: tc.userMessage },
    referenceOutputs: {
      shouldDelegate: tc.shouldDelegate,
      minTaskCalls: tc.minTaskCalls,
    },
  })),
);

ls.describe("task-delegation", () => {
  ls.test.each(DATASET)(
    "task delegation eval",
    async ({ inputs, referenceOutputs }) => {
      const agent = buildAgent(createModel(inputs.model));
      const shouldDelegate = referenceOutputs!.shouldDelegate;
      const minTaskCalls = referenceOutputs!.minTaskCalls;

      const stream = await agent.stream(
        { messages: [{ role: "user", content: inputs.userMessage }] },
        { streamMode: "messages" as const },
      );

      let streamedText = "";
      let leakedTaskResult = false;
      const allMessages: any[] = [];

      for await (const [chunk] of stream) {
        if (AIMessageChunk.isInstance(chunk)) {
          streamedText += chunk.text;
          if (streamedText.includes("[Task Result]")) {
            leakedTaskResult = true;
            break;
          }
        }
        allMessages.push(chunk);
      }

      const taskCalls = allMessages.flatMap(
        (m: any) => m.tool_calls?.filter((tc: any) => tc.name === "task") ?? [],
      );
      const delegated = taskCalls.length > 0;

      ls.logOutputs({
        delegated,
        taskCallCount: taskCalls.length,
        leakedTaskResult,
        streamedText: streamedText.slice(0, 500),
        taskCalls: taskCalls.map((tc: any) => ({
          subagent_type: tc.args.subagent_type,
          description: tc.args.description?.slice(0, 200),
        })),
      });

      ls.logFeedback({
        key: "delegated_correctly",
        score: delegated === shouldDelegate ? 1 : 0,
        comment:
          delegated === shouldDelegate
            ? `Correct: ${delegated ? "delegated" : "did not delegate"}`
            : `Wrong: expected ${shouldDelegate ? "delegation" : "no delegation"}, got ${delegated ? "delegation" : "no delegation"}`,
      });

      ls.logFeedback({
        key: "tasks_created",
        score: taskCalls.length,
        comment: `Created ${taskCalls.length} tasks (expected ${shouldDelegate ? `>= ${minTaskCalls}` : "0"})`,
      });

      ls.logFeedback({
        key: "no_leaked_task_result",
        score: leakedTaskResult ? 0 : 1,
        comment: leakedTaskResult
          ? "FAIL: Model streamed [Task Result] text in its output"
          : "OK: No leaked [Task Result] in output",
      });

      expect(
        leakedTaskResult,
        "Model leaked [Task Result] in streamed output",
      ).toBe(false);
      expect(delegated).toBe(shouldDelegate);
      if (shouldDelegate && minTaskCalls > 1) {
        expect(taskCalls.length).toBeGreaterThanOrEqual(minTaskCalls);
      }
    },
  );
});
