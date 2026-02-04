/**
 * Shared state values for use in StateSchema definitions.
 *
 * This module provides pre-configured ReducedValue instances that can be
 * reused across different state schemas, similar to LangGraph's messagesValue.
 */

import { z } from "zod";
import { ReducedValue } from "@langchain/langgraph";
import { FileDataSchema, fileDataReducer } from "./middleware/fs.js";

/**
 * Shared ReducedValue for file data state management.
 *
 * This provides a reusable pattern for managing file state with automatic
 * merging of concurrent updates from parallel subagents. Files can be updated
 * or deleted (using null values) and the reducer handles the merge logic.
 *
 * Similar to LangGraph's messagesValue, this encapsulates the common pattern
 * of managing files in agent state so you don't have to manually configure
 * the ReducedValue each time.
 *
 * @example
 * ```typescript
 * import { filesValue } from "@anthropic/deepagents";
 * import { StateSchema } from "@langchain/langgraph";
 *
 * const MyStateSchema = new StateSchema({
 *   files: filesValue,
 *   // ... other state fields
 * });
 * ```
 */
export const filesValue = new ReducedValue(
  z.record(z.string(), FileDataSchema).default(() => ({})),
  {
    inputSchema: z.record(z.string(), FileDataSchema.nullable()).optional(),
    reducer: fileDataReducer,
  },
);
