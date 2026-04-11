/**
 * Shared test utilities for the swarm subsystem.
 *
 * Provides an in-memory backend that satisfies enough of `BackendProtocolV2`
 * to exercise the manifest, results-store, and executor modules without
 * touching disk.
 */

import type { BackendProtocolV2 } from "../backends/protocol.js";

export interface InMemoryBackend extends BackendProtocolV2 {
  files: Map<string, string>;
  /** Inject a synthetic read failure for a given path. */
  failReadFor: Set<string>;
  /** Inject a synthetic write failure for a given path. */
  failWriteFor: Set<string>;
}

const NOW = "1970-01-01T00:00:00.000Z";

/**
 * Construct an in-memory backend implementing the methods the swarm code uses.
 *
 * Only `read`, `readRaw`, `write`, and `ls` are functional; the other
 * `BackendProtocolV2` methods are stubs that return empty results so the
 * value still satisfies the interface for type checking.
 */
export function createInMemoryBackend(
  initialFiles: Record<string, string> = {},
): InMemoryBackend {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const failReadFor = new Set<string>();
  const failWriteFor = new Set<string>();

  const backend: InMemoryBackend = {
    files,
    failReadFor,
    failWriteFor,

    async read(filePath: string) {
      if (failReadFor.has(filePath)) {
        return { error: `synthetic read failure for ${filePath}` };
      }
      if (!files.has(filePath)) {
        return { error: `File '${filePath}' not found` };
      }
      return { content: files.get(filePath)!, mimeType: "text/plain" };
    },

    async readRaw(filePath: string) {
      if (failReadFor.has(filePath)) {
        return { error: `synthetic read failure for ${filePath}` };
      }
      if (!files.has(filePath)) {
        return { error: `File '${filePath}' not found` };
      }
      return {
        data: {
          content: files.get(filePath)!,
          mimeType: "text/plain",
          created_at: NOW,
          modified_at: NOW,
        },
      };
    },

    async write(filePath: string, content: string) {
      if (failWriteFor.has(filePath)) {
        return { error: `synthetic write failure for ${filePath}` };
      }
      files.set(filePath, content);
      return { path: filePath };
    },

    async ls(path: string) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const seenChildren = new Set<string>();
      const fileEntries: {
        path: string;
        is_dir: boolean;
        size: number;
        modified_at: string;
      }[] = [];

      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const remainder = filePath.slice(prefix.length);
        if (remainder.length === 0) continue;

        const slashIdx = remainder.indexOf("/");
        if (slashIdx === -1) {
          // direct child file
          if (seenChildren.has(remainder)) continue;
          seenChildren.add(remainder);
          fileEntries.push({
            path: `${prefix}${remainder}`,
            is_dir: false,
            size: files.get(filePath)!.length,
            modified_at: NOW,
          });
        } else {
          // nested file → directory child
          const dirName = remainder.slice(0, slashIdx);
          if (seenChildren.has(dirName)) continue;
          seenChildren.add(dirName);
          fileEntries.push({
            path: `${prefix}${dirName}/`,
            is_dir: true,
            size: 0,
            modified_at: NOW,
          });
        }
      }

      if (fileEntries.length === 0 && !hasAnyChildOf(files, prefix)) {
        return { error: `Directory '${path}' not found` };
      }
      return { files: fileEntries };
    },

    // The remaining BackendProtocolV2 methods are stubs — the swarm code
    // does not use them, but they need to be present to satisfy the type.
    async edit() {
      return { error: "edit not supported in InMemoryBackend" };
    },
    async grep() {
      return { matches: [] };
    },
    async glob() {
      return { files: [] };
    },
  } as unknown as InMemoryBackend;

  return backend;
}

function hasAnyChildOf(files: Map<string, string>, prefix: string): boolean {
  for (const filePath of files.keys()) {
    if (filePath.startsWith(prefix)) return true;
  }
  return false;
}
