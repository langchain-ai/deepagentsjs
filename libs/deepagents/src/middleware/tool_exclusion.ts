import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware, type AgentMiddleware } from "langchain";

function hasToolName(tool: unknown): tool is { name: string } {
  return (
    tool !== null &&
    typeof tool === "object" &&
    "name" in tool &&
    typeof tool.name === "string"
  );
}

/**
 * Create middleware that hides excluded tools from the model and rejects calls
 * to them. Exclusions calibrate the agent per model; they are not a security
 * boundary.
 *
 * @internal
 */
export function createToolExclusionMiddleware(
  excludedTools: ReadonlySet<string>,
): AgentMiddleware {
  return createMiddleware({
    name: "_ToolExclusionMiddleware",
    wrapModelCall(request, handler) {
      return handler({
        ...request,
        tools: request.tools?.filter(
          (tool) => !hasToolName(tool) || !excludedTools.has(tool.name),
        ),
      });
    },
    wrapToolCall(request, handler) {
      const { name, id } = request.toolCall;
      if (!excludedTools.has(name)) {
        return handler(request);
      }
      return new ToolMessage({
        content: `Error: ${name} is not available.`,
        tool_call_id: id ?? "",
        name,
        status: "error",
      });
    },
  });
}
