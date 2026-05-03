/**
 * Group an array of items into batches of a given size.
 *
 * The last batch may be smaller than `batchSize` if the total count
 * is not evenly divisible.
 *
 * @param items - Array of items to batch.
 * @param batchSize - Maximum number of items per batch.
 * @returns Array of batches (each batch is an array of items).
 */
export function createBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Wrap a per-item JSON Schema into a batch-level response schema.
 *
 * Always produces a schema of the form:
 * ```json
 * { "results": [{ "id": "...", ...itemProps }] }
 * ```
 *
 * When `itemSchema` is provided, its properties are merged with an
 * `id` field. When omitted (text-mode batching), a minimal
 * `{ id, result }` schema is auto-generated.
 *
 * @param itemSchema - Per-item JSON Schema, or `undefined` for auto-generation.
 * @returns Batch-level JSON Schema wrapping items in a `results` array.
 */
export function wrapSchema(
  itemSchema?: Record<string, unknown>,
  count?: number,
): Record<string, unknown> {
  let itemProperties: Record<string, unknown>;
  let itemRequired: string[];

  if (itemSchema) {
    const props = (itemSchema.properties as Record<string, unknown>) ?? {};
    const req = (itemSchema.required as string[]) ?? [];
    itemProperties = { id: { type: "string" }, ...props };
    itemRequired = ["id", ...req];
  } else {
    itemProperties = {
      id: { type: "string" },
      result: { type: "string" },
    };
    itemRequired = ["id", "result"];
  }

  const resultsArray: Record<string, unknown> = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: itemProperties,
      required: itemRequired,
    },
  };

  if (count != null) {
    resultsArray.minItems = count;
    resultsArray.maxItems = count;
  }

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      results: resultsArray,
    },
    required: ["results"],
  };
}

/**
 * Build a single prompt for a batch of rows.
 *
 * The instruction template is shown once as a preamble. Each row's
 * data is listed compactly as `[id]: {column values}`. The subagent
 * is instructed to return results keyed by each item's ID.
 *
 * @param instruction - Instruction template with `{column}` placeholders.
 * @param rows - Array of row objects to include in the batch.
 * @param context - Optional context prose prepended to the prompt.
 * @returns A single prompt string covering all rows in the batch.
 */
export function buildBatchPrompt(
  instruction: string,
  rows: Array<Record<string, unknown>>,
  context?: string,
): string {
  const parts: string[] = [];

  if (context) {
    parts.push(context);
    parts.push("");
  }

  parts.push(`Instruction: ${instruction}`);
  parts.push("");
  parts.push(
    `Process ${rows.length} items. Apply this instruction to each item below. ` +
      "Column references like {column} in the instruction correspond to " +
      "fields in each item's data. Return a JSON object " +
      `with a 'results' array containing exactly ${rows.length} entries, ` +
      "each including the item's 'id' exactly as shown.",
  );
  parts.push("");

  for (const row of rows) {
    const { id, ...data } = row;
    parts.push(`[${id}]: ${JSON.stringify(data)}`);
  }

  return parts.join("\n");
}

/**
 * Unpack a batch response string into per-row results.
 *
 * Parses the JSON response expecting `{ results: [{ id, ...fields }] }`.
 * Maps each item's `id` to its remaining fields. IDs present in
 * `expectedIds` but absent from the response are returned in `missing`.
 *
 * When the `results` array contains a single `result` field (text-mode
 * batching), the value is unwrapped from the object for convenience.
 *
 * @param response - Raw JSON string from the subagent.
 * @param expectedIds - List of row IDs the batch was supposed to cover.
 * @returns Map of ID → result value, plus a list of IDs missing from
 *          the response.
 */
export function unpackBatchResults(
  response: string,
  expectedIds: string[],
): { results: Map<string, unknown>; missing: string[] } {
  const resultsMap = new Map<string, unknown>();
  const missing: string[] = [];

  try {
    const parsed = JSON.parse(response);
    const items: Array<Record<string, unknown>> = parsed?.results ?? [];

    for (const item of items) {
      if (item && typeof item.id === "string") {
        const { id, ...fields } = item;
        resultsMap.set(
          id,
          Object.keys(fields).length === 1 && "result" in fields
            ? fields.result
            : fields,
        );
      }
    }
  } catch {
    // Parse failure — all IDs are missing
  }

  for (const id of expectedIds) {
    if (!resultsMap.has(id)) {
      missing.push(id);
    }
  }

  return { results: resultsMap, missing };
}
