import {
  createMiddleware,
  ToolMessage,
  AIMessage,
  /**
   * required for type inference
   */
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { RemoveMessage, type BaseMessage } from "@langchain/core/messages";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";

/**
 * Patch dangling tool calls in a messages array.
 * Returns the patched messages array and a flag indicating if patching was needed.
 *
 * @param messages - The messages array to patch
 * @returns Object with patched messages and needsPatch flag
 */
export function patchDanglingToolCalls(messages: BaseMessage[]): {
  patchedMessages: BaseMessage[];
  needsPatch: boolean;
} {
  if (!messages || messages.length === 0) {
    return { patchedMessages: [], needsPatch: false };
  }

  const patchedMessages: BaseMessage[] = [];
  let needsPatch = false;

  // Iterate over the messages and add any dangling tool calls
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    patchedMessages.push(msg);

    // Check if this is an AI message with tool calls
    if (AIMessage.isInstance(msg) && msg.tool_calls != null) {
      for (const toolCall of msg.tool_calls) {
        // Look for a corresponding ToolMessage in the messages after this one
        const correspondingToolMsg = messages
          .slice(i)
          .find(
            (m) => ToolMessage.isInstance(m) && m.tool_call_id === toolCall.id,
          );

        if (!correspondingToolMsg) {
          // We have a dangling tool call which needs a ToolMessage
          needsPatch = true;
          const toolMsg = `Tool call ${toolCall.name} with id ${toolCall.id} was cancelled - another message came in before it could be completed.`;
          patchedMessages.push(
            new ToolMessage({
              content: toolMsg,
              name: toolCall.name,
              tool_call_id: toolCall.id!,
            }),
          );
        }
      }
    }
  }

  return { patchedMessages, needsPatch };
}

/**
 * Create middleware that patches dangling tool calls in the messages history.
 *
 * When an AI message contains tool_calls but subsequent messages don't include
 * the corresponding ToolMessage responses, this middleware adds synthetic
 * ToolMessages saying the tool call was cancelled.
 *
 * This middleware patches in two places:
 * 1. `beforeAgent`: Patches state at the start of the agent loop (handles most cases)
 * 2. `wrapModelCall`: Patches the request right before model invocation (handles
 *    edge cases like HITL rejection during graph resume where state updates from
 *    beforeAgent may not be applied in time)
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
    beforeAgent: async (state) => {
      const messages = state.messages;

      if (!messages || messages.length === 0) {
        return;
      }

      const { patchedMessages, needsPatch } = patchDanglingToolCalls(messages);

      /**
       * Only trigger REMOVE_ALL_MESSAGES if patching is actually needed
       */
      if (!needsPatch) {
        return;
      }

      // Return state update with RemoveMessage followed by patched messages
      return {
        messages: [
          new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
          ...patchedMessages,
        ],
      };
    },

    /**
     * Also patch in wrapModelCall as a safety net.
     * This handles edge cases where:
     * - HITL rejects a tool call during graph resume
     * - The state update from beforeAgent might not be applied in time
     * - The model would otherwise receive dangling tool_call_ids
     */
    wrapModelCall: async (request, handler) => {
      const messages = request.messages;

      if (!messages || messages.length === 0) {
        return handler(request);
      }

      const { patchedMessages, needsPatch } = patchDanglingToolCalls(messages);

      if (!needsPatch) {
        return handler(request);
      }

      // Pass patched messages to the model
      return handler({
        ...request,
        messages: patchedMessages,
      });
    },
  });
}
