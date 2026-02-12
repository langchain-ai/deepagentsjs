/**
 * Enhanced todoListMiddleware that adds:
 * 1. Auto-generated UUIDs for todos (so parallel subagents can merge by ID)
 * 2. A ReducedValue with merge-by-id + status-priority reducer
 *    (so parallel subagent todo updates don't clobber each other)
 *
 * IMPORTANT: This middleware intentionally does NOT use afterModel.
 * afterModel creates a separate LangGraph node that can run with stale state
 * snapshots, causing it to overwrite completed todos back to pending when
 * subagent Command returns are interleaved with afterModel execution.
 */
import { z } from "zod/v4";
import { randomUUID } from "crypto";
import { Command, StateSchema, ReducedValue } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { ToolMessage } from "@langchain/core/messages";
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
 */
function todosReducer(current: Todo[], update: Todo[]): Todo[] {
  if (!update) return current || [];
  if (!current || current.length === 0) {
    return update;
  }
  if (update.length === 0) return []; // explicit clear signal

  const merged = [...current];
  const mergedById = new Map(merged.map((t, i) => [t.id, i]));
  for (const todo of update) {
    const existingIdx = mergedById.get(todo.id);
    if (existingIdx !== undefined) {
      const prev = merged[existingIdx]!;
      const prevPriority = STATUS_PRIORITY[prev.status] ?? 0;
      const nextPriority = STATUS_PRIORITY[todo.status] ?? 0;
      // Never downgrade status — parallel subagents have stale snapshots
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
 *
 * No afterModel hook — afterModel creates a separate LangGraph node that
 * runs with stale state snapshots, overwriting subagent todo completions.
 */
export function todoListMiddleware(options?: TodoListMiddlewareOptions) {
  const writeTodos = tool(
    ({ todos }, config) => {
      // Auto-generate UUIDs for any todos that don't have them.
      // Auto-upgrade pending → in_progress: if the agent is creating/updating
      // todos, it's actively working on them. The LLM often ignores prompts to
      // set in_progress, so we enforce it here. The LLM can still explicitly
      // set "completed" when done.
      const todosWithIds = todos.map((t) => ({
        ...t,
        id: t.id || randomUUID(),
        status: t.status === "pending" ? "in_progress" : t.status,
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
        todos: z
          .array(TodoSchema)
          .describe("List of todo items to update"),
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
  });
}
