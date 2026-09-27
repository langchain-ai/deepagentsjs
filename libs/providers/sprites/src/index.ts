/**
 * @langchain/sprites
 *
 * Fly.io Sprites sandbox backend for deepagents.
 *
 * This package provides a Sprites implementation of the
 * SandboxBackendProtocol, enabling agents to execute commands, read/write
 * files, and manage isolated sandbox environments using Fly.io's Sprites
 * infrastructure — persistent Linux VMs with instant creation and fast
 * checkpoint/restore.
 *
 * @example
 * ```typescript
 * import { SpritesSandbox } from "@langchain/sprites";
 * import { createDeepAgent } from "deepagents";
 * import { ChatAnthropic } from "@langchain/anthropic";
 *
 * // Create and initialize a sandbox
 * const sandbox = await SpritesSandbox.create({
 *   timeout: 300, // 5 minutes
 * });
 *
 * try {
 *   const agent = createDeepAgent({
 *     model: new ChatAnthropic({ model: "claude-sonnet-4-5" }),
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
export { SpritesSandbox } from "./sandbox.js";

// Export factory functions and types
export {
  createSpritesSandboxFactory,
  createSpritesSandboxFactoryFromSandbox,
  type AsyncSpritesSandboxFactory,
} from "./sandbox.js";

// Export authentication utilities
export { getAuthToken, getAuthBaseURL, getAuthCredentials } from "./auth.js";
export type { SpritesCredentials } from "./auth.js";

// Export types
export type {
  SpritesSandboxOptions,
  SpritesSandboxConfig,
  SpritesSandboxErrorCode,
} from "./types.js";

// Export error class (value export)
export { SpritesSandboxError } from "./types.js";
