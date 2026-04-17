import { basename, dirname } from "node:path";
import type { BackendProtocolV2 } from "../backends/v2/protocol.js";
import type { SwarmTaskSpec } from "./types.js";
import { serializeTasksJsonl } from "./parse.js";

/**
 * Resolved input from the tool schema for the virtual-table form.
 */
export interface VirtualTableInput {
  /**
   * Explicit file paths to process.
   */
  filePaths?: string[];

  /**
   * Glob pattern(s) to match files.
   */
  glob?: string | string[];

  /**
   * Shared instruction prepended to each file's content as the task description.
   */
  instruction: string;

  /**
   * Subagent type for all synthesized tasks.
   */
  subagentType?: string;
}

/**
 * Discriminated result from the virtual-table resolver.
 * Success returns tasks + serialized JSONL. Failure returns an error string.
 */
export type VirtualTableResult =
  | { tasks: SwarmTaskSpec[]; tasksJsonl: string }
  | { error: string };

/**
 * Build a unique task ID from a file path, disambiguating basename collisions
 * by prepending the parent directory name.
 */
function buildTaskIds(filePaths: string[]): Map<string, string> {
  const basenameCounts = new Map<string, number>();
  for (const filePath of filePaths) {
    const base = basename(filePath);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }

  const ids = new Map<string, string>();
  for (const filePath of filePaths) {
    const base = basename(filePath);
    if ((basenameCounts.get(base) ?? 0) > 1) {
      const parent = basename(dirname(filePath));
      ids.set(filePath, `${parent}-${base}`);
    } else {
      ids.set(filePath, base);
    }
  }

  return ids;
}

/**
 * Resolve the virtual-table input form into SwarmTaskSpec[].
 *
 * Steps:
 * 1. Resolve file paths from explicit `files` and/or `glob` patterns
 * 2. Synthesize one SwarmTaskSpec per file (file path in description, subagent reads it)
 *
 * Returns `{ error }` on failure (never throws) so the tool handler can
 * pass it to the orchestrator as normal tool output.
 */
export async function resolveVirtualTableTasks(
  input: VirtualTableInput,
  backend: BackendProtocolV2,
): Promise<VirtualTableResult> {
  const { filePaths, glob, instruction, subagentType } = input;

  // 1. Resolve file paths
  const resolvedPaths = new Set<string>();

  if (filePaths) {
    for (const filePath of filePaths) {
      resolvedPaths.add(filePath);
    }
  }

  if (glob) {
    const patterns = Array.isArray(glob) ? glob : [glob];
    for (const raw of patterns) {
      // Strip leading slash — glob patterns are matched against relative paths
      const pattern = raw.replace(/^\/+/, "");
      const globResult = await backend.glob(pattern);
      if (globResult.error) {
        return {
          error: `Glob pattern "${pattern}" failed: ${globResult.error}`,
        };
      }

      if (globResult.files) {
        for (const file of globResult.files) {
          resolvedPaths.add(file.path);
        }
      }
    }
  }

  if (resolvedPaths.size === 0) {
    const patternDesc = glob
      ? `glob pattern(s): ${JSON.stringify(glob)}`
      : `files: ${JSON.stringify(filePaths)}`;
    return { error: `No files matched ${patternDesc}` };
  }

  // 2. Synthesize tasks
  const sortedPaths = [...resolvedPaths].sort();
  const taskIds = buildTaskIds(sortedPaths);
  const tasks: SwarmTaskSpec[] = sortedPaths.map((filePath) => ({
    id: taskIds.get(filePath) ?? filePath,
    description: `${instruction}\n\nFile: ${filePath}`,
    ...(subagentType != null && { subagentType }),
  }));

  return { tasks, tasksJsonl: serializeTasksJsonl(tasks) };
}
