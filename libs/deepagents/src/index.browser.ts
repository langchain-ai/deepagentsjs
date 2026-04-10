/**
 * Browser entry point for Deep Agents.
 *
 * Exports everything needed to run createDeepAgent() in the browser with a
 * SandboxBackendProtocol implementation (e.g. wasmsh BrowserSandbox).
 *
 * All middleware (filesystem tools, skills, memory, subagents, summarization)
 * works through the BackendProtocol — the sandbox provides execute(), read(),
 * write(), edit(), lsInfo(), grepRaw(), globInfo() in the browser.
 *
 * Excludes only modules that use Node.js APIs directly (not through protocol):
 * - config.ts (scans local .git dirs with fs/path/os)
 * - middleware/agent-memory.ts (reads agent.md from disk with node:fs)
 * - skills/loader.ts (scans local dirs for SKILL.md with node:fs)
 * - backends/filesystem.ts (Node.js filesystem backend)
 * - backends/local-shell.ts (Node.js shell backend)
 * - backends/langsmith.ts (LangSmith sandbox)
 */

export { createDeepAgent } from "./agent.js";
export { ConfigurationError, type ConfigurationErrorCode } from "./errors.js";
export type {
  CreateDeepAgentParams,
  MergedDeepAgentState,
  DeepAgent,
  DeepAgentTypeConfig,
  DefaultDeepAgentTypeConfig,
  ResolveDeepAgentTypeConfig,
  InferDeepAgentType,
  InferDeepAgentSubagents,
  InferSubagentByName,
  InferSubagentReactAgentType,
  ExtractSubAgentMiddleware,
  FlattenSubAgentMiddleware,
  InferSubAgentMiddlewareStates,
  SupportedResponseFormat,
  InferStructuredResponse,
} from "./types.js";

// Middleware — all work through BackendProtocol, browser-safe
export {
  createFilesystemMiddleware,
  createSubAgentMiddleware,
  createPatchToolCallsMiddleware,
  createSummarizationMiddleware,
  computeSummarizationDefaults,
  createMemoryMiddleware,
  createSkillsMiddleware,
  type SkillsMiddlewareOptions,
  type SkillMetadata,
  MAX_SKILL_FILE_SIZE,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  GENERAL_PURPOSE_SUBAGENT,
  DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
  DEFAULT_SUBAGENT_PROMPT,
  TASK_SYSTEM_PROMPT,
  type FilesystemMiddlewareOptions,
  type SubAgentMiddlewareOptions,
  type MemoryMiddlewareOptions,
  type SubAgent,
  type CompiledSubAgent,
} from "./middleware/index.js";

export { filesValue } from "./values.js";

// Browser-safe backends (no FilesystemBackend, LocalShellBackend, LangSmithSandbox)
export {
  StateBackend,
  StoreBackend,
  type StoreBackendOptions,
  CompositeBackend,
  BaseSandbox,
  isSandboxBackend,
  SandboxError,
  type BackendProtocol,
  type BackendFactory,
  type BackendRuntime,
  resolveBackend,
  type FileInfo,
  type GrepMatch,
  type WriteResult,
  type EditResult,
  type ExecuteResponse,
  type FileData,
  type FileOperationError,
  type FileDownloadResponse,
  type FileUploadResponse,
  type SandboxBackendProtocol,
  type StateAndStore,
  type MaybePromise,
  type SandboxInfo,
  type SandboxListResponse,
  type SandboxListOptions,
  type SandboxGetOrCreateOptions,
  type SandboxDeleteOptions,
  type SandboxErrorCode,
} from "./backends/index.browser.js";
