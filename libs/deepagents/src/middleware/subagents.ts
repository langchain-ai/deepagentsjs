import { z } from "zod/v4";
import {
  createMiddleware,
  createAgent,
  AgentMiddleware,
  tool,
  ToolMessage,
  humanInTheLoopMiddleware,
  SystemMessage,
  type InterruptOnConfig,
  type ReactAgent,
  StructuredTool,
} from "langchain";
import {
  Command,
  getCurrentTaskInput,
  ReducedValue,
  StateSchema,
  type StreamMode,
} from "@langchain/langgraph";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { IterableReadableStream } from "@langchain/core/utils/stream";

export type { AgentMiddleware };

/**
 * Default system prompt for subagents.
 * Provides a minimal base prompt that can be extended by specific subagent configurations.
 */
export const DEFAULT_SUBAGENT_PROMPT =
  "In order to complete the objective that the user asks of you, you have access to a number of standard tools.";

/**
 * State keys that are excluded when passing state to subagents and when returning
 * updates from subagents.
 *
 * When returning updates:
 * 1. The messages key is handled explicitly to ensure only the final message is included
 * 2. The todos and structuredResponse keys are excluded as they do not have a defined reducer
 *    and no clear meaning for returning them from a subagent to the main agent.
 * 3. The skillsMetadata and memoryContents keys are automatically excluded from subagent output
 *    to prevent parent state from leaking to child agents. Each agent loads its own skills/memory
 *    independently based on its middleware configuration.
 */
const EXCLUDED_STATE_KEYS = [
  "messages",
  "todos",
  "structuredResponse",
  "skillsMetadata",
  "memoryContents",
] as const;

/**
 * Default description for the general-purpose subagent.
 * This description is shown to the model when selecting which subagent to use.
 */
export const DEFAULT_GENERAL_PURPOSE_DESCRIPTION =
  "General-purpose agent for researching complex questions, searching for files and content, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. This agent has access to all tools as the main agent.";

// Comprehensive task tool description from Python
function getTaskToolDescription(subagentDescriptions: string[]): string {
  return `
Launch an ephemeral subagent to handle complex, multi-step independent tasks with isolated context windows. Tasks run **asynchronously** — the tool returns immediately and the subagent works in the background.

Available agent types and the tools they have access to:
${subagentDescriptions.join("\n")}

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

## Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses. Since tasks run in the background, they naturally execute in parallel.
2. The tool returns immediately — you do **not** need to wait for it. Continue working on other tasks or tool calls. When the subagent finishes, its result will be delivered to you as a \`[Task Result]\` message. The result is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary.
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
Assistant: *Launches three task tool calls in parallel — one per player — then continues working*
Assistant: *As each [Task Result] arrives, reads the synthesized research*
Assistant: *Once all three results are in, compares the players and responds to the User*
<commentary>
Research is a complex, multi-step task in it of itself.
The research of each individual player is not dependent on the research of the other players.
The assistant launches all three tasks at once — they run in the background simultaneously.
Each research task dives deep on one player and returns synthesized information as its result.
The assistant does not block; it can continue doing other work while the tasks run.
</commentary>
</example>

<example>
User: "Analyze a single large code repository for security vulnerabilities and generate a report."
Assistant: *Launches a single \`task\` subagent for the repository analysis*
Assistant: *Continues with other work or waits for the [Task Result]*
Assistant: *Receives the result and integrates it into a final summary for the user*
<commentary>
Subagent is used to isolate a large, context-heavy task, even though there is only one. This prevents the main thread from being overloaded with details.
If the user then asks followup questions, we have a concise report to reference instead of the entire history of analysis and tool calls, which is good and saves us time and money.
</commentary>
</example>

<example>
User: "Schedule two meetings for me and prepare agendas for each."
Assistant: *Launches two \`task\` subagents in parallel (one per meeting) to prepare agendas*
Assistant: *As results arrive, assembles final schedules and agendas*
<commentary>
Tasks are simple individually, but subagents help silo agenda preparation.
Each subagent only needs to worry about the agenda for one meeting.
Both run simultaneously in the background.
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
</example_agent_description>

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

/**
 * System prompt section that explains how to use the task tool for spawning subagents.
 *
 * This prompt is automatically appended to the main agent's system prompt when
 * using `createSubAgentMiddleware`. It provides guidance on:
 * - When to use the task tool
 * - Subagent lifecycle (spawn → run → return → reconcile)
 * - When NOT to use the task tool
 * - Best practices for parallel task execution
 *
 * You can provide a custom `systemPrompt` to `createSubAgentMiddleware` to override
 * or extend this default.
 */
export const TASK_SYSTEM_PROMPT = `## \`task\` (subagent spawner)

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
- After launching tasks, you can continue with other tool calls or reasoning. You do not need to wait — results will arrive when they are ready.`;

/**
 * Type definitions for pre-compiled agents.
 *
 * @typeParam TRunnable - The type of the runnable (ReactAgent or Runnable).
 *   When using `createAgent` or `createDeepAgent`, this preserves the middleware
 *   types for type inference. Uses `ReactAgent<any>` to accept agents with any
 *   type configuration (including DeepAgent instances).
 */
export interface CompiledSubAgent<
  TRunnable extends ReactAgent<any> | Runnable = ReactAgent<any> | Runnable,
> {
  /** The name of the agent */
  name: string;
  /** The description of the agent */
  description: string;
  /** The agent instance */
  runnable: TRunnable;
}

/**
 * Specification for a subagent that can be dynamically created.
 *
 * When using `createDeepAgent`, subagents automatically receive a default middleware
 * stack (todoListMiddleware, filesystemMiddleware, summarizationMiddleware, etc.) before
 * any custom `middleware` specified in this spec.
 *
 * Required fields:
 * - `name`: Identifier used to select this subagent in the task tool
 * - `description`: Shown to the model for subagent selection
 * - `systemPrompt`: The system prompt for the subagent
 *
 * Optional fields:
 * - `model`: Override the default model for this subagent
 * - `tools`: Override the default tools for this subagent
 * - `middleware`: Additional middleware appended after defaults
 * - `interruptOn`: Human-in-the-loop configuration for specific tools
 * - `skills`: Skill source paths for SkillsMiddleware (e.g., `["/skills/user/", "/skills/project/"]`)
 *
 * @example
 * ```typescript
 * const researcher: SubAgent = {
 *   name: "researcher",
 *   description: "Research assistant for complex topics",
 *   systemPrompt: "You are a research assistant.",
 *   tools: [webSearchTool],
 *   skills: ["/skills/research/"],
 * };
 * ```
 */
export interface SubAgent {
  /** Identifier used to select this subagent in the task tool */
  name: string;

  /** Description shown to the model for subagent selection */
  description: string;

  /** The system prompt to use for the agent */
  systemPrompt: string;

  /** The tools to use for the agent (tool instances, not names). Defaults to defaultTools */
  tools?: StructuredTool[];

  /** The model for the agent. Defaults to defaultModel */
  model?: LanguageModelLike | string;

  /** Additional middleware to append after default_middleware */
  middleware?: readonly AgentMiddleware[];

  /** Human-in-the-loop configuration for specific tools. Requires a checkpointer. */
  interruptOn?: Record<string, boolean | InterruptOnConfig>;

  /**
   * Skill source paths for SkillsMiddleware.
   *
   * List of paths to skill directories (e.g., `["/skills/user/", "/skills/project/"]`).
   * When specified, the subagent will have its own SkillsMiddleware that loads skills
   * from these paths. This allows subagents to have different skill sets than the main agent.
   *
   * Note: Custom subagents do NOT inherit skills from the main agent by default.
   * Only the general-purpose subagent inherits the main agent's skills.
   *
   * @example
   * ```typescript
   * const researcher: SubAgent = {
   *   name: "researcher",
   *   description: "Research assistant",
   *   systemPrompt: "You are a researcher.",
   *   skills: ["/skills/research/", "/skills/web-search/"],
   * };
   * ```
   */
  skills?: string[];
}

/**
 * Base specification for the general-purpose subagent.
 *
 * This constant provides the default configuration for the general-purpose subagent
 * that is automatically included when `generalPurposeAgent: true` (the default).
 *
 * The general-purpose subagent:
 * - Has access to all tools from the main agent
 * - Inherits skills from the main agent (when skills are configured)
 * - Uses the same model as the main agent (by default)
 * - Is ideal for delegating complex, multi-step tasks
 *
 * You can spread this constant and override specific properties when creating
 * custom subagents that should behave similarly to the general-purpose agent:
 *
 * @example
 * ```typescript
 * import { GENERAL_PURPOSE_SUBAGENT, createDeepAgent } from "@anthropic/deepagents";
 *
 * // Use as-is (automatically included with generalPurposeAgent: true)
 * const agent = createDeepAgent({ model: "claude-sonnet-4-5-20250929" });
 *
 * // Or create a custom variant with different tools
 * const customGP: SubAgent = {
 *   ...GENERAL_PURPOSE_SUBAGENT,
 *   name: "research-gp",
 *   tools: [webSearchTool, readFileTool],
 * };
 *
 * const agent = createDeepAgent({
 *   model: "claude-sonnet-4-5-20250929",
 *   subagents: [customGP],
 *   // Disable the default general-purpose agent since we're providing our own
 *   // (handled automatically when using createSubAgentMiddleware directly)
 * });
 * ```
 */
export const GENERAL_PURPOSE_SUBAGENT: Pick<
  SubAgent,
  "name" | "description" | "systemPrompt"
> = {
  name: "general-purpose",
  description: DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
  systemPrompt: DEFAULT_SUBAGENT_PROMPT,
} as const;

/**
 * Filter state to exclude certain keys when passing to subagents
 */
function filterStateForSubagent(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!EXCLUDED_STATE_KEYS.includes(key as never)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Create subagent instances from specifications
 */
function getSubagents(options: {
  defaultModel: LanguageModelLike | string;
  defaultTools: StructuredTool[];
  defaultMiddleware: AgentMiddleware[] | null;
  /** Middleware specifically for the general-purpose subagent (includes skills from main agent) */
  generalPurposeMiddleware: AgentMiddleware[] | null;
  defaultInterruptOn: Record<string, boolean | InterruptOnConfig> | null;
  subagents: (SubAgent | CompiledSubAgent)[];
  generalPurposeAgent: boolean;
}): {
  agents: Record<string, ReactAgent | Runnable>;
  descriptions: string[];
} {
  const {
    defaultModel,
    defaultTools,
    defaultMiddleware,
    generalPurposeMiddleware: gpMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
  } = options;

  const defaultSubagentMiddleware = defaultMiddleware || [];
  // General-purpose middleware includes skills from main agent, falls back to default
  const generalPurposeMiddlewareBase =
    gpMiddleware || defaultSubagentMiddleware;
  const agents: Record<string, ReactAgent | Runnable> = {};
  const subagentDescriptions: string[] = [];

  // Create general-purpose agent if enabled
  if (generalPurposeAgent) {
    const generalPurposeMiddleware = [...generalPurposeMiddlewareBase];
    if (defaultInterruptOn) {
      generalPurposeMiddleware.push(
        humanInTheLoopMiddleware({ interruptOn: defaultInterruptOn }),
      );
    }

    const generalPurposeSubagent = createAgent({
      model: defaultModel,
      systemPrompt: DEFAULT_SUBAGENT_PROMPT,
      tools: defaultTools as any,
      middleware: generalPurposeMiddleware,
      name: "general-purpose",
    });

    agents["general-purpose"] = generalPurposeSubagent;
    subagentDescriptions.push(
      `- general-purpose: ${DEFAULT_GENERAL_PURPOSE_DESCRIPTION}`,
    );
  }

  // Process custom subagents (use defaultMiddleware WITHOUT skills)
  for (const agentParams of subagents) {
    subagentDescriptions.push(
      `- ${agentParams.name}: ${agentParams.description}`,
    );

    if ("runnable" in agentParams) {
      agents[agentParams.name] = agentParams.runnable;
    } else {
      const middleware = agentParams.middleware
        ? [...defaultSubagentMiddleware, ...agentParams.middleware]
        : [...defaultSubagentMiddleware];

      const interruptOn = agentParams.interruptOn || defaultInterruptOn;
      if (interruptOn)
        middleware.push(humanInTheLoopMiddleware({ interruptOn }));

      agents[agentParams.name] = createAgent({
        model: agentParams.model ?? defaultModel,
        systemPrompt: agentParams.systemPrompt,
        tools: agentParams.tools ?? defaultTools,
        middleware,
        name: agentParams.name,
      });
    }
  }

  return { agents, descriptions: subagentDescriptions };
}

/**
 * The streaming mode configuration for a {@link SubagentExecution}.
 *
 * Accepts the same shapes that `graph.stream()` does:
 * - A single mode string like `"values"` or `"updates"`
 * - An array of modes like `["updates"]` — in this case chunks arrive as
 *   `[mode, data]` tuples and the class unwraps them automatically
 */
export type SubagentStreamMode = StreamMode | StreamMode[];

export interface SubagentExecutionConfig {
  streamMode?: SubagentStreamMode;
}

/**
 * Represents a single subagent execution that can be placed in graph state.
 * Implements `PromiseLike` so it can be directly awaited to get the final state.
 *
 * Wraps an `IterableReadableStream` (the return type of `graph.stream()`)
 * and provides:
 * - `isPending` — whether the stream is still being consumed
 * - `state` — the latest graph state snapshot, updated with each chunk
 * - Awaitable via `await execution` or `execution.then(...)` to get the
 *   final accumulated state
 *
 * Iteration starts **eagerly** in the constructor — the stream is consumed
 * in the background as soon as the execution is created. This means you can
 * put the execution into graph state immediately and the stream keeps
 * draining without any external driver.
 *
 * @typeParam TState - The shape of the subagent's graph state.
 *
 * @example
 * ```typescript
 * const stream = await subagent.stream(input, config);
 * const execution = new SubagentExecution("researcher", stream);
 *
 * // Place in state, stream is already being consumed
 * return { tasks: { [id]: execution } };
 *
 * // Later, await directly:
 * const finalState = await execution;
 * ```
 */
export class SubagentExecution<
  TState extends Record<string, unknown> = Record<string, unknown>,
> implements PromiseLike<TState> {
  readonly subagentType: string;
  private _isPending = true;
  private _state: TState | null = null;

  /** Resolves with the final subagent state once the stream is fully consumed. */
  readonly result: Promise<TState>;

  /** Whether the stream has not yet been fully consumed. */
  get isPending(): boolean {
    return this._isPending;
  }

  /** The latest snapshot of the subagent's graph state, updated as the stream is consumed. */
  get state(): TState | null {
    return this._state;
  }

  constructor(
    subagentType: string,
    stream: IterableReadableStream<unknown>,
    config?: SubagentExecutionConfig,
  ) {
    this.subagentType = subagentType;
    this.result = this._consume(stream, config?.streamMode ?? "values");
  }

  then<TResult1 = TState, TResult2 = never>(
    onfulfilled?: ((value: TState) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.result.then(onfulfilled, onrejected);
  }

  private async _consume(
    stream: IterableReadableStream<unknown>,
    streamMode: SubagentStreamMode,
  ): Promise<TState> {
    const isArrayMode = Array.isArray(streamMode);
    const effectiveMode: StreamMode = isArrayMode ? streamMode[0] : streamMode;

    try {
      let state = {} as TState;

      for await (const value of stream) {
        if (value == null || typeof value !== "object") continue;

        // Array-form streamMode wraps each chunk as a [mode, data] tuple
        const data =
          isArrayMode && Array.isArray(value)
            ? (value as [string, unknown])[1]
            : value;

        if (data == null || typeof data !== "object") continue;

        const chunk = data as Record<string, unknown>;

        if (effectiveMode === "values") {
          state = chunk as TState;
        } else if (effectiveMode === "updates") {
          for (const nodeUpdate of Object.values(chunk)) {
            if (nodeUpdate && typeof nodeUpdate === "object") {
              state = { ...state, ...(nodeUpdate as Partial<TState>) };
            }
          }
        }

        this._state = state;
      }

      this._isPending = false;
      return state;
    } catch (error) {
      this._isPending = false;
      throw error;
    }
  }
}

const TaskMap = z.record(z.string(), z.custom<SubagentExecution>());

const TaskUpdate = z.union([
  z.object({
    type: z.literal("add"),
    execution: z.custom<SubagentExecution>(),
  }),
  z.object({
    type: z.literal("remove"),
  }),
]);

const TaskMapInput = z.record(z.string(), TaskUpdate);

const MiddlewareState = new StateSchema({
  tasks: new ReducedValue(TaskMap.default({}), {
    inputSchema: TaskMapInput,
    reducer: (left, right) => {
      if (!right || Object.keys(right).length === 0) return left ?? {};
      const merged: Record<string, SubagentExecution> = { ...(left ?? {}) };
      for (const [k, update] of Object.entries(right)) {
        if (update.type === "remove") {
          delete merged[k];
        } else {
          merged[k] = update.execution;
        }
      }
      return merged;
    },
  }),
});

/**
 * Sweep the tasks map for completed executions and build the state update
 * needed to apply their results and remove them.
 *
 * Returns `null` when there are no completed tasks to process.
 */
function collectCompletedTasks(
  tasks: Record<string, SubagentExecution> | undefined,
): {
  stateUpdate: Record<string, unknown>;
  messages: HumanMessage[];
  taskUpdates: z.infer<typeof TaskMapInput>;
} | null {
  if (!tasks || Object.keys(tasks).length === 0) return null;

  const stateUpdate: Record<string, unknown> = {};
  const messages: HumanMessage[] = [];
  const taskUpdates: z.infer<typeof TaskMapInput> = {};
  let hasCompleted = false;

  for (const [id, execution] of Object.entries(tasks)) {
    if (execution.isPending) continue;
    hasCompleted = true;
    taskUpdates[id] = { type: "remove" };

    const finalState = execution.state;
    if (finalState) {
      const filtered = filterStateForSubagent(finalState);
      Object.assign(stateUpdate, filtered);

      const msgs = finalState.messages as Array<BaseMessage>;
      const lastMsg = msgs?.at(-1);
      messages.push(
        new HumanMessage({
          content: `[Task Result] The "${execution.subagentType}" task has completed.\n\n${lastMsg?.text || "Task completed successfully."}`,
        }),
      );
    }
  }

  return hasCompleted ? { stateUpdate, messages, taskUpdates } : null;
}

/**
 * Create the task tool for invoking subagents
 */
function createTaskTool(options: {
  defaultModel: LanguageModelLike | string;
  defaultTools: StructuredTool[];
  defaultMiddleware: AgentMiddleware[] | null;
  /** Middleware specifically for the general-purpose subagent (includes skills from main agent) */
  generalPurposeMiddleware: AgentMiddleware[] | null;
  defaultInterruptOn: Record<string, boolean | InterruptOnConfig> | null;
  subagents: (SubAgent | CompiledSubAgent)[];
  generalPurposeAgent: boolean;
  taskDescription: string | null;
}) {
  const {
    defaultModel,
    defaultTools,
    defaultMiddleware,
    generalPurposeMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
    taskDescription,
  } = options;

  const { agents: subagentGraphs, descriptions: subagentDescriptions } =
    getSubagents({
      defaultModel,
      defaultTools,
      defaultMiddleware,
      generalPurposeMiddleware,
      defaultInterruptOn,
      subagents,
      generalPurposeAgent,
    });

  const finalTaskDescription = taskDescription
    ? taskDescription
    : getTaskToolDescription(subagentDescriptions);

  return tool(
    async (
      input: { description: string; subagent_type: string },
      config,
    ): Promise<Command | string> => {
      const { description, subagent_type } = input;

      // Validate subagent type
      if (!(subagent_type in subagentGraphs)) {
        const allowedTypes = Object.keys(subagentGraphs)
          .map((k) => `\`${k}\``)
          .join(", ");
        throw new Error(
          `Error: invoked agent of type ${subagent_type}, the only allowed types are ${allowedTypes}`,
        );
      }
      if (!config.toolCall?.id) {
        throw new Error("Tool call ID is required for subagent invocation");
      }

      const subagent = subagentGraphs[subagent_type];

      // Get current state and filter it for subagent
      const currentState = getCurrentTaskInput<Record<string, unknown>>();
      const subagentState = filterStateForSubagent(currentState);
      subagentState.messages = [new HumanMessage({ content: description })];

      const stream = await subagent.stream(subagentState, config);
      const toolCallId = config.toolCall.id;

      // Iteration starts eagerly — the stream is consumed in the background
      // immediately on construction. The execution goes into state so
      // downstream nodes can observe progress via isPending / state / result.
      const execution = new SubagentExecution(subagent_type, stream);

      return new Command({
        update: {
          messages: [
            new ToolMessage({
              content: "Task initiated",
              tool_call_id: toolCallId,
              name: "task",
            }),
          ],
          tasks: {
            [toolCallId]: { type: "add" as const, execution },
          },
        },
      });
    },
    {
      name: "task",
      description: finalTaskDescription,
      schema: z.object({
        description: z
          .string()
          .describe("The task to execute with the selected agent"),
        subagent_type: z
          .string()
          .describe(
            `Name of the agent to use. Available: ${Object.keys(subagentGraphs).join(", ")}`,
          ),
      }),
    },
  );
}

/**
 * Options for creating subagent middleware
 */
export interface SubAgentMiddlewareOptions {
  /** The model to use for subagents */
  defaultModel: LanguageModelLike | string;
  /** The tools to use for the default general-purpose subagent */
  defaultTools?: StructuredTool[];
  /** Default middleware to apply to custom subagents (WITHOUT skills from main agent) */
  defaultMiddleware?: AgentMiddleware[] | null;
  /**
   * Middleware specifically for the general-purpose subagent (includes skills from main agent).
   * If not provided, falls back to defaultMiddleware.
   */
  generalPurposeMiddleware?: AgentMiddleware[] | null;
  /** The tool configs for the default general-purpose subagent */
  defaultInterruptOn?: Record<string, boolean | InterruptOnConfig> | null;
  /** A list of additional subagents to provide to the agent */
  subagents?: (SubAgent | CompiledSubAgent)[];
  /** Full system prompt override */
  systemPrompt?: string | null;
  /** Whether to include the general-purpose agent */
  generalPurposeAgent?: boolean;
  /** Custom description for the task tool */
  taskDescription?: string | null;
}

/**
 * Create subagent middleware with task tool
 */
export function createSubAgentMiddleware(options: SubAgentMiddlewareOptions) {
  const {
    defaultModel,
    defaultTools = [],
    defaultMiddleware = null,
    generalPurposeMiddleware = null,
    defaultInterruptOn = null,
    subagents = [],
    systemPrompt = TASK_SYSTEM_PROMPT,
    generalPurposeAgent = true,
    taskDescription = null,
  } = options;

  const taskTool = createTaskTool({
    defaultModel,
    defaultTools,
    defaultMiddleware,
    generalPurposeMiddleware,
    defaultInterruptOn,
    subagents,
    generalPurposeAgent,
    taskDescription,
  });

  return createMiddleware({
    name: "subAgentMiddleware",
    stateSchema: MiddlewareState,
    tools: [taskTool],

    beforeModel: async (state) => {
      const tasks = state.tasks as
        | Record<string, SubagentExecution>
        | undefined;
      const result = collectCompletedTasks(tasks);
      if (!result) return;

      return {
        ...result.stateUpdate,
        messages: result.messages,
        tasks: result.taskUpdates,
      };
    },

    wrapModelCall: async (request, handler) => {
      if (systemPrompt !== null) {
        return handler({
          ...request,
          systemMessage: request.systemMessage.concat(
            new SystemMessage({ content: systemPrompt }),
          ),
        });
      }
      return handler(request);
    },

    afterAgent: {
      hook: async (state) => {
        const tasks = state.tasks as
          | Record<string, SubagentExecution>
          | undefined;
        if (!tasks || Object.keys(tasks).length === 0) return;

        // Race all executions — resolves instantly if any are already
        // done, otherwise blocks until the first one finishes. Remaining
        // tasks keep draining in the background and get picked up by
        // beforeModel / afterAgent on subsequent iterations.
        await Promise.race(Object.values(tasks).map((exec) => exec.result));

        const result = collectCompletedTasks(tasks);
        if (!result) return;

        return {
          ...result.stateUpdate,
          messages: result.messages,
          tasks: result.taskUpdates,
          jumpTo: "model" as const,
        };
      },
      canJumpTo: ["model"],
    },
  });
}
