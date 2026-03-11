import { tool } from "langchain";
import { z } from "zod";

import type { SessionHandle, ObserveAgentInput, SteerAgentInput } from "./types.js";

export function createObserveTool(session: SessionHandle) {
  return tool(
    async (input: ObserveAgentInput) => {
      const { focus, scope, after, limit, threadId } = input;

      const [snapshot, eventPage] = await Promise.all([
        session.getSnapshot({ scope }),
        session.getEvents({ after, limit, threadId }),
      ]);

      return JSON.stringify({
        focus: focus ?? null,
        snapshot,
        events: eventPage.events,
        nextCursor: eventPage.nextCursor ?? null,
      });
    },
    {
      name: "observe_agent",
      description:
        "Retrieve the current state of the running coding agent, including " +
        "session snapshot, thread status, recent messages, tool calls, todos, " +
        "files being worked on, and cross-thread activity events. Use this " +
        "tool whenever the user asks about what the agent is doing.",
      schema: z.object({
        focus: z
          .string()
          .optional()
          .describe("Optional focus area to highlight in the response"),
        scope: z
          .enum(["active", "root", "all"])
          .optional()
          .describe("Which threads to include in the snapshot. Defaults to all."),
        after: z
          .string()
          .optional()
          .describe("Cursor for pagination — return events after this cursor"),
        limit: z
          .number()
          .optional()
          .describe("Maximum number of events to return"),
        threadId: z
          .string()
          .optional()
          .describe("Filter events to a specific thread"),
      }),
    },
  );
}

export function createSteerTool(session: SessionHandle) {
  return tool(
    async (input: SteerAgentInput) => {
      const { kind, target, payload } = input;

      const result = await session.send({
        kind,
        target: target ?? "active",
        createdBy: "companion",
        payload,
      });

      return JSON.stringify({
        commandId: result.commandId,
        status: result.status,
      });
    },
    {
      name: "steer_agent",
      description:
        "Queue a lightweight steering command for the running agent. " +
        "Supported commands: message, reminder, add_todo, update_todo, " +
        "set_guidance. Commands are queued and applied at the next safe " +
        "reasoning boundary — they are not immediate.",
      schema: z.object({
        kind: z
          .enum(["message", "reminder", "add_todo", "update_todo", "set_guidance"])
          .describe("The type of steering command to send"),
        target: z
          .union([
            z.enum(["root", "active", "all"]),
            z.object({ threadId: z.string() }),
          ])
          .optional()
          .describe("Which thread(s) should receive the command. Defaults to active."),
        payload: z
          .record(z.string(), z.any())
          .describe("Command payload — structure depends on the kind"),
      }),
    },
  );
}
