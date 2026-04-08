import { z } from "zod";
import { SwarmTaskResult, SwarmTaskSpec } from "./types.js";

/**
 * Zod schema for a single task line in tasks.jsonl
 */
const taskSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  subagentType: z.string().optional(),
});

/**
 * Parse and validate a tasks.jsonl string into SwarmTaskSpec[].
 *
 * Validates:
 * - Each line is valid JSON
 * - Each task has a string `id` and string `description`
 * - All task IDs are unique
 * - At least one task is present
 *
 * @param content - Raw JSONL string content from the tasks file
 * @returns Array of validated task specs
 * @throws Error with a descriptive message on any validation failure
 */
export function parseTasksJsonl(content: string): SwarmTaskSpec[] {
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new Error(
      "tasks.jsonl is empty. The generation script must write at least one task.",
    );
  }

  const tasks: SwarmTaskSpec[] = [];
  const seenIds = new Set<string>();
  const errors: string[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNumber = idx + 1;

    let parsed;
    try {
      parsed = JSON.parse(lines[idx]);
    } catch {
      errors.push(`Line ${lineNumber}: invalid JSON`);
      continue;
    }

    const result = taskSchema.safeParse(parsed);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      errors.push(`Line ${lineNumber}: ${messages.join(", ")}`);
      continue;
    }

    if (seenIds.has(result.data.id)) {
      errors.push(`Line ${lineNumber}: duplicate task id "${result.data.id}"`);
      continue;
    }

    seenIds.add(result.data.id);
    tasks.push(result.data);
  }

  if (errors.length > 0) {
    throw new Error(`tasks.jsonl validation failed:\n${errors.join("\n")}`);
  }

  return tasks;
}

/**
 * Serialize an array of SwarmTaskResult objects back to JSONL format.
 *
 * Used by the executor to write the enriched results file.
 *
 * @param results - Array of task results to serialize
 * @returns JSONL string with one JSON object per line
 */
export function serializeResultsJsonl(results: SwarmTaskResult[]): string {
  return results.map((result) => JSON.stringify(result)).join("\n") + "\n";
}
