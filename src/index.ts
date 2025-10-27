/**
 * Deep Agents TypeScript Implementation
 *
 * A TypeScript port of the Python Deep Agents library for building controllable AI agents with LangGraph.
 * This implementation maintains 1:1 compatibility with the Python version.
 */

export { createDeepAgent } from "./graph.js";
export { getDefaultModel } from "./model.js";
export { createTaskTool } from "./subAgent.js";
export { writeTodos, readFile, writeFile, editFile, ls } from "./tools.js";
export { DeepAgentState, fileReducer } from "./state.js";
export {
  WRITE_TODOS_DESCRIPTION,
  TASK_DESCRIPTION_PREFIX,
  TASK_DESCRIPTION_SUFFIX,
  EDIT_DESCRIPTION,
  TOOL_DESCRIPTION,
} from "./prompts.js";
export {
  formatStreamedMessage,
  isLLMTokenChunk,
  extractTodosFromUpdate,
  extractFilesFromUpdate,
  processStream,
  TokenAccumulator,
  StreamingPresets,
} from "./streaming.js";
export type {
  SubAgent,
  Todo,
  DeepAgentStateType,
  CreateDeepAgentParams,
  CreateTaskToolParams,
  TodoStatus,
} from "./types.js";
export type {
  StreamMode,
  DeepAgentStreamConfig,
  StreamedUpdate,
  StreamHandler,
} from "./streaming.js";
