/**
 * Deep Agents TypeScript Implementation
 *
 * A TypeScript port of the Python Deep Agents library for building controllable AI agents with LangGraph.
 * This implementation maintains 1:1 compatibility with the Python version.
 */

export { createDeepAgent } from "./agent.js";
export type { CreateDeepAgentParams, CreateTaskToolParams } from "./types.js";

export { createTaskTool } from "./middleware/subAgent.js";
export type { SubAgent, CompiledSubAgent } from "./middleware/subAgent.js";
