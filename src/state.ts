import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { Todo } from "./types.js";

/**
 * File reducer function that merges file objects
 * Mirrors the Python file_reducer function exactly
 */
export function fileReducer(
  left: Record<string, string> | null | undefined,
  right: Record<string, string> | null | undefined
): Record<string, string> {
  if (left === null || left === undefined) {
    return right || {};
  } else if (right === null || right === undefined) {
    return left;
  } else {
    return { ...left, ...right };
  }
}

/**
 * DeepAgentState annotation using LangGraph's Annotation.Root() pattern
 * Mirrors the Python DeepAgentState class that extends AgentState
 */
export const DeepAgentState = Annotation.Root({
  // Messages channel inherited from AgentState pattern
  messages: Annotation<BaseMessage[]>({
    reducer: (currentState, updateValue) => currentState.concat(updateValue),
    default: () => [],
  }),
  
  // Todos channel for tracking task lists
  todos: Annotation<Todo[]>({
    reducer: (currentState, updateValue) => {
      // If updateValue is provided, replace the entire todos array
      // This matches the Python behavior where todos are completely replaced
      return updateValue || currentState;
    },
    default: () => [],
  }),
  
  // Files channel for mock filesystem with custom reducer
  files: Annotation<Record<string, string>>({
    reducer: fileReducer,
    default: () => ({}),
  }),
});

/**
 * Type alias for the DeepAgentState type
 * Provides the TypeScript type for the state object
 */
export type DeepAgentStateType = typeof DeepAgentState.State;

/**
 * Interface that extends the base state pattern
 * Mirrors the Python DeepAgentState class structure
 */
export interface DeepAgentStateInterface {
  /** Array of messages in the conversation */
  messages: BaseMessage[];
  /** Optional array of todos for task tracking */
  todos?: Todo[];
  /** Optional dictionary of files for mock filesystem */
  files?: Record<string, string>;
}

/**
 * Default factory function for creating initial DeepAgentState
 * Useful for testing and initialization
 */
export function createInitialDeepAgentState(): DeepAgentStateInterface {
  return {
    messages: [],
    todos: [],
    files: {},
  };
}

/**
 * Type guard to check if an object is a valid DeepAgentState
 * Useful for runtime type checking
 */
export function isDeepAgentState(obj: any): obj is DeepAgentStateInterface {
  return (
    obj &&
    typeof obj === "object" &&
    Array.isArray(obj.messages) &&
    (obj.todos === undefined || Array.isArray(obj.todos)) &&
    (obj.files === undefined || typeof obj.files === "object")
  );
}

/**
 * Utility function to merge two DeepAgentState objects
 * Useful for state updates and testing
 */
export function mergeDeepAgentState(
  base: DeepAgentStateInterface,
  update: Partial<DeepAgentStateInterface>
): DeepAgentStateInterface {
  return {
    messages: update.messages || base.messages,
    todos: update.todos || base.todos,
    files: update.files ? fileReducer(base.files, update.files) : base.files,
  };
}

// Export the state annotation as default for convenience
export default DeepAgentState;
