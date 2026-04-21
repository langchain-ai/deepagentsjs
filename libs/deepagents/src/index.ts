/**
 * Deep Agents TypeScript Implementation
 *
 * A TypeScript port of the Python Deep Agents library for building controllable AI agents with LangGraph.
 * This implementation maintains 1:1 compatibility with the Python version.
 */

export { createDeepAgent } from "./agent.js";
export { ConfigurationError, type ConfigurationErrorCode } from "./errors.js";

export { createSubagentTransformer } from "./stream.js";
export type { DeepAgentRunStream, SubagentRunStream } from "./stream.js";
export type {
  AnySubAgent,
  CreateDeepAgentParams,
  MergedDeepAgentState,
  // DeepAgent type bag and helper types
  DeepAgent,
  DeepAgentTypeConfig,
  DefaultDeepAgentTypeConfig,
  ResolveDeepAgentTypeConfig,
  InferDeepAgentType,
  InferDeepAgentSubagents,
  InferSubagentByName,
  InferSubagentReactAgentType,
  // Subagent middleware extraction types
  ExtractSubAgentMiddleware,
  FlattenSubAgentMiddleware,
  InferSubAgentMiddlewareStates,
  // Response format type utilities
  SupportedResponseFormat,
  InferStructuredResponse,
} from "./types.js";

// Export config
export {
  createSettings,
  findProjectRoot,
  type Settings,
  type SettingsOptions,
} from "./config.js";

// Export permissions
export {
  type FilesystemPermission,
  type FilesystemOperation,
  type PermissionMode,
} from "./permissions/index.js";

// Export middleware (matches Python's interface)
export {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  createSummarizationMiddleware,
  computeSummarizationDefaults,
  createMemoryMiddleware,
  createAsyncSubAgentMiddleware,
  isAsyncSubAgent,
  // Skills middleware - matches Python's SkillsMiddleware interface
  createSkillsMiddleware,
  type SkillsMiddlewareOptions,
  type SkillMetadata,
  // Skills constants
  MAX_SKILL_FILE_SIZE,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  // Subagent constants for building custom configurations
  GENERAL_PURPOSE_SUBAGENT,
  DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
  DEFAULT_SUBAGENT_PROMPT,
  TASK_SYSTEM_PROMPT,
  // Completion callback middleware for async subagents
  createCompletionCallbackMiddleware,
  type CompletionCallbackOptions,
  // Other middleware types
  type FilesystemMiddlewareOptions,
  type SubAgentMiddlewareOptions,
  type MemoryMiddlewareOptions,
  type SubAgent,
  type CompiledSubAgent,
  type AsyncSubAgentMiddlewareOptions,
  type AsyncSubAgent,
  type AsyncTask,
  type AsyncTaskStatus,
} from "./middleware/index.js";

// Export shared state values (similar to LangGraph's messagesValue pattern)
export { filesValue } from "./values.js";

// Export agent memory middleware
export {
  createAgentMemoryMiddleware,
  type AgentMemoryMiddlewareOptions,
} from "./middleware/agent-memory.js";

// Export skills loader (utility functions for direct filesystem access)
export {
  listSkills,
  parseSkillMetadata,
  type SkillMetadata as LoaderSkillMetadata,
  type ListSkillsOptions,
} from "./skills/index.js";

// Export backends
export {
  StateBackend,
  StoreBackend,
  type StoreBackendContext,
  type StoreBackendNamespaceFactory,
  type StoreBackendOptions,
  FilesystemBackend,
  CompositeBackend,
  BaseSandbox,
  isSandboxBackend,
  isSandboxProtocol,
  SandboxError,
  type AnyBackendProtocol,
  type BackendProtocol,
  type BackendProtocolV1,
  type BackendProtocolV2,
  type BackendFactory,
  type BackendRuntime,
  resolveBackend,
  type FileInfo,
  type GrepMatch,
  type GlobResult,
  type GrepResult,
  type LsResult,
  type ReadResult,
  type ReadRawResult,
  type WriteResult,
  type EditResult,
  // Sandbox execution types
  type ExecuteResponse,
  type FileData,
  type FileOperationError,
  type FileDownloadResponse,
  type FileUploadResponse,
  type SandboxBackendProtocol,
  type SandboxBackendProtocolV1,
  type SandboxBackendProtocolV2,
  type StateAndStore,
  type MaybePromise,
  // Sandbox provider types
  type SandboxInfo,
  type SandboxListResponse,
  type SandboxListOptions,
  type SandboxGetOrCreateOptions,
  type SandboxDeleteOptions,
  // LangSmith sandbox backend
  LangSmithSandbox,
  type LangSmithSandboxOptions,
  type LangSmithSandboxCreateOptions,
  type LangSmithSnapshot,
  type LangSmithCaptureSnapshotOptions,
  type LangSmithStartSandboxOptions,
  // Sandbox error types
  type SandboxErrorCode,
  // Local shell backend
  LocalShellBackend,
  type LocalShellBackendOptions,
  // Backend protocol adapters (v1 -> v2)
  adaptBackendProtocol,
  adaptSandboxProtocol,
} from "./backends/index.js";
