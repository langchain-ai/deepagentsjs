/**
 * @langchain/deno
 *
 * Deno Sandbox backend for deepagents.
 *
 * This package provides a Deno Sandbox implementation of the SandboxBackendProtocol,
 * enabling agents to execute commands, read/write files, and manage isolated Linux
 * microVM environments using Deno Deploy's Sandbox infrastructure.
 *
 * @example
 * ```typescript
 * import { DenoSandbox } from "@langchain/deno";
 * import { createDeepAgent } from "deepagents";
 * import { ChatAnthropic } from "@langchain/anthropic";
 *
 * // Create and initialize a sandbox
 * const sandbox = await DenoSandbox.create({
 *   memoryMb: 1024, // 1GB memory
 *   lifetime: "10m", // 10 minutes
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
export { DenoSandbox } from "./sandbox.js";

// Export factory functions and types
export {
  createDenoSandboxFactory,
  createDenoSandboxFactoryFromSandbox,
  type AsyncDenoSandboxFactory,
} from "./sandbox.js";

// Export authentication utilities
export { getAuthToken, getAuthCredentials } from "./auth.js";
export type { DenoCredentials } from "./auth.js";

// Export types
export type {
  DenoSandboxOptions,
  DenoSandboxRegion,
  SandboxLifetime,
  DenoSandboxErrorCode,
} from "./types.js";

// Export error class (value export)
export { DenoSandboxError } from "./types.js";
