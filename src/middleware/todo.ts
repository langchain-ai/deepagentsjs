import { z } from "zod";
import { createMiddleware, tool, ToolMessage, AgentMiddleware } from "langchain";
import { Command } from "@langchain/langgraph";
import { WRITE_TODOS_DESCRIPTION } from "../prompts.js";

export type { AgentMiddleware };

export const TodoStatus = z.enum(["pending", "in_progress", "completed"]);
export const TodoSchema = z.object({
  content: z.string(),
  status: TodoStatus
});
export const TodoMiddlewareState = z.object({
  todos: z.array(TodoSchema).optional(),
});
export type TodoMiddlewareState = z.infer<typeof TodoMiddlewareState>;

export const todoMiddleware = createMiddleware({
  name: "todoMiddleware",
  stateSchema: TodoMiddlewareState,
  modifyModelRequest: async (request) => {
    return {
      ...request,
      tools: [...request.tools, writeTodos]
    }
  },
});

const WriteTodosSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().describe("Content of the todo item"),
        status: z
          .enum(["pending", "in_progress", "completed"])
          .describe("Status of the todo"),
      }),
    )
    .describe("List of todo items to update"),
})
export type WriteTodosSchema = z.infer<typeof WriteTodosSchema>;

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
          }),
        ],
      },
    });
  },
  {
    name: "write_todos",
    description: WRITE_TODOS_DESCRIPTION,
    schema: WriteTodosSchema,
  },
);