/**
 * SubAgent implementation for Deep Agents
 *
 * Task tool creation and sub-agent management.
 * Creates SubAgent interface matching Python's TypedDict structure and implements
 * createTaskTool() function that creates agents map, handles tool resolution by name,
 * and returns a tool function that uses createReactAgent for sub-agents.
 */

import { tool, StructuredTool } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import { ToolRunnableConfig } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import type { LanguageModelLike, SubAgent } from "./types.js";
import { getDefaultModel } from "./model.js";
import { writeTodos, readFile, writeFile, editFile, ls } from "./tools.js";
import { TASK_DESCRIPTION_PREFIX, TASK_DESCRIPTION_SUFFIX } from "./prompts.js";

/**
 * Built-in tools map for tool resolution by name
 */
const BUILTIN_TOOLS: Record<string, StructuredTool> = {
  write_todos: writeTodos,
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  ls: ls,
};

/**
 * Create task tool function that creates agents map, handles tool resolution by name,
 * and returns a tool function that uses createReactAgent for sub-agents.
 * Uses Command for state updates and navigation between agents.
 */
export function createTaskTool<
  StateSchema extends z.ZodObject<any, any, any, any, any>,
>(inputs: {
  subagents: SubAgent[];
  tools: Record<string, StructuredTool>;
  model: LanguageModelLike;
  stateSchema: StateSchema;
}) {
  const {
    subagents,
    tools = {},
    model = getDefaultModel(),
    stateSchema,
  } = inputs;

  // Combine built-in tools with provided tools for tool resolution
  const allTools = { ...BUILTIN_TOOLS, ...tools };

  // Pre-create all agents like Python does
  const agentsMap = new Map<string, any>();
  for (const subagent of subagents) {
    // Resolve tools by name for this subagent
    const subagentTools: StructuredTool[] = [];
    if (subagent.tools) {
      for (const toolName of subagent.tools) {
        const resolvedTool = allTools[toolName];
        if (resolvedTool) {
          subagentTools.push(resolvedTool);
        } else {
          // eslint-disable-next-line no-console
          console.warn(
            `Warning: Tool '${toolName}' not found for agent '${subagent.name}'`,
          );
        }
      }
    } else {
      // If no tools specified, use all tools like Python does
      subagentTools.push(...Object.values(allTools));
    }

    // Create react agent for the subagent (pre-create like Python)
    const reactAgent = createReactAgent({
      llm: model,
      tools: subagentTools,
      stateSchema,
      messageModifier: subagent.prompt,
    });

    agentsMap.set(subagent.name, reactAgent);
  }

  return tool(
    async (
      input: { description: string; subagent_type: string },
      config: ToolRunnableConfig,
    ) => {
      const { description, subagent_type } = input;

      // Get the pre-created agent
      const reactAgent = agentsMap.get(subagent_type);
      if (!reactAgent) {
        return `Error: Agent '${subagent_type}' not found. Available agents: ${Array.from(agentsMap.keys()).join(", ")}`;
      }

      try {
        // Get current state for context
        const currentState = getCurrentTaskInput<z.infer<typeof stateSchema>>();

        // Modify state messages like Python does
        const modifiedState = {
          ...currentState,
          messages: [
            {
              role: "user",
              content: description,
            },
          ],
        };

        // Execute the subagent with the task
        const result = await reactAgent.invoke(modifiedState, config);

        // Use Command for state updates and navigation between agents
        // Return the result using Command to properly handle subgraph state
        return new Command({
          update: {
            files: result.files || {},
            messages: [
              new ToolMessage({
                content:
                  result.messages?.slice(-1)[0]?.content || "Task completed",
                tool_call_id: config.toolCall?.id as string,
              }),
            ],
          },
        });
      } catch (error) {
        // Handle errors gracefully
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return new Command({
          update: {
            messages: [
              new ToolMessage({
                content: `Error executing task '${description}' with agent '${subagent_type}': ${errorMessage}`,
                tool_call_id: config.toolCall?.id as string,
              }),
            ],
          },
        });
      }
    },
    {
      name: "task",
      description:
        TASK_DESCRIPTION_PREFIX.replace(
          "{other_agents}",
          subagents.map((a) => `- ${a.name}: ${a.description}`).join("\n"),
        ) + TASK_DESCRIPTION_SUFFIX,
      schema: z.object({
        description: z
          .string()
          .describe("The task to execute with the selected agent"),
        subagent_type: z
          .string()
          .describe(
            `Name of the agent to use. Available: ${subagents.map((a) => a.name).join(", ")}`,
          ),
      }),
    },
  );
}
