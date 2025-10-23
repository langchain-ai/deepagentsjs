/**
 * TypeScript type definitions for Deep Agents
 *
 * This file contains all the TypeScript interfaces and types that correspond
 * to the Python TypedDict and other type definitions. Defines all necessary
 * TypeScript interfaces and types including StateSchemaType, SubAgent, Todo,
 * and proper generic types for state schemas.
 */
import { z } from "zod";
import type { HumanInTheLoopMiddlewareConfig } from "langchain";
import type { StructuredTool } from "@langchain/core/tools";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { CompiledSubAgent, SubAgent } from "./middleware/subAgent.js";

export interface CreateDeepAgentParams {
  tools?: StructuredTool[];
  instructions?: string;
  model: LanguageModelLike;
  subagents?: SubAgent[];
  interruptConfig?: NonNullable<HumanInTheLoopMiddlewareConfig>["interruptOn"];
  builtinTools?: string[];
}

export interface CreateTaskToolParams<StateSchema extends z.ZodSchema> {
  subagents: (SubAgent | CompiledSubAgent)[];
  tools?: Record<string, StructuredTool>;
  model?: LanguageModelLike;
  stateSchema?: StateSchema;
}
