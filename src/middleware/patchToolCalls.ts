/**
 * Middleware to patch dangling tool calls in the messages history.
 */

import { createMiddleware, ToolMessage, AIMessage } from "langchain";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { RemoveMessage } from "@langchain/core/messages";

/**
 * Middleware to patch dangling tool calls in the messages history.
 */
export const patchToolCallsMiddleware = createMiddleware({
  name: "patchToolCallsMiddleware",
  async beforeAgent(state) {
    const messages = state.messages;
    if (!messages || messages.length === 0) return undefined;

    const patched_messages = [];
    // Iterate over the messages and add any dangling tool calls
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      patched_messages.push(msg);

      if (AIMessage.isInstance(msg) && msg.tool_calls != null) {
        for (const tool_call of msg.tool_calls) {
          if (!tool_call.id) continue;

          const corresponding_tool_msg = messages
            .slice(i)
            .find(
              (m) =>
                ToolMessage.isInstance(m) && m.tool_call_id === tool_call.id
            );

          if (!corresponding_tool_msg) {
            // We have a dangling tool call which needs a ToolMessage
            const tool_msg =
              `Tool call ${tool_call.name} with id ${tool_call.id} was ` +
              "cancelled - another message came in before it could be completed.";

            patched_messages.push(
              new ToolMessage({
                content: tool_msg,
                name: tool_call.name,
                tool_call_id: tool_call.id,
              })
            );
          }
        }
      }
    }

    return {
      messages: [
        new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
        ...patched_messages,
      ],
    };
  },
});
