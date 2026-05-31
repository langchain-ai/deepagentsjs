/**
 * Enhanced todoListMiddleware that adds:
 * 1. Auto-generated UUIDs for todos (so parallel subagents can merge by ID)
 * 2. A ReducedValue with merge-by-id + status-priority reducer
 *    (so parallel subagent todo updates don't clobber each other)
 *
 * This replaces langchain's todoListMiddleware with a stateSchema that uses
 * ReducedValue for proper concurrent merging.
 */
import { z } from "zod/v4";
import { randomUUID } from "crypto";
import { Command, StateSchema, ReducedValue } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import {
  createMiddleware,
  TODO_LIST_MIDDLEWARE_SYSTEM_PROMPT,
} from "langchain";

const TodoStatus = z
  .enum(["pending", "in_progress", "completed"])
  .describe("Status of the todo");

const TodoSchema = z.object({
  id: z.string().optional().describe("Unique identifier for the todo"),
  content: z.string().describe("Content of the todo item"),
  status: TodoStatus,
});

type Todo = z.infer<typeof TodoSchema>;

const STATUS_PRIORITY: Record<string, number> = {
  pending: 0,
  in_progress: 1,
  completed: 2,
};

/**
 * Merge-by-id reducer with status priority.
 * - Existing IDs are updated in-place (never downgrading status)
 * - New IDs are appended
 * - Status priority: completed(2) > in_progress(1) > pending(0)
 *
 * Parallel subagents operate on stale snapshots of the todo list, so a late
 * update must never move a todo backwards (e.g. completed -> in_progress).
 */
function todosReducer(current: Todo[], update: Todo[]): Todo[] {
  if (!update) return current || [];
  if (!current || current.length === 0) return update;

  const merged = [...current];
  const mergedById = new Map(merged.map((t, i) => [t.id, i]));

  for (const todo of update) {
    const existingIdx = mergedById.get(todo.id);
    if (existingIdx !== undefined) {
      const prev = merged[existingIdx]!;
      const prevPriority = STATUS_PRIORITY[prev.status] ?? 0;
      const nextPriority = STATUS_PRIORITY[todo.status] ?? 0;
      // Never downgrade status — parallel subagents have stale snapshots.
      if (nextPriority >= prevPriority) {
        merged[existingIdx] = todo;
      }
    } else {
      mergedById.set(todo.id, merged.length);
      merged.push(todo);
    }
  }

  return merged;
}

const stateSchema = new StateSchema({
  todos: new ReducedValue(z.array(TodoSchema).default([]), {
    reducer: todosReducer,
  }),
});

export interface TodoListMiddlewareOptions {
  systemPrompt?: string;
  toolDescription?: string;
}

/**
 * Enhanced todoListMiddleware with UUID auto-generation and merge-by-id reducer.
 */
export function todoListMiddleware(options?: TodoListMiddlewareOptions) {
  const writeTodos = tool(
    ({ todos }, config) => {
      // Auto-generate UUIDs for any todos that don't have them so the
      // merge-by-id reducer can track them across parallel subagent updates.
      const todosWithIds = todos.map((t) => ({
        ...t,
        id: t.id || randomUUID(),
      }));
      return new Command({
        update: {
          todos: todosWithIds,
          messages: [
            new ToolMessage({
              content: `Updated todo list to ${JSON.stringify(todosWithIds)}`,
              tool_call_id: config.toolCall?.id as string,
            }),
          ],
        },
      });
    },
    {
      name: "write_todos",
      description:
        options?.toolDescription ??
        "Create and manage a structured task list. Pass the full list of todos with their current statuses.",
      schema: z.object({
        todos: z.array(TodoSchema).describe("List of todo items to update"),
      }),
    },
  );

  return createMiddleware({
    name: "todoListMiddleware",
    stateSchema,
    tools: [writeTodos],
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        systemMessage: request.systemMessage.concat(
          `\n\n${options?.systemPrompt ?? TODO_LIST_MIDDLEWARE_SYSTEM_PROMPT}`,
        ),
      }),
    afterModel: (state) => {
      // Reject parallel write_todos calls — the list must be written atomically.
      const messages = state.messages;
      if (!messages || messages.length === 0) return undefined;

      const lastAiMsg = [...messages]
        .reverse()
        .find((msg) => AIMessage.isInstance(msg));
      if (
        !lastAiMsg ||
        !lastAiMsg.tool_calls ||
        lastAiMsg.tool_calls.length === 0
      )
        return undefined;

      const writeTodosCalls = lastAiMsg.tool_calls.filter(
        (tc) => tc.name === writeTodos.name,
      );

      if (writeTodosCalls.length > 1) {
        const errorMessages = writeTodosCalls.map(
          (tc) =>
            new ToolMessage({
              content:
                "Error: The `write_todos` tool should never be called multiple times " +
                "in parallel. Please call it only once per model invocation.",
              tool_call_id: tc.id as string,
              status: "error",
            }),
        );
        return { messages: errorMessages };
      }

      return undefined;
    },
  });
}
