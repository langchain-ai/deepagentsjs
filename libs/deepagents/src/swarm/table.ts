import { basename, dirname } from "node:path";
import type { BackendProtocolV2 } from "../backends/v2/protocol.js";
import { serializeTableJsonl } from "./parse.js";
import type { CreateTableSource } from "./types.js";

/**
 * Build unique task IDs from file paths, disambiguating basename collisions
 * by prepending the parent directory name.
 *
 * @param paths - Sorted array of absolute file paths
 * @returns Map from file path to unique ID
 */
function buildTaskIds(paths: string[]): Map<string, string> {
  const basenameCounts = new Map<string, number>();
  for (const path of paths) {
    const base = basename(path);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }

  const ids = new Map<string, string>();
  for (const path of paths) {
    const base = basename(path);
    if ((basenameCounts.get(base) ?? 0) > 1) {
      const parent = basename(dirname(path));
      ids.set(path, `${parent}-${base}`);
    } else {
      ids.set(path, base);
    }
  }

  return ids;
}

/**
 * Resolve file paths from glob patterns and/or explicit paths via the backend.
 *
 * @param source - Source containing `glob` and/or `filePaths`
 * @param backend - Backend for glob resolution
 * @returns Deduplicated, sorted array of file paths
 * @throws Error if no files are matched
 */
async function resolveFilePaths(
  source: CreateTableSource,
  backend: BackendProtocolV2,
): Promise<string[]> {
  const resolved = new Set<string>();

  if (source.filePaths) {
    for (const path of source.filePaths) {
      resolved.add(path);
    }
  }

  if (source.glob) {
    const patterns = Array.isArray(source.glob) ? source.glob : [source.glob];

    for (const raw of patterns) {
      const pattern = raw.replace(/^\/+/, "");
      const result = await backend.glob(pattern);

      if (result.error) {
        throw new Error(`Glob pattern "${pattern}" failed: ${result.error}`);
      }

      if (result.files) {
        for (const file of result.files) {
          resolved.add(file.path);
        }
      }
    }
  }

  if (resolved.size === 0) {
    const description = source.glob
      ? `glob: ${JSON.stringify(source.glob)}`
      : `filePaths: ${JSON.stringify(source.filePaths)}`;
    throw new Error(`No files matched ${description}`);
  }

  return [...resolved].sort();
}

/**
 * Write callback type. Abstracts over direct backend writes vs. session
 * pendingWrites so the same logic works in both contexts.
 */
export type WriteCallback = (path: string, content: string) => void;

/**
 * Create a JSONL table file from a {@link CreateTableSource}.
 *
 * For `glob`/`filePaths` sources, resolves paths via the backend and
 * produces rows with `{ id, file }`. For inline `tasks`, validates that
 * each row has an `id` field. The resulting JSONL is written through
 * the `write` callback (routed to `pendingWrites` for read-after-write
 * visibility). Overwrites the file if it already exists.
 *
 * @throws Error if the source is empty, no files match, or tasks are missing ids.
 */
export async function createTable(
  file: string,
  source: CreateTableSource,
  backend: BackendProtocolV2,
  write: WriteCallback,
) {
  const hasGlob = source.glob != null;
  const hasFilePaths = source.filePaths != null && source.filePaths.length > 0;
  const hasTasks = source.tasks != null && source.tasks.length > 0;

  if (!hasGlob && !hasFilePaths && !hasTasks) {
    throw new Error(
      "swarm.create: source must provide at least one of `glob`, `filePaths`, or `tasks`.",
    );
  }

  let rows: Record<string, unknown>[];

  if (hasTasks) {
    const tasks = source.tasks ?? [];
    const missing: number[] = [];
    for (let idx = 0; idx < tasks.length; idx++) {
      if (typeof tasks[idx].id !== "string") {
        missing.push(idx);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `swarm.create: tasks at index ${missing.join(", ")} missing required "id" field.`,
      );
    }

    rows = tasks;
  } else {
    const paths = await resolveFilePaths(source, backend);
    const taskIds = buildTaskIds(paths);
    rows = paths.map((p) => ({ id: taskIds.get(p) ?? p, file: p }));
  }

  write(file, serializeTableJsonl(rows));
}
