/**
 * CompositeBackend: Route operations to different backends based on path prefix.
 */

import type {
  AnyBackendProtocol,
  BackendProtocolV2,
  EditResult,
  ExecuteResponse,
  FileDownloadResponse,
  FileInfo,
  FileUploadResponse,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "./protocol.js";
import { isSandboxBackend, isSandboxProtocol } from "./protocol.js";
import { adaptBackendProtocol, adaptSandboxProtocol } from "./utils.js";

/**
 * Backend that routes file operations to different backends based on path prefix.
 *
 * This enables hybrid storage strategies like:
 * - `/memories/` → StoreBackend (persistent, cross-thread)
 * - Everything else → StateBackend (ephemeral, per-thread)
 *
 * The CompositeBackend handles path prefix stripping/re-adding transparently.
 */
export class CompositeBackend implements BackendProtocolV2 {
  private default: BackendProtocolV2;
  private routes: Record<string, BackendProtocolV2>;
  private sortedRoutes: Array<[string, BackendProtocolV2]>;

  constructor(
    defaultBackend: AnyBackendProtocol,
    routes: Record<string, AnyBackendProtocol>,
  ) {
    // Check if default backend is a sandbox and adapt accordingly
    this.default = isSandboxProtocol(defaultBackend)
      ? adaptSandboxProtocol(defaultBackend)
      : adaptBackendProtocol(defaultBackend);

    // Adapt route backends (check each one for sandbox properties)
    this.routes = Object.fromEntries(
      Object.entries(routes).map(([k, v]) => [
        k,
        isSandboxProtocol(v)
          ? adaptSandboxProtocol(v)
          : adaptBackendProtocol(v),
      ]),
    );

    // Sort routes by length (longest first) for correct prefix matching
    this.sortedRoutes = Object.entries(this.routes).sort(
      (a, b) => b[0].length - a[0].length,
    );
  }

  /** Delegates to default backend's id if it is a sandbox, otherwise empty string. */
  get id(): string {
    return isSandboxBackend(this.default) ? this.default.id : "";
  }

  /**
   * Determine which backend handles this key and strip prefix.
   *
   * @param key - Original file path
   * @returns Tuple of [backend, stripped_key] where stripped_key has the route
   *          prefix removed (but keeps leading slash).
   */
  private getBackendAndKey(key: string): [BackendProtocolV2, string] {
    // Check routes in order of length (longest first)
    for (const [prefix, backend] of this.sortedRoutes) {
      if (key.startsWith(prefix)) {
        // Strip full prefix and ensure a leading slash remains
        // e.g., "/memories/notes.txt" → "/notes.txt"; "/memories/" → "/"
        const suffix = key.substring(prefix.length);
        const strippedKey = suffix ? "/" + suffix : "/";
        return [backend, strippedKey];
      }
    }

    return [this.default, key];
  }

  /**
   * List files and directories in the specified directory (non-recursive).
   *
   * @param path - Absolute path to directory
   * @returns LsResult with list of FileInfo objects (with route prefixes added) on success or error on failure.
   *          Directories have a trailing / in their path and is_dir=true.
   */
  async ls(path: string): Promise<LsResult> {
    // Check if path matches a specific route
    for (const [routePrefix, backend] of this.sortedRoutes) {
      if (path.startsWith(routePrefix.replace(/\/$/, ""))) {
        // Query only the matching routed backend
        const suffix = path.substring(routePrefix.length);
        const searchPath = suffix ? "/" + suffix : "/";
        const result = await backend.ls(searchPath);

        if (result.error) {
          return result;
        }

        // Add route prefix back to paths
        const prefixed: FileInfo[] = [];
        for (const fi of result.files || []) {
          prefixed.push({
            ...fi,
            path: routePrefix.slice(0, -1) + fi.path,
          });
        }
        return { files: prefixed };
      }
    }

    // At root, aggregate default and all routed backends
    if (path === "/") {
      const results: FileInfo[] = [];
      const defaultResult = await this.default.ls(path);

      if (defaultResult.error) {
        return defaultResult;
      }

      results.push(...(defaultResult.files || []));

      // Add the route itself as a directory (e.g., /memories/)
      for (const [routePrefix] of this.sortedRoutes) {
        results.push({
          path: routePrefix,
          is_dir: true,
          size: 0,
          modified_at: "",
        });
      }

      results.sort((a, b) => a.path.localeCompare(b.path));
      return { files: results };
    }

    // Path doesn't match a route: query only default backend
    return await this.default.ls(path);
  }

  /**
   * Read file content, routing to appropriate backend.
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed)
   * @param limit - Maximum number of lines to read
   * @returns Formatted file content with line numbers, or error message
   */
  async read(
    filePath: string,
    offset: number = 0,
    limit: number = 500,
  ): Promise<ReadResult> {
    const [backend, strippedKey] = this.getBackendAndKey(filePath);
    return await backend.read(strippedKey, offset, limit);
  }

  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns ReadRawResult with raw file data on success or error on failure
   */
  async readRaw(filePath: string): Promise<ReadRawResult> {
    const [backend, strippedKey] = this.getBackendAndKey(filePath);
    return await backend.readRaw(strippedKey);
  }

  /**
   * Structured search results or error string for invalid input.
   */
  async grep(
    pattern: string,
    path: string = "/",
    glob: string | null = null,
  ): Promise<GrepResult> {
    // If path targets a specific route, search only that backend
    for (const [routePrefix, backend] of this.sortedRoutes) {
      if (path.startsWith(routePrefix.replace(/\/$/, ""))) {
        const searchPath = path.substring(routePrefix.length - 1);
        const raw = await backend.grep(pattern, searchPath || "/", glob);

        if (raw.error) {
          return raw;
        }

        // Add route prefix back
        const matches = (raw.matches || []).map((m) => ({
          ...m,
          path: routePrefix.slice(0, -1) + m.path,
        }));
        return { matches };
      }
    }

    // Otherwise, search default and all routed backends and merge
    const allMatches: GrepMatch[] = [];
    const rawDefault = await this.default.grep(pattern, path, glob);

    if (rawDefault.error) {
      return rawDefault;
    }

    allMatches.push(...(rawDefault.matches || []));

    // Search all routes
    for (const [routePrefix, backend] of Object.entries(this.routes)) {
      const raw = await backend.grep(pattern, "/", glob);

      if (raw.error) {
        return raw;
      }

      // Add route prefix back
      const matches = (raw.matches || []).map((m) => ({
        ...m,
        path: routePrefix.slice(0, -1) + m.path,
      }));
      allMatches.push(...matches);
    }

    return { matches: allMatches };
  }

  /**
   * Structured glob matching returning FileInfo objects.
   */
  async glob(pattern: string, path: string = "/"): Promise<GlobResult> {
    const results: FileInfo[] = [];

    // Route based on path, not pattern
    for (const [routePrefix, backend] of this.sortedRoutes) {
      if (path.startsWith(routePrefix.replace(/\/$/, ""))) {
        const searchPath = path.substring(routePrefix.length - 1);
        const result = await backend.glob(pattern, searchPath || "/");

        if (result.error) {
          return result;
        }

        // Add route prefix back
        const files = (result.files || []).map((fi) => ({
          ...fi,
          path: routePrefix.slice(0, -1) + fi.path,
        }));
        return { files };
      }
    }

    // Path doesn't match any specific route - search default backend AND all routed backends
    const defaultResult = await this.default.glob(pattern, path);
    if (defaultResult.error) {
      return defaultResult;
    }
    results.push(...(defaultResult.files || []));

    for (const [routePrefix, backend] of Object.entries(this.routes)) {
      const result = await backend.glob(pattern, "/");
      if (result.error) {
        continue; // Skip backends that error
      }
      const files = (result.files || []).map((fi) => ({
        ...fi,
        path: routePrefix.slice(0, -1) + fi.path,
      }));
      results.push(...files);
    }

    // Deterministic ordering
    results.sort((a, b) => a.path.localeCompare(b.path));
    return { files: results };
  }

  /**
   * Create a new file, routing to appropriate backend.
   *
   * @param filePath - Absolute file path
   * @param content - File content as string
   * @returns WriteResult with path or error
   */
  async write(filePath: string, content: string): Promise<WriteResult> {
    const [backend, strippedKey] = this.getBackendAndKey(filePath);
    return await backend.write(strippedKey, content);
  }

  /**
   * Edit a file, routing to appropriate backend.
   *
   * @param filePath - Absolute file path
   * @param oldString - String to find and replace
   * @param newString - Replacement string
   * @param replaceAll - If true, replace all occurrences
   * @returns EditResult with path, occurrences, or error
   */
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): Promise<EditResult> {
    const [backend, strippedKey] = this.getBackendAndKey(filePath);
    return await backend.edit(strippedKey, oldString, newString, replaceAll);
  }

  /**
   * Execute a command via the default backend.
   * Execution is not path-specific, so it always delegates to the default backend.
   *
   * @param command - Full shell command string to execute
   * @returns ExecuteResponse with combined output, exit code, and truncation flag
   * @throws Error if the default backend doesn't support command execution
   */
  execute(command: string): Promise<ExecuteResponse> {
    if (!isSandboxBackend(this.default)) {
      throw new Error(
        "Default backend doesn't support command execution (SandboxBackendProtocol). " +
          "To enable execution, provide a default backend that implements SandboxBackendProtocol.",
      );
    }
    return Promise.resolve(this.default.execute(command));
  }

  /**
   * Upload multiple files, batching by backend for efficiency.
   *
   * @param files - List of [path, content] tuples to upload
   * @returns List of FileUploadResponse objects, one per input file
   */
  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const results: Array<FileUploadResponse | null> = Array.from(
      { length: files.length },
      () => null,
    );
    const batchesByBackend = new Map<
      BackendProtocolV2,
      Array<{ idx: number; path: string; content: Uint8Array }>
    >();

    for (let idx = 0; idx < files.length; idx++) {
      const [path, content] = files[idx];
      const [backend, strippedPath] = this.getBackendAndKey(path);

      if (!batchesByBackend.has(backend)) {
        batchesByBackend.set(backend, []);
      }
      batchesByBackend.get(backend)!.push({ idx, path: strippedPath, content });
    }

    for (const [backend, batch] of batchesByBackend) {
      if (!backend.uploadFiles) {
        throw new Error("Backend does not support uploadFiles");
      }

      const batchFiles = batch.map(
        (b) => [b.path, b.content] as [string, Uint8Array],
      );
      const batchResponses = await backend.uploadFiles(batchFiles);

      for (let i = 0; i < batch.length; i++) {
        const originalIdx = batch[i].idx;
        results[originalIdx] = {
          path: files[originalIdx][0], // Original path
          error: batchResponses[i]?.error ?? null,
        };
      }
    }

    return results as FileUploadResponse[];
  }

  /**
   * Download multiple files, batching by backend for efficiency.
   *
   * @param paths - List of file paths to download
   * @returns List of FileDownloadResponse objects, one per input path
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const results: Array<FileDownloadResponse | null> = Array.from(
      { length: paths.length },
      () => null,
    );
    const batchesByBackend = new Map<
      BackendProtocolV2,
      Array<{ idx: number; path: string }>
    >();

    for (let idx = 0; idx < paths.length; idx++) {
      const path = paths[idx];
      const [backend, strippedPath] = this.getBackendAndKey(path);

      if (!batchesByBackend.has(backend)) {
        batchesByBackend.set(backend, []);
      }
      batchesByBackend.get(backend)!.push({ idx, path: strippedPath });
    }

    for (const [backend, batch] of batchesByBackend) {
      if (!backend.downloadFiles) {
        throw new Error("Backend does not support downloadFiles");
      }

      const batchPaths = batch.map((b) => b.path);
      const batchResponses = await backend.downloadFiles(batchPaths);

      for (let i = 0; i < batch.length; i++) {
        const originalIdx = batch[i].idx;
        results[originalIdx] = {
          path: paths[originalIdx], // Original path
          content: batchResponses[i]?.content ?? null,
          error: batchResponses[i]?.error ?? null,
        };
      }
    }

    return results as FileDownloadResponse[];
  }
}
