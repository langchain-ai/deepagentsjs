import { vi } from "vitest";

import type {
  BackendProtocol,
  FileDownloadResponse,
  FileInfo,
  WriteResult,
  EditResult,
} from "../backends/protocol.js";

/**
 * Mock backend that returns specified files and directory listings
 * @param config - Configuration object containing files and directories
 * @returns Mock backend that returns specified files and directory listings
 */
export function createMockBackend(
  config: {
    files?: Record<string, string>;
    directories?: Record<
      string,
      Array<{ name: string; type: "file" | "directory" }>
    >;
    writeError?: string;
  } = {},
): BackendProtocol {
  const writeError = config.writeError ?? undefined;
  const files = config.files ?? {};
  const directories = config.directories ?? {};
  const writtenFiles: Record<string, string> = { ...files };
  return {
    async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
      return paths.map((path) => {
        const content = files[path];
        if (content === null || content === undefined) {
          return { path, error: "file_not_found", content: null };
        }
        return {
          path,
          content: new TextEncoder().encode(content),
          error: null,
        };
      });
    },
    async lsInfo(dirPath: string): Promise<FileInfo[]> {
      const entries = directories[dirPath];
      if (!entries) {
        throw new Error(`Directory not found: ${dirPath}`);
      }
      // Convert test format to FileInfo format
      return entries.map((entry) => ({
        path: entry.name + (entry.type === "directory" ? "/" : ""),
        is_dir: entry.type === "directory",
      }));
    },
    // Implement other required methods as stubs
    readFiles: vi.fn(),
    async write(path: string, content: string): Promise<WriteResult> {
      if (writeError) {
        return { error: writeError };
      }
      writtenFiles[path] = content;
      return { path };
    },
    async edit(
      path: string,
      _oldString: string,
      newString: string,
    ): Promise<EditResult> {
      if (writeError) {
        return { error: writeError };
      }
      writtenFiles[path] = newString;
      return { path, occurrences: 1 };
    },
    grep: vi.fn(),
  } as unknown as BackendProtocol;
}
