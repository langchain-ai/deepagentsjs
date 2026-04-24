import { readColumn } from "./filter.js";

/**
 * Template interpolation for per-row instruction synthesis.
 *
 * Replaces `{column}` and `{dotted.path}` placeholders in an instruction
 * template with values read from a JSONL row. Supports all JSON value
 * types — strings are inserted bare, objects/arrays are JSON-serialized.
 *
 * @example
 * ```ts
 * const row = { name: "Acme", revenue: 1200, meta: { sector: "tech" } };
 * interpolateInstruction(
 *   "Analyze {name} in the {meta.sector} sector. Revenue: {revenue}.",
 *   row,
 * );
 * // → "Analyze Acme in the tech sector. Revenue: 1200."
 * ```
 */

/**
 * Interpolate `{column}` placeholders in an instruction template against a row.
 *
 * @param template - Instruction string with `{column}` or `{dotted.path}` placeholders
 * @param row - The JSONL row object to read values from
 * @returns The interpolated instruction string
 * @throws Error listing every missing column — surfaced as a per-task failure
 */
export function interpolateInstruction(
  template: string,
  row: Record<string, unknown>,
): string {
  const missing: string[] = [];

  const output = template.replace(
    /\{\s*([a-zA-Z_$][a-zA-Z0-9_$.]*)\s*\}/g,
    (match, path: string) => {
      const trimmed = path.trim();
      const value = readColumn(row, trimmed);
      if (value === undefined) {
        missing.push(trimmed);
        return match;
      }

      if (value === null) {
        return "null";
      }

      if (typeof value === "string") {
        return value;
      }

      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }

      return JSON.stringify(value);
    },
  );

  if (missing.length > 0) {
    throw new Error(`Missing column(s) in row: ${missing.join(", ")}`);
  }

  return output;
}
