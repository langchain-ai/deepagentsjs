import {
  createMiddleware,
  ToolMessage,
  AIMessage,
  /**
   * required for type inference
   */
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import type { BaseMessage } from "@langchain/core/messages";
import { RemoveMessage } from "@langchain/core/messages";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";

/**
 * Patches dangling tool calls in a messages array.
 *
 * Adds synthetic ToolMessages for any tool_calls that don't have corresponding responses,
 * BUT only for AIMessages where at least one of their tool_calls already has a response.
 * This distinguishes between:
 * - Normal flow: AIMessage has tool_calls, none have responses yet (tools are executing)
 * - HITL rejection: AIMessage has tool_calls, SOME have responses (partial rejection)
 *
 * @param messages - The messages array to patch
 * @returns The patched messages array, or the original if no changes needed
 */
export function patchDanglingToolCalls(messages: BaseMessage[]): BaseMessage[] {
  if (!messages || messages.length === 0) {
    return messages;
  }

  // Track all existing tool_call_ids that have responses
  const existingToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (ToolMessage.isInstance(msg) && msg.tool_call_id) {
      existingToolCallIds.add(msg.tool_call_id);
    }
  }

  // Build a new messages array with synthetic ToolMessages inserted
  // in the correct position (right after their corresponding AIMessage)
  const patchedMessages: BaseMessage[] = [];
  let hasChanges = false;

  for (const msg of messages) {
    patchedMessages.push(msg);

    // Check if this is an AI message with tool calls
    if (AIMessage.isInstance(msg) && msg.tool_calls != null && msg.tool_calls.length > 0) {
      // Check if at least one of THIS AIMessage's tool_calls has a response
      // This indicates partial execution/rejection - the HITL rejection scenario
      const hasPartialResponse = msg.tool_calls.some(
        (tc) => tc.id && existingToolCallIds.has(tc.id),
      );

      // Only patch if there's a partial response (some responded, some didn't)
      // This avoids patching during normal flow where tools are still executing
      if (hasPartialResponse) {
        for (const toolCall of msg.tool_calls) {
          // If this tool call doesn't have a corresponding ToolMessage, add synthetic one
          if (toolCall.id && !existingToolCallIds.has(toolCall.id)) {
            const toolMsg = `Tool call ${toolCall.name} with id ${toolCall.id} was cancelled - another message came in before it could be completed.`;
            patchedMessages.push(
              new ToolMessage({
                content: toolMsg,
                name: toolCall.name,
                tool_call_id: toolCall.id,
              }),
            );
            // Mark as handled to avoid duplicates if we see the same tool_call_id again
            existingToolCallIds.add(toolCall.id);
            hasChanges = true;
          }
        }
      }
    }
  }

  return hasChanges ? patchedMessages : messages;
}

/**
 * Create middleware that patches dangling tool calls in the messages history.
 *
 * When an AI message contains tool_calls but subsequent messages don't include
 * the corresponding ToolMessage responses, this middleware adds synthetic
 * ToolMessages saying the tool call was cancelled.
 *
 * This is critical for handling interrupted tool calls, especially when:
 * - Multiple tools are called in parallel
 * - One tool is interrupted via interruptOn
 * - The user rejects the interrupted tool call
 *
 * Without this middleware, the provider would throw errors like:
 * "An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'."
 *
 * This middleware uses `beforeAgent` hook with `REMOVE_ALL_MESSAGES` to fully
 * replace the messages state, matching Python's `Overwrite` behavior.
 *
 * @returns AgentMiddleware that patches dangling tool calls
 *
 * @example
 * ```typescript
 * import { createAgent } from "langchain";
 * import { createPatchToolCallsMiddleware } from "./middleware/patch_tool_calls";
 *
 * const agent = createAgent({
 *   model: "claude-sonnet-4-5-20250929",
 *   middleware: [createPatchToolCallsMiddleware()],
 * });
 * ```
 */
export function createPatchToolCallsMiddleware() {
  return createMiddleware({
    name: "patchToolCallsMiddleware",
    // beforeAgent runs once per invocation (including resume invocations)
    // Using REMOVE_ALL_MESSAGES tells the reducer to replace all messages
    // with our patched version, matching Python's Overwrite behavior
    beforeAgent: (state) => {
      if (!state.messages || state.messages.length === 0) {
        return;
      }

      const patchedMessages = patchDanglingToolCalls(state.messages);
      if (patchedMessages !== state.messages) {
        return {
          messages: [
            new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
            ...patchedMessages,
          ],
        };
      }
      return;
    },
    // beforeModel runs before each model call - might catch resumed execution
    beforeModel: (state) => {
      if (!state.messages || state.messages.length === 0) {
        return;
      }

      const patchedMessages = patchDanglingToolCalls(state.messages);
      if (patchedMessages !== state.messages) {
        return {
          messages: [
            new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
            ...patchedMessages,
          ],
        };
      }
      return;
    },
    // wrapModelCall wraps the actual model invocation - runs when HITL jumps to model
    wrapModelCall: (request, handler) => {
      if (request.messages && request.messages.length > 0) {
        const patchedMessages = patchDanglingToolCalls(request.messages);
        if (patchedMessages !== request.messages) {
          return handler({ ...request, messages: patchedMessages });
        }
      }
      return handler(request);
    },
    // afterModel runs after the model call - persist synthetic messages to state
    afterModel: (state) => {
      if (!state.messages || state.messages.length === 0) {
        return;
      }

      const patchedMessages = patchDanglingToolCalls(state.messages);
      if (patchedMessages !== state.messages) {
        return {
          messages: [
            new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
            ...patchedMessages,
          ],
        };
      }
      return;
    },
  });
}
