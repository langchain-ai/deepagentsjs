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
 * Patch tool call / tool response parity in a messages array.
 *
 * Ensures strict 1:1 correspondence between AIMessage tool_calls and
 * ToolMessage responses:
 *
 * 1. **Dangling tool_calls** — an AIMessage contains a tool_call with no
 *    matching ToolMessage anywhere after it. A synthetic cancellation
 *    ToolMessage is inserted immediately after the AIMessage.
 *
 * 2. **Orphaned ToolMessages** — a ToolMessage whose `tool_call_id` does not
 *    match any tool_call in a preceding AIMessage. The ToolMessage is removed.
 *
 * Both directions are required for providers that enforce strict parity
 * (e.g. Google Gemini returns 400 INVALID_ARGUMENT otherwise).
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

  const allToolCallIds = new Set<string>();
  const answeredIds = new Set<string>();
  for (const msg of messages) {
    if (AIMessage.isInstance(msg) && msg.tool_calls != null) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          allToolCallIds.add(tc.id);
        }
      }
    } else if (ToolMessage.isInstance(msg)) {
      answeredIds.add(msg.tool_call_id);
    }
  }

  let needsAnyPatch = false;
  for (const id of answeredIds) {
    if (!allToolCallIds.has(id)) {
      needsAnyPatch = true;
      break;
    }
  }
  if (!needsAnyPatch) {
    outer: for (const msg of messages) {
      if (AIMessage.isInstance(msg) && msg.tool_calls != null) {
        for (const tc of msg.tool_calls) {
          if (tc.id && !answeredIds.has(tc.id)) {
            needsAnyPatch = true;
            break outer;
          }
        }
      }
    }
  }

  if (!needsAnyPatch) {
    return { patchedMessages: messages, needsPatch: false };
  }

  const patchedMessages: BaseMessage[] = [];
  let needsPatch = false;

  for (const msg of messages) {
    if (ToolMessage.isInstance(msg) && !allToolCallIds.has(msg.tool_call_id)) {
      needsPatch = true;
      continue;
    }

    patchedMessages.push(msg);

    if (AIMessage.isInstance(msg) && msg.tool_calls != null) {
      for (const toolCall of msg.tool_calls) {
        if (toolCall.id && !answeredIds.has(toolCall.id)) {
          needsPatch = true;
          const toolMsg = `Tool call ${toolCall.name} with id ${toolCall.id} was cancelled - another message came in before it could be completed.`;
          patchedMessages.push(
            new ToolMessage({
              content: toolMsg,
              name: toolCall.name,
              tool_call_id: toolCall.id,
            }),
          );
        }
      }
    }
  }

  return { patchedMessages, needsPatch };
}

/**
 * Create middleware that enforces strict tool call / tool response parity in
 * the messages history.
 *
 * Two kinds of violations are repaired:
 * 1. **Dangling tool_calls** — an AIMessage contains tool_calls with no
 *    matching ToolMessage responses. Synthetic cancellation ToolMessages are
 *    injected so every tool_call has a response.
 * 2. **Orphaned ToolMessages** — a ToolMessage exists whose `tool_call_id`
 *    does not match any tool_call in a preceding AIMessage. These are removed.
 *
 * This is critical for providers like Google Gemini that reject requests with
 * mismatched function call / function response counts (400 INVALID_ARGUMENT).
 *
 * This middleware patches in two places:
 * 1. `beforeAgent`: Patches state at the start of the agent loop (handles most cases)
 * 2. `wrapModelCall`: Patches the request right before model invocation (handles
 *    edge cases like HITL rejection during graph resume where state updates from
 *    beforeAgent may not be applied in time)
 *
 * @returns AgentMiddleware that enforces tool call / response parity
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
