/**
 * @langchain/daytona
 *
 * Daytona Sandbox backend for deepagents.
 *
 * This package provides a Daytona Sandbox implementation of the SandboxBackendProtocol,
 * enabling agents to execute commands, read/write files, and manage isolated
 * sandbox environments using Daytona's infrastructure.
 *
 * @example
 * ```typescript
 * import { DaytonaSandbox } from "@langchain/daytona";
 * import { createDeepAgent } from "deepagents";
 * import { ChatAnthropic } from "@langchain/anthropic";
 *
 * // Create and initialize a sandbox
 * const sandbox = await DaytonaSandbox.create({
 *   language: "typescript",
 *   timeout: 300, // 5 minutes
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
export { DaytonaSandbox } from "./sandbox.js";

// Export factory functions and types
export {
  createDaytonaSandboxFactory,
  createDaytonaSandboxFactoryFromSandbox,
  type AsyncDaytonaSandboxFactory,
} from "./sandbox.js";

// Export authentication utilities
export { getAuthApiKey, getAuthApiUrl, getAuthCredentials } from "./auth.js";
export type { DaytonaCredentials } from "./auth.js";

// Export types
export type {
  DaytonaSandboxOptions,
  DaytonaSandboxTarget,
  DaytonaSandboxErrorCode,
} from "./types.js";

// Export error class (value export)
export { DaytonaSandboxError } from "./types.js";
