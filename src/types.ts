/**
 * TypeScript type definitions for Deep Agents
 *
 * This file contains all the TypeScript interfaces and types that correspond
 * to the Python TypedDict and other type definitions. Defines all necessary
 * TypeScript interfaces and types including StateSchemaType, SubAgent, Todo,
 * and proper generic types for state schemas.
 */
import { z } from "zod";
import type { HumanInTheLoopMiddlewareConfig } from "langchain/middleware";
import type { StructuredTool } from "@langchain/core/tools";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { InferInteropZodInput } from "@langchain/core/utils/types";

/**
 * SubAgent interface matching Python's TypedDict structure
 */
export const SubAgentSchema = z.object({
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
});
export type SubAgent = InferInteropZodInput<typeof SubAgentSchema>;

export interface CreateDeepAgentParams {
  tools?: StructuredTool[];
  instructions?: string;
  model?: LanguageModelLike | string;
  subagents?: SubAgent[];
  interruptConfig?: NonNullable<HumanInTheLoopMiddlewareConfig>["toolConfigs"];
  builtinTools?: string[];
}

export interface CreateTaskToolParams<
  StateSchema extends z.ZodObject,
> {
  subagents: SubAgent[];
  tools?: Record<string, StructuredTool>;
  model?: LanguageModelLike;
  stateSchema?: StateSchema;
}
