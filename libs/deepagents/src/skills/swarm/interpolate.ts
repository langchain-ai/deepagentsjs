import { readColumn } from "./utils.js";

/**
 * Replace `{column}` placeholders in a template string with values
 * from a table row.
 *
 * Placeholders use curly braces and support dot-paths for nested
 * access (e.g. `{meta.score}`). String values are inserted verbatim,
 * numbers and booleans are stringified, and objects/arrays are
 * JSON-serialized.
 *
 * Unlike fail-fast interpolation, this collects ALL missing columns
 * and throws a single error listing every unresolvable placeholder.
 *
 * @param template - The instruction template (e.g. `"Review {file} for issues"`).
 * @param row - The table row providing column values.
 * @returns The interpolated string with all placeholders resolved.
 * @throws Error listing all missing column paths.
 */
export function interpolate(
  template: string,
  row: Record<string, unknown>,
): string {
  const missing: string[] = [];

  const result = template.replace(/\{([^}]+)\}/g, (_match, rawPath) => {
    const path = rawPath.trim();

    const value = readColumn(row, path);
    if (value === undefined) {
      missing.push(path);
      return `{${path}}`;
    }

    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    return JSON.stringify(value);
  });

  if (missing.length > 0) {
    throw new Error(
      `Interpolation failed: missing columns: ${missing.join(", ")}`,
    );
  }

  return result;
}
