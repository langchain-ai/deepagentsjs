import { z } from "zod";
import {
  createMiddleware,
  tool,
  ToolMessage,
  AgentMiddleware,
} from "langchain";
import { Command } from "@langchain/langgraph";
import { WRITE_TODOS_DESCRIPTION } from "../prompts.js";

export type { AgentMiddleware };

const systemPrompt = `## \`write_todos\`

You have access to the \`write_todos\` tool to help you manage and plan complex objectives. 
Use this tool for complex objectives to ensure that you are tracking each necessary step and giving the user visibility into your progress.
This tool is very helpful for planning complex objectives, and for breaking down these larger complex objectives into smaller steps.

It is critical that you mark todos as completed as soon as you are done with a step. Do not batch up multiple steps before marking them as completed.
For simple objectives that only require a few steps, it is better to just complete the objective directly and NOT use this tool.
Writing todos takes time and tokens, use it when it is helpful for managing complex many-step problems! But not for simple few-step requests.

## Important To-Do List Usage Notes to Remember
- The \`write_todos\` tool should never be called multiple times in parallel.
- Don't be afraid to revise the To-Do list as you go. New information may reveal new tasks that need to be done, or old tasks that are irrelevant.`;

export const TodoStatus = z.enum(["pending", "in_progress", "completed"]);
export const TodoSchema = z.object({
  content: z.string(),
  status: TodoStatus,
});
export const TodoMiddlewareState = z.object({
  todos: z.array(TodoSchema).default([]),
});
export type TodoMiddlewareState = z.infer<typeof TodoMiddlewareState>;

/**
 * Write todos tool - manages todo list with Command return
 * Uses getCurrentTaskInput() instead of Python's InjectedState
 */
const writeTodos = tool(
  ({ todos }, config) => {
    return new Command({
      update: {
        todos,
        messages: [
          new ToolMessage({
            content: `Updated todo list to ${JSON.stringify(todos)}`,
            tool_call_id: config.toolCall?.id as string,
            name: "write_todos",
          }),
        ],
      },
    });
  },
  {
    name: "write_todos",
    description: WRITE_TODOS_DESCRIPTION,
    schema: z.object({
      todos: z.array(TodoSchema).describe("List of todo items to update"),
    }),
  },
);

export const todoMiddleware = createMiddleware({
  name: "todoMiddleware",
  stateSchema: TodoMiddlewareState,
  tools: [writeTodos],
  modifyModelRequest: (request) => {
    return {
      ...request,
      systemPrompt: request.systemPrompt + systemPrompt,
    };
  },
});
