/**
 * Recursively add `additionalProperties: false` to every object-typed node
 * in a JSON Schema. Recurses into `properties` values and `items`.
 *
 * The Anthropic API requires this on all nested object types, not just the
 * top level. This normalizer lets callers omit it without causing 400 errors.
 */
export function normalizeSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type !== "object" && schema.type !== "array") {
    return schema;
  }

  if (schema.type === "array") {
    const result: Record<string, unknown> = { ...schema };
    const items = result.items;
    if (items != null && typeof items === "object" && !Array.isArray(items)) {
      result.items = normalizeSchema(items as Record<string, unknown>);
    }
    return result;
  }

  // type === "object"
  const result: Record<string, unknown> = {
    ...schema,
    additionalProperties: false,
  };

  const props = schema.properties;
  if (props != null && typeof props === "object" && !Array.isArray(props)) {
    const normalizedProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (v != null && typeof v === "object" && !Array.isArray(v)) {
        normalizedProps[k] = normalizeSchema(v as Record<string, unknown>);
      } else {
        normalizedProps[k] = v;
      }
    }
    result.properties = normalizedProps;
  }

  return result;
}

/**
 * Read a value from a row by dot-separated column path.
 *
 * Traverses nested objects segment by segment (e.g. `"meta.score"`
 * reads `row.meta.score`). Returns `undefined` if any intermediate
 * segment is missing or not an object.
 *
 * @param row - The table row to read from.
 * @param path - Dot-separated column path (e.g. `"file"` or `"meta.score"`).
 * @returns The resolved value, or `undefined` if the path is invalid.
 */
export function readColumn(
  row: Record<string, unknown>,
  path: string,
): unknown {
  const segments = path.split(".");

  let current = row;
  for (let idx = 0; idx < segments.length - 1; idx++) {
    const next = current[segments[idx]];
    if (next == null || typeof next !== "object" || Array.isArray(next)) {
      return undefined;
    }
    current = next as Record<string, unknown>;
  }

  return current[segments[segments.length - 1]];
}
