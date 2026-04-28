import { createMiddleware, ToolMessage } from "langchain";
import { isGraphInterrupt } from "@langchain/langgraph";

/**
 * Responsible for catching exceptions thrown inside tool functions and
 * converting them to a ToolMessage with status "error" instead of crashing
 * the LangGraph superstep.
 *
 * NodeInterrupt and aborted AbortSignal errors are always re-thrown so that
 * interrupt and cancellation flows continue to work correctly.
 */
export function createToolErrorHandlerMiddleware() {
  return createMiddleware({
    name: "ToolErrorHandlerMiddleware",
    wrapToolCall: async (request, handler) => {
      const signal = request.runtime?.signal;
      try {
        return await handler(request);
      } catch (error) {
        if (isGraphInterrupt(error)) throw error;
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return new ToolMessage({
          content: `Error: ${message}`,
          tool_call_id: request.toolCall.id ?? "",
          name: request.toolCall.name,
          status: "error",
        });
      }
    },
  });
}
