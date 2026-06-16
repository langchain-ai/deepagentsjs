const SCHEMA_MAX_BYTES = 4096;
const SCHEMA_MAX_DEPTH = 5;
const SCHEMA_MAX_PROPERTIES = 32;

/**
 * Validate that a response schema does not exceed size, depth, or
 * property-count limits.
 *
 * @throws Error if any limit is exceeded.
 */
export function validateResponseSchema(schema: Record<string, unknown>): void {
  const serialized = JSON.stringify(schema);
  if (serialized.length > SCHEMA_MAX_BYTES) {
    throw new Error(
      `responseSchema exceeds ${SCHEMA_MAX_BYTES} byte limit (${serialized.length} bytes)`,
    );
  }

  function check(
    node: Record<string, unknown>,
    depth: number,
    propCount: { value: number },
  ): void {
    if (depth > SCHEMA_MAX_DEPTH) {
      throw new Error(
        `responseSchema exceeds maximum nesting depth of ${SCHEMA_MAX_DEPTH}`,
      );
    }
    const props = node.properties;
    if (props != null && typeof props === "object" && !Array.isArray(props)) {
      const propObj = props as Record<string, unknown>;
      propCount.value += Object.keys(propObj).length;
      if (propCount.value > SCHEMA_MAX_PROPERTIES) {
        throw new Error(
          `responseSchema exceeds maximum of ${SCHEMA_MAX_PROPERTIES} properties`,
        );
      }
      for (const value of Object.values(propObj)) {
        if (
          value != null &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          check(value as Record<string, unknown>, depth + 1, propCount);
        }
      }
    }
    const items = node.items;
    if (items != null && typeof items === "object" && !Array.isArray(items)) {
      check(items as Record<string, unknown>, depth + 1, propCount);
    }
  }

  check(schema, 0, { value: 0 });
}
