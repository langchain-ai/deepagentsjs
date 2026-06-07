/**
 * Browser-safe Deep Agents entrypoint.
 *
 * Excludes Node.js-only APIs:
 * - config helpers (`createSettings`, `findProjectRoot`)
 * - filesystem-backed skills loader (`listSkills`, `parseSkillMetadata`)
 * - agent-memory middleware (`createAgentMemoryMiddleware`)
 * - Node-specific backends (`FilesystemBackend`, `LocalShellBackend`)
 */

export { createDeepAgent } from "./agent.js";
export { ConfigurationError, type ConfigurationErrorCode } from "./errors.js";

// Export harness profiles
export {
  type HarnessProfile,
  type HarnessProfileOptions,
  type HarnessProfileConfigData,
  type GeneralPurposeSubagentConfig,
  createHarnessProfile,
  serializeProfile,
  parseHarnessProfileConfig,
  registerHarnessProfile,
  getHarnessProfile,
  harnessProfileConfigSchema,
  generalPurposeSubagentConfigSchema,
  EMPTY_HARNESS_PROFILE,
  REQUIRED_MIDDLEWARE_NAMES,
} from "./profiles/index.js";

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

// Export browser-safe backends
export type {
  AnyBackendProtocol,
  BackendProtocol,
  BackendProtocolV1,
  BackendProtocolV2,
  BackendFactory,
  BackendRuntime,
  FileData,
  FileInfo,
  GrepMatch,
  ReadResult,
  ReadRawResult,
  GrepResult,
  LsResult,
  GlobResult,
  WriteResult,
  EditResult,
  StateAndStore,
  // Sandbox execution types
  ExecuteResponse,
  FileOperationError,
  FileDownloadResponse,
  FileUploadResponse,
  SandboxBackendProtocol,
  SandboxBackendProtocolV1,
  SandboxBackendProtocolV2,
  MaybePromise,
  // Sandbox provider types
  SandboxInfo,
  SandboxListResponse,
  SandboxListOptions,
  SandboxGetOrCreateOptions,
  SandboxDeleteOptions,
  // Sandbox error types
  SandboxErrorCode,
} from "./backends/protocol.js";

export {
  isSandboxBackend,
  isSandboxProtocol,
  SandboxError,
  resolveBackend,
} from "./backends/protocol.js";

export { StateBackend } from "./backends/state.js";
export {
  StoreBackend,
  type StoreBackendContext,
  type StoreBackendNamespaceFactory,
  type StoreBackendOptions,
} from "./backends/store.js";
export { CompositeBackend } from "./backends/composite.js";
export { ContextHubBackend } from "./backends/context-hub.js";
export { BaseSandbox } from "./backends/sandbox.js";
export {
  LangSmithSandbox,
  type LangSmithSandboxOptions,
  type LangSmithSandboxCreateOptions,
} from "./backends/langsmith.js";
export type {
  Snapshot as LangSmithSnapshot,
  CaptureSnapshotOptions as LangSmithCaptureSnapshotOptions,
  StartSandboxOptions as LangSmithStartSandboxOptions,
} from "langsmith/experimental/sandbox";
export {
  adaptBackendProtocol,
  adaptSandboxProtocol,
} from "./backends/utils.js";
