import type { CreateSource, SwarmHandle } from "./types.js";

/**
 * PTC tool declaration for glob operations.
 *
 * At runtime in QuickJS, `tools` is an ambient global injected by the
 * PTC layer. For vitest, set up `globalThis.tools` in `beforeEach`.
 */
declare const tools: {
  glob?: (args: { pattern: string }) => Promise<string>;
};

/**
 * In-memory table store keyed by table ID.
 * Session-scoped — tables live for the duration of the REPL session.
 */
const cache = new Map<string, Record<string, unknown>[]>();

/**
 * Reset all module-level state for testing.
 */
export function _resetForTesting(): void {
  cache.clear();
}

/**
 * Generate a random 6-hex-char table ID prefixed with `t_`.
 *
 * @returns A string like `"t_a1b2c3"`.
 */
export function generateId(): string {
  const hex = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `t_${hex}`;
}

/**
 * Serialize an array of row objects to JSONL format.
 * One JSON object per line, no trailing newline.
 */
export function serializeJsonl(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

/**
 * Parse a JSONL string into an array of row objects.
 * Validates that each line parses to a non-null, non-array object.
 */
export function parseJsonl(content: string): Record<string, unknown>[] {
  if (!content.trim()) {
    return [];
  }

  const parseLine = (line: string, idx: number): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(line);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error(`expected object`);
      }
      return parsed as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `JSONL parse error at line ${idx + 1}: ${(e as Error).message}`,
        { cause: e },
      );
    }
  };

  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parseLine);
}

/**
 * Build `{ id, file }` rows from a list of file paths.
 *
 * Uses the basename (last path segment) as the row ID. When multiple
 * paths share the same basename, disambiguates by prepending the
 * parent directory name (e.g. `"routes-index.ts"` vs `"handlers-index.ts"`).
 */
export function pathsToRows(
  paths: string[],
): Array<{ id: string; file: string }> {
  const basenames = paths.map((p) => {
    const parts = p.split("/");
    return parts[parts.length - 1] || p;
  });

  const counts = new Map<string, number>();
  for (const basename of basenames) {
    counts.set(basename, (counts.get(basename) ?? 0) + 1);
  }

  return paths.map((filePath, idx) => {
    let id = basenames[idx];
    if ((counts.get(id) ?? 0) > 1) {
      const parts = filePath.split("/");
      if (parts.length >= 2) {
        id = `${parts[parts.length - 2]}-${id}`;
      }
    }
    return { id, file: filePath };
  });
}

/**
 * Find duplicate `id` values in a row array.
 */
function findDuplicateIds(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const row of rows) {
    const id = String(row.id);
    if (seen.has(id)) {
      dupes.add(id);
    } else {
      seen.add(id);
    }
  }
  return [...dupes];
}

/**
 * Resolve a glob pattern to a list of file paths via the PTC `glob` tool.
 *
 * @internal
 */
export async function globFiles(pattern: string): Promise<string[]> {
  if (typeof tools.glob !== "function") {
    throw new Error(`Swarm requires a 'glob' tool in the PTC configuration`);
  }

  const normalized = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const raw = await tools.glob({ pattern: normalized });

  if (raw.startsWith("No files found") || raw.startsWith("Error")) {
    return [];
  }

  let items: unknown[];
  try {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed : [];
  } catch {
    items = raw
      .split("\n")
      .map((l: string) => l.trim())
      .filter(Boolean);
  }

  const paths: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      paths.push(item);
    } else if (
      item &&
      typeof (item as Record<string, unknown>).path === "string"
    ) {
      paths.push((item as Record<string, unknown>).path as string);
    }
  }

  return paths;
}

/**
 * Resolve one or more glob patterns into a deduplicated, sorted list
 * of file paths.
 */
async function resolveGlob(pattern: string | string[]): Promise<string[]> {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const allPaths: string[] = [];
  for (const p of patterns) {
    const paths = await globFiles(p);
    allPaths.push(...paths);
  }

  const unique = [...new Set(allPaths)].sort();
  if (unique.length === 0) {
    throw new Error(`No files matched pattern: ${JSON.stringify(pattern)}`);
  }

  return unique;
}

/**
 * Create a table from a source spec and store it in memory.
 *
 * @param source - Exactly one of `glob`, `filePaths`, or `tasks`.
 * @returns A handle with the table's ID, row count, and column names.
 */
export async function createTable(source: CreateSource): Promise<SwarmHandle> {
  const sourceCount = [source.glob, source.filePaths, source.tasks].filter(
    (s) => s != null,
  ).length;

  if (sourceCount === 0) {
    throw new Error(
      "create() requires exactly one source: glob, filePaths, or tasks",
    );
  }

  if (sourceCount > 1) {
    throw new Error("create() accepts only one source type at a time");
  }

  let rows: Record<string, unknown>[];

  if (source.glob != null) {
    const paths = await resolveGlob(source.glob);
    rows = pathsToRows(paths);
  } else if (source.filePaths != null) {
    if (source.filePaths.length === 0) {
      throw new Error("filePaths array is empty");
    }
    rows = pathsToRows(source.filePaths);
  } else {
    const tasks = source.tasks ?? [];
    if (tasks.length === 0) {
      throw new Error("tasks array is empty");
    }

    for (let idx = 0; idx < tasks.length; idx++) {
      if (typeof tasks[idx].id !== "string") {
        throw new Error(`tasks[${idx}] is missing string 'id' field`);
      }
    }

    rows = tasks;
  }

  const dupes = findDuplicateIds(rows);
  if (dupes.length > 0) {
    throw new Error(`create() received duplicate row ids: ${dupes.join(", ")}`);
  }

  const id = generateId();
  cache.set(id, rows);

  return {
    id,
    count: rows.length,
    columns: Object.keys(rows[0] ?? {}),
  };
}

/**
 * Load a table's rows by ID from the in-memory store.
 *
 * @param id - The table ID from a `SwarmHandle`.
 * @returns The table's row array (by reference — mutations are visible).
 */
export async function loadTable(
  id: string,
): Promise<Record<string, unknown>[]> {
  const rows = cache.get(id);
  if (!rows) {
    throw new Error(`Table "${id}" not found`);
  }
  return rows;
}

/**
 * Update a table's rows in the in-memory store.
 *
 * @param id - The table ID from a `SwarmHandle`.
 * @param rows - The updated row array.
 */
export async function saveTable(
  id: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (!cache.has(id)) {
    throw new Error(`Table "${id}" is not loaded - call loadTable first`);
  }
  cache.set(id, rows);
}
