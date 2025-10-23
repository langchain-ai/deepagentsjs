/**
 * Deep Agents TypeScript Implementation
 *
 * A TypeScript port of the Python Deep Agents library for building controllable AI agents with LangGraph.
 * This implementation maintains 1:1 compatibility with the Python version.
 */

export { createDeepAgent, type CreateDeepAgentParams } from "./agent.js";

// Export middleware
export {
  createFilesystemMiddleware,
  FilesystemMiddleware,
  createSubAgentMiddleware,
  SubAgentMiddleware,
  createPatchToolCallsMiddleware,
  type FilesystemMiddlewareOptions,
  type SubAgentMiddlewareOptions,
  type SubAgent,
  type CompiledSubAgent,
  type FileData,
} from "./middleware/index.js";
