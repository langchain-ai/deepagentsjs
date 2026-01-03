/**
 * Deep Agents TypeScript Implementation
 *
 * A TypeScript port of the Python Deep Agents library for building controllable AI agents with LangGraph.
 * This implementation maintains 1:1 compatibility with the Python version.
 */

export { createDeepAgent, type CreateDeepAgentParams } from "./agent.js";

// Export config
export {
  createSettings,
  findProjectRoot,
  type Settings,
  type SettingsOptions,
} from "./config.js";

// Export middleware
export {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  type FilesystemMiddlewareOptions,
  type SubAgentMiddlewareOptions,
  type SubAgent,
  type CompiledSubAgent,
  type FileData,
} from "./middleware/index.js";

// Export skills middleware
export {
  createSkillsMiddleware,
  type SkillsMiddlewareOptions,
} from "./middleware/skills.js";

// Export agent memory middleware
export {
  createAgentMemoryMiddleware,
  type AgentMemoryMiddlewareOptions,
} from "./middleware/agent-memory.js";

// Export skills loader
export {
  listSkills,
  parseSkillMetadata,
  MAX_SKILL_FILE_SIZE,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  type SkillMetadata,
  type ListSkillsOptions,
} from "./skills/index.js";

// Export backends
export {
  StateBackend,
  StoreBackend,
  FilesystemBackend,
  CompositeBackend,
  BaseSandbox,
  isSandboxBackend,
  type BackendProtocol,
  type BackendFactory,
  type FileInfo,
  type GrepMatch,
  type WriteResult,
  type EditResult,
  // Sandbox execution types
  type ExecuteResponse,
  type FileOperationError,
  type FileDownloadResponse,
  type FileUploadResponse,
  type SandboxBackendProtocol,
  type MaybePromise,
} from "./backends/index.js";
