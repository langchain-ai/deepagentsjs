/**
 * Deep Agents TypeScript Implementation
 *
 * A TypeScript port of the Python Deep Agents library for building controllable AI agents with LangGraph.
 * This implementation maintains 1:1 compatibility with the Python version.
 */

export { createDeepAgent } from "./agent.js";
export { createTaskTool } from "./subAgent.js";
export {
  WRITE_TODOS_DESCRIPTION,
  TASK_DESCRIPTION_PREFIX,
  TASK_DESCRIPTION_SUFFIX,
  EDIT_DESCRIPTION,
  TOOL_DESCRIPTION,
} from "./prompts.js";
export type {
  SubAgent,
  CreateDeepAgentParams,
  CreateTaskToolParams,
} from "./types.js";
