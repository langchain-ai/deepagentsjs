/**
 * Declarative filter system for JSONL table rows.
 *
 * Evaluates {@link SwarmFilter} clauses against arbitrary row objects,
 * supporting dotted-path column access, equality/membership tests,
 * existence checks, and boolean combinators (and/or).
 */

/**
 * Declarative filter clause evaluated against JSONL rows.
 *
 * Supports dotted paths (e.g., `"sentiment.class"`) for nested access.
 * Combinators (`and`, `or`) allow arbitrary nesting.
 *
 * @example
 * // Match rows where status is "pending"
 * { column: "status", equals: "pending" }
 *
 * @example
 * // Match rows where category is one of several values
 * { column: "category", in: ["A", "B", "C"] }
 *
 * @example
 * // Compound filter
 * { and: [
 *   { column: "status", equals: "pending" },
 *   { column: "result", exists: false },
 * ]}
 */
export type SwarmFilter =
  | { column: string; equals: unknown }
  | { column: string; notEquals: unknown }
  | { column: string; in: readonly unknown[] }
  | { column: string; exists: boolean }
  | { and: readonly SwarmFilter[] }
  | { or: readonly SwarmFilter[] };

/**
 * Structural equality check for filter comparisons.
 *
 * Handles primitives by identity, objects by serialized comparison.
 * Used internally by {@link evaluateFilter}.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (typeof a !== typeof b) {
    return false;
  }

  if (a === null || b === null) {
    return false;
  }

  if (typeof a === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Read a dotted path from a row object.
 *
 * Traverses nested objects by splitting on `"."`. Returns `undefined`
 * for missing segments or non-object intermediates.
 *
 * @param row - The row object to read from
 * @param path - Dot-delimited path (e.g., `"meta.score"`)
 * @returns The value at the path, or `undefined` if unreachable
 */
export function readColumn(
  row: Record<string, unknown>,
  path: string,
): unknown {
  const segments = path.split(".");

  let cursor: unknown = row;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return cursor;
}

/**
 * Evaluate a {@link SwarmFilter} clause against a single row.
 *
 * Recurses into `and`/`or` combinators. Leaf clauses compare via
 * {@link deepEqual} for structural equality.
 *
 * @param clause - The filter clause to evaluate
 * @param row - The row object to test
 * @returns `true` if the row matches the clause
 */
export function evaluateFilter(
  clause: SwarmFilter,
  row: Record<string, unknown>,
): boolean {
  if ("and" in clause) {
    return clause.and.every((c) => evaluateFilter(c, row));
  }

  if ("or" in clause) {
    return clause.or.some((c) => evaluateFilter(c, row));
  }

  const value = readColumn(row, clause.column);

  if ("equals" in clause) {
    return deepEqual(value, clause.equals);
  }

  if ("notEquals" in clause) {
    return !deepEqual(value, clause.notEquals);
  }

  if ("in" in clause) {
    return clause.in.some((v) => deepEqual(value, v));
  }

  if ("exists" in clause) {
    const present = value !== undefined && value !== null;
    return clause.exists ? present : !present;
  }

  return false;
}
