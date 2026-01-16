/**
 * Middleware for loading agent memory/context from AGENTS.md files.
 *
 * This module implements support for the AGENTS.md specification (https://agents.md/),
 * loading memory/context from configurable sources and injecting into the system prompt.
 *
 * ## Overview
 *
 * AGENTS.md files provide project-specific context and instructions to help AI agents
 * work effectively. Unlike skills (which are on-demand workflows), memory is always
 * loaded and provides persistent context.
 *
 * ## Usage
 *
 * ```typescript
 * import { createMemoryMiddleware } from "@anthropic/deepagents";
 * import { FilesystemBackend } from "@anthropic/deepagents";
 *
 * // Security: FilesystemBackend allows reading/writing from the entire filesystem.
 * // Either ensure the agent is running within a sandbox OR add human-in-the-loop (HIL)
 * // approval to file operations.
 * const backend = new FilesystemBackend({ rootDir: "/" });
 *
 * const middleware = createMemoryMiddleware({
 *   backend,
 *   sources: [
 *     "~/.deepagents/AGENTS.md",
 *     "./.deepagents/AGENTS.md",
 *   ],
 * });
 *
 * const agent = createDeepAgent({ middleware: [middleware] });
 * ```
 *
 * ## Memory Sources
 *
 * Sources are simply paths to AGENTS.md files that are loaded in order and combined.
 * Multiple sources are concatenated in order, with all content included.
 * Later sources appear after earlier ones in the combined prompt.
 *
 * ## File Format
 *
 * AGENTS.md files are standard Markdown with no required structure.
 * Common sections include:
 * - Project overview
 * - Build/test commands
 * - Code style guidelines
 * - Architecture notes
 */

import { z } from "zod";
import {
  createMiddleware,
  /**
   * required for type inference
   */
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";

import type { BackendProtocol, BackendFactory } from "../backends/protocol.js";
import type { StateBackend } from "../backends/state.js";
import type { BaseStore } from "@langchain/langgraph-checkpoint";

/**
 * Options for the memory middleware.
 */
export interface MemoryMiddlewareOptions {
  /**
   * Backend instance or factory function for file operations.
   * Use a factory for StateBackend since it requires runtime state.
   */
  backend:
    | BackendProtocol
    | BackendFactory
    | ((config: { state: unknown; store?: BaseStore }) => StateBackend);

  /**
   * List of memory file paths to load (e.g., ["~/.deepagents/AGENTS.md", "./.deepagents/AGENTS.md"]).
   * Display names are automatically derived from the paths.
   * Sources are loaded in order.
   */
  sources: string[];
}

/**
 * State schema for memory middleware.
 */
const MemoryStateSchema = z.object({
  /**
   * Dict mapping source paths to their loaded content.
   * Marked as private so it's not included in the final agent state.
   */
  memoryContents: z.record(z.string(), z.string()).optional(),
});

/**
 * Default system prompt template for memory.
 */
const MEMORY_SYSTEM_PROMPT = `
## Agent Memory

You have access to persistent memory that provides context and instructions.

{memory_locations}

{memory_contents}

**Memory Guidelines:**
- Memory content above provides project-specific context and instructions
- Follow any guidelines, conventions, or patterns described in memory
- Memory is read-only during this session (loaded at startup)
- If you need to update memory, use the appropriate file editing tools
`;

/**
 * Format memory source locations for display.
 */
function formatMemoryLocations(sources: string[]): string {
  if (sources.length === 0) {
    return "**Memory Sources:** None configured";
  }

  const lines = ["**Memory Sources:**"];
  for (const path of sources) {
    lines.push(`- \`${path}\``);
  }
  return lines.join("\n");
}

/**
 * Format loaded memory contents for injection into prompt.
 */
function formatMemoryContents(
  contents: Record<string, string>,
  sources: string[],
): string {
  if (Object.keys(contents).length === 0) {
    return "(No memory loaded)";
  }

  const sections: string[] = [];
  for (const path of sources) {
    if (contents[path]) {
      sections.push(contents[path]);
    }
  }

  if (sections.length === 0) {
    return "(No memory loaded)";
  }

  return sections.join("\n\n");
}

/**
 * Load memory content from a backend path.
 *
 * @param backend - Backend to load from.
 * @param path - Path to the AGENTS.md file.
 * @returns File content if found, null otherwise.
 */
async function loadMemoryFromBackend(
  backend: BackendProtocol,
  path: string,
): Promise<string | null> {
  const results = await backend.downloadFiles([path]);

  // Should get exactly one response for one path
  if (results.length !== 1) {
    throw new Error(
      `Expected 1 response for path ${path}, got ${results.length}`,
    );
  }
  const response = results[0];

  if (response.error != null) {
    // For now, memory files are treated as optional. file_not_found is expected
    // and we skip silently to allow graceful degradation.
    if (response.error === "file_not_found") {
      return null;
    }
    // Other errors should be raised
    throw new Error(`Failed to download ${path}: ${response.error}`);
  }

  if (response.content != null) {
    // Content is a Uint8Array, decode to string
    return new TextDecoder().decode(response.content);
  }

  return null;
}

/**
 * Create middleware for loading agent memory from AGENTS.md files.
 *
 * Loads memory content from configured sources and injects into the system prompt.
 * Supports multiple sources that are combined together.
 *
 * @param options - Configuration options
 * @returns AgentMiddleware for memory loading and injection
 *
 * @example
 * ```typescript
 * const middleware = createMemoryMiddleware({
 *   backend: new FilesystemBackend({ rootDir: "/" }),
 *   sources: [
 *     "~/.deepagents/AGENTS.md",
 *     "./.deepagents/AGENTS.md",
 *   ],
 * });
 * ```
 */
export function createMemoryMiddleware(options: MemoryMiddlewareOptions) {
  const { backend, sources } = options;

  /**
   * Resolve backend from instance or factory.
   */
  function getBackend(state: unknown): BackendProtocol {
    if (typeof backend === "function") {
      // It's a factory - call it with state
      return backend({ state }) as BackendProtocol;
    }
    return backend;
  }

  return createMiddleware({
    name: "MemoryMiddleware",
    stateSchema: MemoryStateSchema,

    async beforeAgent(state) {
      // Skip if already loaded
      if ("memoryContents" in state && state.memoryContents != null) {
        return undefined;
      }

      const resolvedBackend = getBackend(state);
      const contents: Record<string, string> = {};

      for (const path of sources) {
        try {
          const content = await loadMemoryFromBackend(resolvedBackend, path);
          if (content) {
            contents[path] = content;
          }
        } catch (error) {
          // Log but continue - memory is optional
          // eslint-disable-next-line no-console
          console.debug(`Failed to load memory from ${path}:`, error);
        }
      }

      return { memoryContents: contents };
    },

    wrapModelCall(request, handler) {
      // Get memory contents from state
      const memoryContents: Record<string, string> =
        request.state?.memoryContents || {};

      // Format memory section
      const memoryLocations = formatMemoryLocations(sources);
      const formattedContents = formatMemoryContents(memoryContents, sources);

      const memorySection = MEMORY_SYSTEM_PROMPT.replace(
        "{memory_locations}",
        memoryLocations,
      ).replace("{memory_contents}", formattedContents);

      // Prepend memory section to system prompt
      const currentSystemPrompt = request.systemPrompt || "";
      const newSystemPrompt = currentSystemPrompt
        ? `${memorySection}\n\n${currentSystemPrompt}`
        : memorySection;

      return handler({ ...request, systemPrompt: newSystemPrompt });
    },
  });
}
