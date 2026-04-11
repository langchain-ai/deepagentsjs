/**
 * Read, write, and validate `manifest.jsonl` files.
 *
 * The manifest is the source of truth for which tasks belong to a run. It
 * carries only metadata: each row maps an id to a relative `descriptionPath`
 * (the prompt file under `tasks/`) and an optional `subagentType`.
 *
 * The file is line-delimited JSON. Empty/whitespace lines are tolerated to
 * make the file easier to inspect manually, but every non-empty line must
 * parse cleanly against {@link ManifestEntrySchema} and ids must be unique.
 */

import type { BackendProtocolV2 } from "../backends/protocol.js";
import { manifestPath } from "./layout.js";
import { readTextFile, writeTextFile } from "./io.js";
import { ManifestEntry, ManifestEntrySchema } from "./types.js";

/**
 * Thrown when the manifest file does not exist for a given run directory.
 *
 * Distinguished from {@link ManifestParseError} so callers can react to
 * "no run here yet" differently from "the run is corrupted".
 */
export class ManifestNotFoundError extends Error {
  constructor(public readonly runDir: string) {
    super(`manifest not found for run directory '${runDir}'`);
    this.name = "ManifestNotFoundError";
  }
}

/** Duck-typed check that avoids `instanceof` (banned by the project's lint rules). */
export function isManifestNotFoundError(
  err: unknown,
): err is ManifestNotFoundError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ManifestNotFoundError"
  );
}

/**
 * Thrown when the manifest file exists but contains invalid lines or
 * duplicate ids. Carries per-line errors so the orchestrator can be told
 * exactly what went wrong.
 */
export class ManifestParseError extends Error {
  constructor(
    public readonly runDir: string,
    public readonly lineErrors: Array<{ line: number; message: string }>,
  ) {
    const detail = lineErrors
      .map(({ line, message }) => `  line ${line}: ${message}`)
      .join("\n");
    super(`manifest validation failed for '${runDir}':\n${detail}`);
    this.name = "ManifestParseError";
  }
}

/** Duck-typed check that avoids `instanceof` (banned by the project's lint rules). */
export function isManifestParseError(
  err: unknown,
): err is ManifestParseError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ManifestParseError"
  );
}

/**
 * Parse manifest text into validated entries. Exposed separately so unit
 * tests can exercise the validation logic without a backend.
 */
export function parseManifestContent(
  runDir: string,
  content: string,
): ManifestEntry[] {
  const lines = content.split("\n");
  const entries: ManifestEntry[] = [];
  const seenIds = new Set<string>();
  const errors: Array<{ line: number; message: string }> = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    if (raw.trim() === "") continue;

    const lineNumber = idx + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      errors.push({ line: lineNumber, message: "invalid JSON" });
      continue;
    }

    const result = ManifestEntrySchema.safeParse(parsed);
    if (!result.success) {
      const messages = result.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join(", ");
      errors.push({ line: lineNumber, message: messages });
      continue;
    }

    if (seenIds.has(result.data.id)) {
      errors.push({
        line: lineNumber,
        message: `duplicate task id '${result.data.id}'`,
      });
      continue;
    }

    seenIds.add(result.data.id);
    entries.push(result.data);
  }

  if (errors.length > 0) {
    throw new ManifestParseError(runDir, errors);
  }

  return entries;
}

/**
 * Serialize entries to manifest.jsonl text. Trailing newline is included so
 * appending more entries always produces a valid file.
 */
export function serializeManifest(entries: ManifestEntry[]): string {
  if (entries.length === 0) return "";
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

/**
 * Read and validate the manifest for a run directory.
 *
 * @throws {ManifestNotFoundError} if the manifest file does not exist.
 * @throws {ManifestParseError} if any line is invalid or any id is duplicated.
 * @throws Error for any other backend error.
 */
export async function readManifest(
  backend: BackendProtocolV2,
  runDir: string,
): Promise<ManifestEntry[]> {
  const path = manifestPath(runDir);
  const result = await readTextFile(backend, path);
  if (result.kind === "missing") {
    throw new ManifestNotFoundError(runDir);
  }
  if (result.kind === "error") {
    throw new Error(`failed to read manifest at '${path}': ${result.error}`);
  }
  return parseManifestContent(runDir, result.content);
}

/**
 * Write an empty manifest file. Used by `swarm_init` to mark a run directory
 * as initialized; subsequent calls to {@link appendManifest} extend it.
 */
export async function initializeManifest(
  backend: BackendProtocolV2,
  runDir: string,
): Promise<void> {
  const path = manifestPath(runDir);
  const writeError = await writeTextFile(backend, path, "");
  if (writeError) {
    throw new Error(
      `failed to initialize manifest at '${path}': ${writeError.error}`,
    );
  }
}

/**
 * Append entries to the manifest, preserving existing rows.
 *
 * Implementation notes:
 * - Reads the current manifest, concatenates new rows, writes the full file
 *   back. We do not assume the backend supports atomic append — `StateBackend`
 *   and `StoreBackend` keep files in LangGraph state where there is no append
 *   primitive. Read-modify-write works uniformly across all backends.
 * - The caller is responsible for ensuring no id collisions occur. This
 *   function does a final defensive check and throws if any new id collides
 *   with an existing one, but the user-facing collision message is generally
 *   produced earlier in `swarm_add_tasks`.
 *
 * @throws {ManifestNotFoundError} if the run directory has not been initialized.
 * @throws Error if a new id collides with an existing one or the write fails.
 */
export async function appendManifest(
  backend: BackendProtocolV2,
  runDir: string,
  newEntries: ManifestEntry[],
): Promise<void> {
  if (newEntries.length === 0) return;

  const existing = await readManifest(backend, runDir);
  const existingIds = new Set(existing.map((entry) => entry.id));
  for (const entry of newEntries) {
    if (existingIds.has(entry.id)) {
      throw new Error(
        `cannot append manifest entry: id '${entry.id}' already exists in '${runDir}'`,
      );
    }
  }

  const merged = [...existing, ...newEntries];
  const path = manifestPath(runDir);
  const writeError = await writeTextFile(backend, path, serializeManifest(merged));
  if (writeError) {
    throw new Error(
      `failed to append manifest at '${path}': ${writeError.error}`,
    );
  }
}
