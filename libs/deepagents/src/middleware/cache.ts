import { createMiddleware, SystemMessage } from "langchain";

/**
 * Import langchain for type inference
 */
import type * as _langchain from "langchain";

/**
 * Creates a middleware that places a cache breakpoint at the end of the static
 * system prompt content.
 *
 * This middleware tags the last block of the system message with
 * `cache_control: { type: "ephemeral" }` at the time it runs, capturing all
 * static content injected by preceding middleware (e.g. todo list instructions,
 * filesystem tools, subagent instructions) in a single cache breakpoint.
 *
 * This should run after all static system prompt middleware and before any
 * dynamic middleware (e.g. memory) so the breakpoint sits at the boundary
 * between stable and changing content.
 *
 * When used alongside memory middleware (which adds its own breakpoint on the
 * memory block), the result is two separate cache breakpoints:
 * - One covering all static content
 * - One covering the memory block
 *
 * This is a no-op when the system message has no content blocks.
 */
export function createCacheBreakpointMiddleware() {
  return createMiddleware({
    name: "CacheBreakpointMiddleware",

    wrapModelCall(request, handler) {
      const existingContent = request.systemMessage.content;
      const existingBlocks =
        typeof existingContent === "string"
          ? [{ type: "text" as const, text: existingContent }]
          : Array.isArray(existingContent)
            ? [...existingContent]
            : [];

      if (existingBlocks.length === 0) return handler(request);

      existingBlocks[existingBlocks.length - 1] = {
        ...existingBlocks[existingBlocks.length - 1],
        cache_control: { type: "ephemeral" },
      };

      return handler({
        ...request,
        systemMessage: new SystemMessage({ content: existingBlocks }),
      });
    },
  });
}
