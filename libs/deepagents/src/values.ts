/**
 * Shared state values for use in StateSchema definitions.
 *
 * This module provides pre-configured ReducedValue instances that can be
 * reused across different state schemas, similar to LangGraph's messagesValue.
 */

import { z } from "zod";
import {
  DeltaValue,
  MessagesDeltaValue,
  ReducedValue,
  StateSchema,
  type AnyStateSchema,
} from "@langchain/langgraph";
import { schemaMetaRegistry } from "@langchain/langgraph/zod";
import {
  getInteropZodObjectShape,
  isInteropZodObject,
  isZodSchemaV4,
  type InteropZodObject,
} from "@langchain/core/utils/types";
import { FileDataSchema, fileDataReducer } from "./middleware/fs.js";

/**
 * Messages stored as per-step deltas with a full copy every 50 updates, the
 * default for deep agents (as Python deepagents' `DeepAgentState`).
 *
 * Loading a thread replays the writes since the last full copy, so the
 * snapshot frequency bounds how many checkpoints a load reads. The reducer must
 * be LangGraph's own: LangGraph gives written messages ids only for it.
 */
const messagesDeltaValue = new DeltaValue(MessagesDeltaValue.valueSchema, {
  inputSchema: MessagesDeltaValue.inputSchema,
  reducer: MessagesDeltaValue.reducer,
  snapshotFrequency: 50,
  jsonSchemaExtra: MessagesDeltaValue.jsonSchemaExtra,
});

const deltaFields = { messages: messagesDeltaValue };
const defaultStateSchema = new StateSchema(deltaFields);

/**
 * The state schema of a deep agent or subagent: the caller's fields, plus the
 * delta channels for every key the caller leaves out.
 *
 * A zod schema is copied field by field the way LangChain's `createAgent` reads
 * one, keeping reducers registered on zod v4 fields, because a StateSchema
 * cannot hold a zod object. Anything else `createAgent` ignores, so it is
 * ignored here too. This follows `createAgentState` in langchain 1.6.0
 * (`dist/agents/annotation.js`); recheck it when langchain changes how it
 * reads a state schema.
 */
export function deepAgentStateSchema(
  stateSchema?: AnyStateSchema | InteropZodObject,
): AnyStateSchema {
  if (StateSchema.isInstance(stateSchema)) {
    return new StateSchema({ ...deltaFields, ...stateSchema.fields });
  }
  if (!isInteropZodObject(stateSchema)) return defaultStateSchema;
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(
    getInteropZodObjectShape(stateSchema),
  )) {
    const reducer = isZodSchemaV4(field)
      ? schemaMetaRegistry.get(field)?.reducer
      : undefined;
    if (reducer === undefined) fields[key] = field;
    else if (reducer.schema === undefined) {
      fields[key] = new ReducedValue(field, { reducer: reducer.fn });
    } else {
      fields[key] = new ReducedValue(field, {
        inputSchema: reducer.schema as typeof field,
        reducer: reducer.fn,
      });
    }
  }
  return new StateSchema({ ...deltaFields, ...fields });
}

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
