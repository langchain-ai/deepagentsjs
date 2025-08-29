/**
 * TypeScript type definitions for Deep Agents
 *
 * This file contains all the TypeScript interfaces and types that correspond
 * to the Python TypedDict and other type definitions. Defines all necessary
 * TypeScript interfaces and types including StateSchemaType, SubAgent, Todo,
 * and proper generic types for state schemas.
 */

import type {
  BaseLanguageModelInput,
  LanguageModelOutput,
} from "@langchain/core/language_models/base";
import type { StructuredTool } from "@langchain/core/tools";
import type { DeepAgentState } from "./state.js";
import { z } from "zod";
import { Runnable } from "@langchain/core/runnables";
import { AnnotationRoot } from "@langchain/langgraph";
import { InteropZodObject } from "@langchain/core/utils/types";
import type { HumanInterruptConfig } from "@langchain/langgraph/prebuilt";

export type AnyAnnotationRoot = AnnotationRoot<any>;

export type InferZodObjectShape<T> =
  T extends z.ZodObject<infer Shape> ? Shape : never;

/**
 * SubAgent interface matching Python's TypedDict structure
 */
export interface SubAgent {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

export type DeepAgentStateType = z.infer<typeof DeepAgentState>;

export type LanguageModelLike = Runnable<
  BaseLanguageModelInput,
  LanguageModelOutput
>;

export type PostModelHook = (
  state: DeepAgentStateType,
  model: LanguageModelLike,
) => Promise<Partial<DeepAgentStateType> | void>;

export type ToolInterruptConfig = Record<
  string,
  HumanInterruptConfig | boolean
>;

export interface CreateDeepAgentParams<
  StateSchema extends z.ZodObject<any, any, any, any, any>,
  ContextSchema extends
    | AnyAnnotationRoot
    | InteropZodObject = AnyAnnotationRoot,
> {
  tools?: StructuredTool[];
  instructions?: string;
  model?: LanguageModelLike;
  subagents?: SubAgent[];
  stateSchema?: StateSchema;
  contextSchema?: ContextSchema;
  postModelHook?: PostModelHook;
  interruptConfig?: ToolInterruptConfig;
  builtinTools?: string[];
}

export interface CreateTaskToolParams<
  StateSchema extends z.ZodObject<any, any, any, any, any>,
> {
  subagents: SubAgent[];
  tools?: Record<string, StructuredTool>;
  model?: LanguageModelLike;
  stateSchema?: StateSchema;
}
