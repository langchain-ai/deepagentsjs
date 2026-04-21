// ---------------------------------------------------------------------------
// Table JSONL helpers (generic row shapes, no schema validation)
// ---------------------------------------------------------------------------

/**
 * Parse a generic JSONL table into an array of row objects.
 *
 * Each non-empty line must be a JSON object. No schema validation is
 * performed — row semantics are enforced at dispatch time.
 *
 * @param content - Raw JSONL string (one JSON object per line)
 * @returns Array of parsed row objects
 * @throws Error with line-numbered diagnostics on any malformed line
 */
export function parseTableJsonl(content: string): Record<string, unknown>[] {
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  const rows: Record<string, unknown>[] = [];
  const errors: string[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNumber = idx + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[idx]);
    } catch {
      errors.push(`Line ${lineNumber}: invalid JSON`);
      continue;
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      errors.push(
        `Line ${lineNumber}: expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
      );
      continue;
    }

    rows.push(parsed as Record<string, unknown>);
  }

  if (errors.length > 0) {
    throw new Error(`Table parse failed:\n${errors.join("\n")}`);
  }

  return rows;
}

/**
 * Serialize an array of row objects to JSONL format.
 *
 * One JSON object per line, terminated with a trailing newline.
 * Returns an empty string for an empty array.
 *
 * @param rows - Array of row objects to serialize
 * @returns JSONL string
 */
export function serializeTableJsonl(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return "";
  }
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
