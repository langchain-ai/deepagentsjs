/**
 * Internal helpers that wrap the backend protocol with the read/write
 * patterns the swarm subsystem needs.
 *
 * The backend protocol returns results as `{ error?, content? }` discriminated
 * shapes (it does not throw on missing files). These helpers normalize the
 * common cases — read full content as string, distinguish "missing" from
 * other errors — into a small surface that the manifest, results-store, and
 * executor modules can share.
 */

import type { BackendProtocolV2 } from "../backends/protocol.js";

/**
 * Outcome of {@link readTextFile}.
 *
 * Discriminated by the `kind` field so callers can pattern-match on the three
 * cases without ambiguity.
 */
export type ReadTextResult =
  | { kind: "ok"; content: string }
  | { kind: "missing"; error: string }
  | { kind: "error"; error: string };

/**
 * Heuristic for detecting "file not found" errors across backends.
 *
 * Every concrete backend in this repo formats missing-file errors with the
 * substring "not found", so a case-insensitive match is reliable. If a new
 * backend reports missing files differently, update this predicate to keep
 * the discrimination intact.
 */
export function isNotFoundError(message: string): boolean {
  return /not found/i.test(message);
}

/**
 * Read a file's full content as a string via the backend, handling all v1/v2
 * file-data shapes.
 *
 * Uses `readRaw` rather than `read` because `read` paginates by line offset
 * with a default limit of 500 lines — the swarm subsystem always wants the
 * whole file.
 */
export async function readTextFile(
  backend: BackendProtocolV2,
  path: string,
): Promise<ReadTextResult> {
  let raw;
  try {
    raw = await backend.readRaw(path);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    return isNotFoundError(message)
      ? { kind: "missing", error: message }
      : { kind: "error", error: message };
  }

  if (raw.error) {
    return isNotFoundError(raw.error)
      ? { kind: "missing", error: raw.error }
      : { kind: "error", error: raw.error };
  }

  if (!raw.data) {
    return { kind: "error", error: "backend returned no data" };
  }

  const content = raw.data.content;
  let asString: string;
  if (Array.isArray(content)) {
    asString = content.join("\n");
  } else if (typeof content === "string") {
    asString = content;
  } else {
    asString = new TextDecoder().decode(content);
  }
  return { kind: "ok", content: asString };
}

/**
 * Write a text file via the backend, returning a normalized error message
 * on failure or `null` on success.
 *
 * The backend's `write` method creates parent directories implicitly on
 * filesystem-style backends, and treats the path as a state key on
 * checkpoint-style backends — so the swarm subsystem never has to think
 * about directory creation.
 */
export async function writeTextFile(
  backend: BackendProtocolV2,
  path: string,
  content: string,
): Promise<{ error: string } | null> {
  try {
    const result = await backend.write(path, content);
    if (result.error) return { error: result.error };
    return null;
  } catch (err: any) {
    return { error: err?.message ?? String(err) };
  }
}
