/**
 * @langchain/langsmith-sandbox
 *
 * LangSmith Sandbox backend for deepagents.
 *
 * This package provides a LangSmith Sandbox implementation of the SandboxBackendProtocol,
 * enabling agents to execute commands, read/write files, and manage isolated sandbox
 * environments using LangSmith's Sandbox infrastructure.
 *
 * @example
 * ```typescript
 * import { LangSmithSandbox } from "@langchain/langsmith-sandbox";
 * import { createDeepAgent } from "deepagents";
 * import { ChatAnthropic } from "@langchain/anthropic";
 *
 * // Create and initialize a sandbox
 * const sandbox = await LangSmithSandbox.create({
 *   templateName: "default",
 * });
 *
 * try {
 *   const agent = createDeepAgent({
 *     model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *     systemPrompt: "You are a coding assistant with sandbox access.",
 *     backend: sandbox,
 *   });
 *
 *   const result = await agent.invoke({
 *     messages: [new HumanMessage("Create a hello world app")],
 *   });
 * } finally {
 *   await sandbox.close();
 * }
 * ```
 *
 * @packageDocumentation
 */

// Export main class
export { LangSmithSandbox } from "./sandbox.js";

// Export factory functions and types
export {
  createLangSmithSandboxFactory,
  createLangSmithSandboxFactoryFromSandbox,
  type AsyncLangSmithSandboxFactory,
} from "./sandbox.js";

// Export authentication utilities
export { getAuthApiKey, getAuthCredentials } from "./auth.js";
export type { LangSmithCredentials } from "./auth.js";

// Export types
export type {
  LangSmithSandboxOptions,
  LangSmithRegion,
  LangSmithSandboxErrorCode,
  SandboxClaimCreate,
  SandboxClaimResponse,
  SandboxListResponse,
} from "./types.js";

// Export error class and constants (value exports)
export { LangSmithSandboxError, API_HOSTS } from "./types.js";
