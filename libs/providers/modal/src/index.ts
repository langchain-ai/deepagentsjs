/**
 * @langchain/modal
 *
 * Modal Sandbox backend for deepagents.
 *
 * This package provides a Modal Sandbox implementation of the SandboxBackendProtocol,
 * enabling agents to execute commands, read/write files, and manage isolated container
 * environments using Modal's serverless infrastructure.
 *
 * @example
 * ```typescript
 * import { ModalSandbox } from "@langchain/modal";
 * import { createDeepAgent } from "deepagents";
 * import { ChatAnthropic } from "@langchain/anthropic";
 *
 * // Create and initialize a sandbox
 * const sandbox = await ModalSandbox.create({
 *   imageName: "python:3.12-slim",
 *   timeout: 600, // 10 minutes
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

// Export main class and factory functions
export {
  ModalSandbox,
  createModalSandboxFactory,
  createModalSandboxFactoryFromSandbox,
} from "./sandbox.js";
export type { AsyncModalSandboxFactory } from "./sandbox.js";

// Export authentication utilities
export { getAuthCredentials } from "./auth.js";
export type { ModalCredentials } from "./auth.js";

// Export types
export type { ModalSandboxOptions, ModalSandboxErrorCode } from "./types.js";

// Export error class (value export)
export { ModalSandboxError } from "./types.js";
