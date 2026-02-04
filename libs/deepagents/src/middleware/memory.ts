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
  SystemMessage,
  /**
   * required for type inference
   */
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";

import type { BackendProtocol, BackendFactory } from "../backends/protocol.js";
import type { StateBackend } from "../backends/state.js";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
import { filesValue } from "../values.js";
import { StateSchema } from "@langchain/langgraph";

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
const MemoryStateSchema = new StateSchema({
  /**
   * Dict mapping source paths to their loaded content.
   * Marked as private so it's not included in the final agent state.
   */
  memoryContents: z.record(z.string(), z.string()).optional(),
  files: filesValue,
});

/**
 * Default system prompt template for memory.
 * Ported from Python's comprehensive memory guidelines.
 */
const MEMORY_SYSTEM_PROMPT = `<agent_memory>
{memory_contents}
</agent_memory>

<memory_guidelines>
    The above <agent_memory> was loaded in from files in your filesystem. As you learn from your interactions with the user, you can save new knowledge by calling the \`edit_file\` tool.

    **Learning from feedback:**
    - One of your MAIN PRIORITIES is to learn from your interactions with the user. These learnings can be implicit or explicit. This means that in the future, you will remember this important information.
    - When you need to remember something, updating memory must be your FIRST, IMMEDIATE action - before responding to the user, before calling other tools, before doing anything else. Just update memory immediately.
    - When user says something is better/worse, capture WHY and encode it as a pattern.
    - Each correction is a chance to improve permanently - don't just fix the immediate issue, update your instructions.
    - A great opportunity to update your memories is when the user interrupts a tool call and provides feedback. You should update your memories immediately before revising the tool call.
    - Look for the underlying principle behind corrections, not just the specific mistake.
    - The user might not explicitly ask you to remember something, but if they provide information that is useful for future use, you should update your memories immediately.

    **Asking for information:**
    - If you lack context to perform an action (e.g. send a Slack DM, requires a user ID/email) you should explicitly ask the user for this information.
    - It is preferred for you to ask for information, don't assume anything that you do not know!
    - When the user provides information that is useful for future use, you should update your memories immediately.

    **When to update memories:**
    - When the user explicitly asks you to remember something (e.g., "remember my email", "save this preference")
    - When the user describes your role or how you should behave (e.g., "you are a web researcher", "always do X")
    - When the user gives feedback on your work - capture what was wrong and how to improve
    - When the user provides information required for tool use (e.g., slack channel ID, email addresses)
    - When the user provides context useful for future tasks, such as how to use tools, or which actions to take in a particular situation
    - When you discover new patterns or preferences (coding styles, conventions, workflows)

    **When to NOT update memories:**
    - When the information is temporary or transient (e.g., "I'm running late", "I'm on my phone right now")
    - When the information is a one-time task request (e.g., "Find me a recipe", "What's 25 * 4?")
    - When the information is a simple question that doesn't reveal lasting preferences (e.g., "What day is it?", "Can you explain X?")
    - When the information is an acknowledgment or small talk (e.g., "Sounds good!", "Hello", "Thanks for that")
    - When the information is stale or irrelevant in future conversations
    - Never store API keys, access tokens, passwords, or any other credentials in any file, memory, or system prompt.
    - If the user asks where to put API keys or provides an API key, do NOT echo or save it.

    **Examples:**
    Example 1 (remembering user information):
    User: Can you connect to my google account?
    Agent: Sure, I'll connect to your google account, what's your google account email?
    User: john@example.com
    Agent: Let me save this to my memory.
    Tool Call: edit_file(...) -> remembers that the user's google account email is john@example.com

    Example 2 (remembering implicit user preferences):
    User: Can you write me an example for creating a deep agent in LangChain?
    Agent: Sure, I'll write you an example for creating a deep agent in LangChain <example code in Python>
    User: Can you do this in JavaScript
    Agent: Let me save this to my memory.
    Tool Call: edit_file(...) -> remembers that the user prefers to get LangChain code examples in JavaScript
    Agent: Sure, here is the JavaScript example<example code in JavaScript>

    Example 3 (do not remember transient information):
    User: I'm going to play basketball tonight so I will be offline for a few hours.
    Agent: Okay I'll add a block to your calendar.
    Tool Call: create_calendar_event(...) -> just calls a tool, does not commit anything to memory, as it is transient information
</memory_guidelines>`;

/**
 * Format loaded memory contents for injection into prompt.
 * Pairs memory locations with their contents for clarity.
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
      sections.push(`${path}\n${contents[path]}`);
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
  // Use downloadFiles if available, otherwise fall back to read
  if (!backend.downloadFiles) {
    const content = await backend.read(path);
    if (content.startsWith("Error:")) {
      return null;
    }
    return content;
  }

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
      const formattedContents = formatMemoryContents(memoryContents, sources);

      const memorySection = MEMORY_SYSTEM_PROMPT.replace(
        "{memory_contents}",
        formattedContents,
      );

      // Concat memory section to system prompt
      const memoryMessage = new SystemMessage(memorySection);
      const newSystemMessage = memoryMessage.concat(request.systemMessage);

      return handler({
        ...request,
        systemMessage: newSystemMessage,
      });
    },
  });
}
