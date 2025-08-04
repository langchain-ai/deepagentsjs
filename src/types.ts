import { BaseTool } from "@langchain/core/tools";
import { BaseLanguageModel } from "@langchain/core/language_models/base";

/**
 * Todo interface for tracking tasks
 * Mirrors the Python Todo TypedDict
 */
export interface Todo {
  /** The content/description of the todo item */
  content: string;
  /** The current status of the todo */
  status: "pending" | "in_progress" | "completed";
}

/**
 * SubAgent interface for defining sub-agents
 * Mirrors the Python SubAgent TypedDict
 */
export interface SubAgent {
  /** The name of the sub-agent */
  name: string;
  /** Description used by the main agent to decide whether to call the sub-agent */
  description: string;
  /** The system prompt used in the sub-agent */
  prompt: string;
  /** Optional list of tool names that this sub-agent should have access to */
  tools?: string[];
}

/**
 * Generic type for language models
 * Mirrors Python's LanguageModelLike union type
 */
export type LanguageModelLike = BaseLanguageModel | string;

/**
 * Generic type for tools
 * Mirrors Python's tool type flexibility
 */
export type ToolLike = BaseTool | Function | Record<string, any>;

/**
 * Generic constraint for state schemas
 * Mirrors Python's TypeVar pattern for StateSchema bound to DeepAgentState
 */
export interface StateSchemaConstraint {
  todos?: Todo[];
  files?: Record<string, string>;
  messages?: any[];
}

/**
 * Generic type utility for state schema types
 * Mirrors Python's Type[StateSchema] pattern
 */
export type StateSchemaType<T extends StateSchemaConstraint = StateSchemaConstraint> = new () => T;

/**
 * Utility type for extracting the instance type from a constructor
 * Helps with TypeScript generic inference similar to Python's TypeVar
 */
export type InstanceType<T> = T extends new (...args: any[]) => infer R ? R : never;

/**
 * Optional utility type for function parameters
 * Mirrors Python's Optional[T] pattern
 */
export type Optional<T> = T | null | undefined;

/**
 * Sequence type utility
 * Mirrors Python's Sequence[T] pattern
 */
export type Sequence<T> = T[] | ReadonlyArray<T>;

/**
 * Union type utility for flexible parameter types
 * Mirrors Python's Union type pattern
 */
export type Union<T extends readonly unknown[]> = T[number];

/**
 * File reducer function type
 * Mirrors the Python file_reducer function signature
 */
export type FileReducer = (
  left: Record<string, string> | null | undefined,
  right: Record<string, string> | null | undefined
) => Record<string, string>;

/**
 * Generic reducer function type for state channels
 * Used for defining custom reducers in state management
 */
export type ReducerFunction<T> = (currentState: T, updateValue: T) => T;

/**
 * Default factory function type for state channels
 * Used for providing initial values in state management
 */
export type DefaultFactory<T> = () => T;

/**
 * State channel configuration interface
 * Mirrors LangGraph's channel configuration pattern
 */
export interface StateChannel<T> {
  reducer?: ReducerFunction<T>;
  default?: DefaultFactory<T>;
}

/**
 * Generic state annotation interface
 * Provides type-safe state definition similar to Python's state management
 */
export interface StateAnnotation<T = any> {
  State: T;
  spec: Record<string, StateChannel<any>>;
}

/**
 * Tool call ID type for injected parameters
 * Used in tool implementations for state updates
 */
export type InjectedToolCallId = string;

/**
 * State injection type for tools
 * Used for injecting state into tool functions
 */
export type InjectedState<T extends StateSchemaConstraint = StateSchemaConstraint> = T;

/**
 * Command update type for state modifications
 * Mirrors LangGraph's Command pattern for state updates
 */
export interface CommandUpdate {
  todos?: Todo[];
  files?: Record<string, string>;
  messages?: any[];
  [key: string]: any;
}

/**
 * Command interface for state updates
 * Mirrors Python's Command class from LangGraph
 */
export interface Command {
  update: CommandUpdate;
}
