/**
 * Pure resume planning logic.
 *
 * Given the current manifest and a snapshot of existing result files, decide
 * which tasks need to be dispatched on this swarm call. The function has no
 * I/O so it can be unit-tested directly against handcrafted inputs.
 *
 * Resume rules:
 *   - Completed result → skip (always idempotent).
 *   - Failed result    → skip, unless `retryFailed` is set.
 *   - Corrupt result   → re-dispatch (treated as if no result existed).
 *   - No result        → dispatch (crash recovery / first run).
 *
 * Result files whose id is no longer in the manifest are reported as
 * `orphanedResultIds` so the orchestrator can see them, but they are never
 * deleted. This preserves the invariant that the swarm subsystem only
 * appends to a run directory; it never destroys data.
 */

import { ManifestEntry, TaskResult } from "./types.js";

export interface ResumePlan {
  /** Tasks to dispatch on this call. */
  pending: ManifestEntry[];
  /** Ids skipped because their result is already completed. */
  alreadyCompleted: string[];
  /** Ids skipped because their result is failed and retryFailed is false. */
  alreadyFailed: string[];
  /** Ids that will be re-dispatched because retryFailed is true. */
  retrying: string[];
  /** Ids of result files that are no longer present in the manifest. */
  orphanedResultIds: string[];
}

export function computePending(
  manifest: ManifestEntry[],
  resultIndex: Map<string, TaskResult | "corrupt">,
  retryFailed: boolean,
): ResumePlan {
  const pending: ManifestEntry[] = [];
  const alreadyCompleted: string[] = [];
  const alreadyFailed: string[] = [];
  const retrying: string[] = [];

  for (const entry of manifest) {
    const existing = resultIndex.get(entry.id);

    if (existing == null) {
      pending.push(entry);
      continue;
    }

    if (existing === "corrupt") {
      pending.push(entry);
      continue;
    }

    if (existing.status === "completed") {
      alreadyCompleted.push(entry.id);
      continue;
    }

    // existing.status === "failed"
    if (retryFailed) {
      pending.push(entry);
      retrying.push(entry.id);
    } else {
      alreadyFailed.push(entry.id);
    }
  }

  const manifestIds = new Set(manifest.map((entry) => entry.id));
  const orphanedResultIds: string[] = [];
  for (const id of resultIndex.keys()) {
    if (!manifestIds.has(id)) orphanedResultIds.push(id);
  }
  orphanedResultIds.sort();

  return {
    pending,
    alreadyCompleted,
    alreadyFailed,
    retrying,
    orphanedResultIds,
  };
}
