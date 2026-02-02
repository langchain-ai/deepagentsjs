/**
 * @langchain/vfs-sandbox
 *
 * Node.js Virtual File System backend for deepagents.
 *
 * This package provides an in-memory VFS implementation of the SandboxBackendProtocol,
 * enabling agents to work with files in an isolated environment without touching
 * the real filesystem.
 *
 * Uses node-vfs-polyfill which implements the upcoming Node.js VFS feature
 * (nodejs/node#61478). When the official node:vfs module lands, this package
 * can be updated to use it instead.
 *
 * @example
 * ```typescript
 * import { VfsSandbox } from "@langchain/vfs-sandbox";
 * import { createDeepAgent } from "deepagents";
 * import { ChatAnthropic } from "@langchain/anthropic";
 *
 * // Create and initialize a VFS sandbox
 * const sandbox = await VfsSandbox.create({
 *   initialFiles: {
 *     "/src/index.js": "console.log('Hello')",
 *   },
 * });
 *
 * try {
 *   const agent = createDeepAgent({
 *     model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *     systemPrompt: "You are a coding assistant with VFS access.",
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
export { VfsSandbox } from "./sandbox.js";

// Export factory functions
export {
  createVfsSandboxFactory,
  createVfsSandboxFactoryFromSandbox,
} from "./sandbox.js";

// Export types
export type { VfsSandboxOptions, VfsSandboxErrorCode } from "./types.js";

// Export error class (value export)
export { VfsSandboxError } from "./types.js";
