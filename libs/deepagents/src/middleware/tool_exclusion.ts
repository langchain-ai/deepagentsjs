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
 * Create middleware that removes excluded tools after all tool-injecting
 * middleware has had a chance to add tools to the request.
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
  });
}
