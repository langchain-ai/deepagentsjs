/**
 * DeepAgents Server - ACP Integration
 *
 * This package provides an Agent Client Protocol (ACP) server that wraps
 * DeepAgents, enabling seamless integration with IDEs like Zed, JetBrains,
 * and other ACP-compatible clients.
 *
 * @packageDocumentation
 * @module deepagents-acp
 *
 * @example
 * ```typescript
 * import { DeepAgentsServer, startServer } from "deepagents-acp";
 *
 * // Quick start
 * await startServer({
 *   agents: {
 *     name: "coding-assistant",
 *     description: "AI coding assistant with filesystem access",
 *   },
 *   workspaceRoot: process.cwd(),
 * });
 *
 * // Or create a server instance manually
 * const server = new DeepAgentsServer({
 *   agents: [{
 *     name: "coding-assistant",
 *     description: "AI coding assistant",
 *     skills: ["./skills/"],
 *     memory: ["./.deepagents/AGENTS.md"],
 *   }],
 *   debug: true,
 * });
 *
 * await server.start();
 * ```
 */

// Main server export
export { DeepAgentsServer, startServer } from "./server.js";

// Type exports
export type {
  DeepAgentConfig,
  DeepAgentsServerOptions,
  SessionState,
  ToolCallInfo,
  PlanEntry,
  StopReason,
  ACPCapabilities,
  ServerEvents,
} from "./types.js";

// Adapter utilities (for advanced use cases)
export {
  acpPromptToHumanMessage,
  langChainMessageToACP,
  langChainContentToACP,
  extractToolCalls,
  todosToPlanEntries,
  generateSessionId,
  generateToolCallId,
  getToolCallKind,
  formatToolCallTitle,
  fileUriToPath,
  pathToFileUri,
} from "./adapter.js";

// Logger utilities
export { Logger, createLogger, nullLogger } from "./logger.js";
export type { LogLevel, LoggerOptions } from "./logger.js";
