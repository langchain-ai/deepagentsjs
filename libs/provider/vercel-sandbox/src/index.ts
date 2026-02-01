/**
 * @langchain/vercel-sandbox
 *
 * Vercel Sandbox backend for deepagents.
 *
 * This package provides a Vercel Sandbox implementation of the SandboxBackendProtocol,
 * enabling agents to execute commands, read/write files, and manage isolated Linux
 * microVM environments using Vercel's Sandbox infrastructure.
 *
 * @example
 * ```typescript
 * import { VercelSandbox } from "@langchain/vercel-sandbox";
 * import { createDeepAgent } from "deepagents";
 * import { ChatAnthropic } from "@langchain/anthropic";
 *
 * // Create and initialize a sandbox
 * const sandbox = await VercelSandbox.create({
 *   runtime: "node24",
 *   timeout: 600000, // 10 minutes
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
 *   await sandbox.stop();
 * }
 * ```
 *
 * @packageDocumentation
 */

// Export main class
export { VercelSandbox } from "./sandbox.js";

// Export factory functions and types
export {
  createVercelSandboxFactory,
  createVercelSandboxFactoryFromSandbox,
  type AsyncVercelSandboxFactory,
} from "./sandbox.js";

// Export authentication utilities
export { getAuthToken, getAuthCredentials } from "./auth.js";
export type { VercelCredentials } from "./auth.js";

// Export types
export type {
  GitSource,
  TarballSource,
  SnapshotSource,
  SandboxSource,
  VercelSandboxOptions,
  SnapshotInfo,
  VercelSandboxErrorCode,
} from "./types.js";

// Export error class (value export)
export { VercelSandboxError } from "./types.js";
