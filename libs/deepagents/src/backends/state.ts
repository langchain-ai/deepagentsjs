/**
 * StateBackend: Store files in LangGraph agent state (ephemeral).
 */

import type {
  EditResult,
  FileData,
  FileDownloadResponse,
  FileInfo,
  FileUploadResponse,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  BackendRuntime,
  WriteResult,
  BackendProtocolV2,
  BackendOptions,
} from "./protocol.js";
import {
  createFileData,
  fileDataToString,
  getMimeType,
  globSearchFiles,
  grepMatchesFromFiles,
  isFileDataBinary,
  isFileDataV1,
  isTextMimeType,
  migrateToFileDataV2,
  performStringReplacement,
  updateFileData,
} from "./utils.js";
import { getConfig, getCurrentTaskInput } from "@langchain/langgraph";

const PREGEL_SEND_KEY = "__pregel_send";

/**
 * Backend that stores files in agent state (ephemeral).
 *
 * Uses LangGraph's state management and checkpointing. Files persist within
 * a conversation thread but not across threads. State is automatically
 * checkpointed after each agent step.
 *
 * Special handling: Since LangGraph state must be updated via Command objects
 * (not direct mutation), operations return filesUpdate in WriteResult/EditResult
 * for the middleware to apply via Command.
 */
export class StateBackend implements BackendProtocolV2 {
  private runtime: BackendRuntime | undefined;
  private fileFormat: "v1" | "v2";

  constructor(options?: BackendOptions);
  /**
   * @deprecated Pass no `runtime` argument
   */
  constructor(runtime: BackendRuntime, options?: BackendOptions);
  constructor(
    runtimeOrOptions?: BackendRuntime | BackendOptions,
    options?: BackendOptions,
  ) {
    if (
      runtimeOrOptions != null &&
      typeof runtimeOrOptions === "object" &&
      "state" in runtimeOrOptions
    ) {
      // Legacy path: BackendRuntime was passed
      this.runtime = runtimeOrOptions;
      this.fileFormat = options?.fileFormat ?? "v2";
    } else {
      // New path: zero-arg or options-only
      this.runtime = undefined;
      this.fileFormat = runtimeOrOptions?.fileFormat ?? "v2";
    }
  }

  /**
   * Whether this instance was constructed with the legacy factory pattern.
   *
   * When true, state is read from the injected `runtime` and `filesUpdate`
   * is returned to the caller. When false, state is read from LangGraph's
   * execution context and updates are sent via `__pregel_send`.
   */
  private get isLegacy(): boolean {
    return this.runtime !== undefined;
  }

  /**
   * Get files from current state.
   *
   * In legacy mode, reads from the injected {@link BackendRuntime}.
   * In zero-arg mode, reads from the LangGraph execution context via
   * {@link getCurrentTaskInput}.
   */
  private getFiles(): Record<string, FileData> {
    if (this.runtime) {
      const state = this.runtime.state as { files?: Record<string, FileData> };
      return state.files || {};
    }

    const state = getCurrentTaskInput<{ files?: Record<string, FileData> }>();
    return state?.files || {};
  }

  /**
   * Push a files state update through LangGraph's internal send channel.
   *
   * In zero-arg mode, sends the update via the `__pregel_send` function
   * from {@link getConfig}, mirroring Python's `CONFIG_KEY_SEND`.
   * In legacy mode, this is a no-op — the caller uses `filesUpdate`
   * from the return value instead.
   *
   * @param update - Map of file paths to their updated {@link FileData}
   */
  private sendFilesUpdate(update: Record<string, FileData>): void {
    if (this.isLegacy) {
      return;
    }

    const config = getConfig();
    const send = config.configurable?.[PREGEL_SEND_KEY];

    if (typeof send === "function") {
      send([["files", update]]);
    }
  }

  /**
   * List files and directories in the specified directory (non-recursive).
   *
   * @param path - Absolute path to directory
   * @returns LsResult with list of FileInfo objects on success or error on failure.
   *          Directories have a trailing / in their path and is_dir=true.
   */
  ls(path: string): LsResult {
    const files = this.getFiles();
    const infos: FileInfo[] = [];
    const subdirs = new Set<string>();

    // Normalize path to have trailing slash for proper prefix matching
    const normalizedPath = path.endsWith("/") ? path : path + "/";

    for (const [k, fd] of Object.entries(files)) {
      // Check if file is in the specified directory or a subdirectory
      if (!k.startsWith(normalizedPath)) {
        continue;
      }

      // Get the relative path after the directory
      const relative = k.substring(normalizedPath.length);

      // If relative path contains '/', it's in a subdirectory
      if (relative.includes("/")) {
        // Extract the immediate subdirectory name
        const subdirName = relative.split("/")[0];
        subdirs.add(normalizedPath + subdirName + "/");
        continue;
      }

      // This is a file directly in the current directory
      const size = isFileDataV1(fd)
        ? fd.content.join("\n").length
        : isFileDataBinary(fd)
          ? fd.content.byteLength
          : fd.content.length;
      infos.push({
        path: k,
        is_dir: false,
        size: size,
        modified_at: fd.modified_at,
      });
    }

    // Add directories to the results
    for (const subdir of Array.from(subdirs).sort()) {
      infos.push({
        path: subdir,
        is_dir: true,
        size: 0,
        modified_at: "",
      });
    }

    infos.sort((a, b) => a.path.localeCompare(b.path));
    return { files: infos };
  }

  /**
   * Read file content.
   *
   * Text files are paginated by line offset/limit.
   * Binary files return full Uint8Array content (offset/limit ignored).
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed)
   * @param limit - Maximum number of lines to read
   * @returns ReadResult with content on success or error on failure
   */
  read(filePath: string, offset: number = 0, limit: number = 500): ReadResult {
    const files = this.getFiles();
    const fileData = files[filePath];

    if (!fileData) {
      return { error: `File '${filePath}' not found` };
    }

    const fileDataV2 = migrateToFileDataV2(fileData, filePath);

    // ignore pagination for binary data, return full content
    if (!isTextMimeType(fileDataV2.mimeType)) {
      return { content: fileDataV2.content, mimeType: fileDataV2.mimeType };
    }

    // apply pagination logic for text data
    if (typeof fileDataV2.content !== "string") {
      return {
        error: `File '${filePath}' has binary content but text MIME type`,
      };
    }
    const lines = fileDataV2.content.split("\n");
    const selected = lines.slice(offset, offset + limit);
    return { content: selected.join("\n"), mimeType: fileDataV2.mimeType };
  }

  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns ReadRawResult with raw file data on success or error on failure
   */
  readRaw(filePath: string): ReadRawResult {
    const files = this.getFiles();
    const fileData = files[filePath];

    if (!fileData) {
      return { error: `File '${filePath}' not found` };
    }
    return { data: fileData };
  }

  /**
   * Create a new file with content.
   * Returns WriteResult with filesUpdate to update LangGraph state.
   */
  write(filePath: string, content: string): WriteResult {
    const files = this.getFiles();

    if (filePath in files) {
      return {
        error: `Cannot write to ${filePath} because it already exists. Read and then make an edit, or write to a new path.`,
      };
    }

    const mimeType = getMimeType(filePath);
    const newFileData = createFileData(
      content,
      undefined,
      this.fileFormat,
      mimeType,
    );
    const update = { [filePath]: newFileData };

    if (!this.isLegacy) {
      this.sendFilesUpdate(update);
      return { path: filePath };
    }

    return {
      path: filePath,
      filesUpdate: { [filePath]: newFileData },
    };
  }

  /**
   * Edit a file by replacing string occurrences.
   * Returns EditResult with filesUpdate and occurrences.
   */
  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): EditResult {
    const files = this.getFiles();
    const fileData = files[filePath];

    if (!fileData) {
      return { error: `Error: File '${filePath}' not found` };
    }

    const content = fileDataToString(fileData);
    const result = performStringReplacement(
      content,
      oldString,
      newString,
      replaceAll,
    );

    if (typeof result === "string") {
      return { error: result };
    }

    const [newContent, occurrences] = result;
    const newFileData = updateFileData(fileData, newContent);
    const update = { [filePath]: newFileData };

    if (!this.isLegacy) {
      this.sendFilesUpdate(update);
      return { path: filePath, occurrences };
    }

    return {
      path: filePath,
      filesUpdate: { [filePath]: newFileData },
      occurrences: occurrences,
    };
  }

  /**
   * Search file contents for a literal text pattern.
   * Binary files are skipped.
   */
  grep(
    pattern: string,
    path: string = "/",
    glob: string | null = null,
  ): GrepResult {
    const files = this.getFiles();
    const result = grepMatchesFromFiles(files, pattern, path, glob);
    return { matches: result };
  }

  /**
   * Structured glob matching returning FileInfo objects.
   */
  glob(pattern: string, path: string = "/"): GlobResult {
    const files = this.getFiles();
    const result = globSearchFiles(files, pattern, path);

    if (result === "No files found") {
      return { files: [] };
    }

    const paths = result.split("\n");
    const infos: FileInfo[] = [];
    for (const p of paths) {
      const fd = files[p];
      const size = fd
        ? isFileDataV1(fd)
          ? fd.content.join("\n").length
          : isFileDataBinary(fd)
            ? fd.content.byteLength
            : fd.content.length
        : 0;
      infos.push({
        path: p,
        is_dir: false,
        size: size,
        modified_at: fd?.modified_at || "",
      });
    }
    return { files: infos };
  }

  /**
   * Upload multiple files.
   *
   * Note: Since LangGraph state must be updated via Command objects,
   * the caller must apply filesUpdate via Command after calling this method.
   *
   * @param files - List of [path, content] tuples to upload
   * @returns List of FileUploadResponse objects, one per input file
   */
  uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): FileUploadResponse[] & { filesUpdate?: Record<string, FileData> } {
    const responses: FileUploadResponse[] = [];
    const updates: Record<string, FileData> = {};

    for (const [path, content] of files) {
      try {
        const mimeType = getMimeType(path);

        if (this.fileFormat === "v2" && !isTextMimeType(mimeType)) {
          updates[path] = createFileData(content, undefined, "v2", mimeType);
        } else {
          const contentStr = new TextDecoder().decode(content);
          updates[path] = createFileData(
            contentStr,
            undefined,
            this.fileFormat,
            mimeType,
          );
        }

        responses.push({ path, error: null });
      } catch {
        responses.push({ path, error: "invalid_path" });
      }
    }

    if (!this.isLegacy) {
      if (Object.keys(updates).length > 0) {
        this.sendFilesUpdate(updates);
      }

      return responses as FileUploadResponse[] & {
        filesUpdate?: Record<string, FileData>;
      };
    }

    // Attach filesUpdate for the caller to apply via Command
    const result = responses as FileUploadResponse[] & {
      filesUpdate?: Record<string, FileData>;
    };
    result.filesUpdate = updates;
    return result;
  }

  /**
   * Download multiple files.
   *
   * @param paths - List of file paths to download
   * @returns List of FileDownloadResponse objects, one per input path
   */
  downloadFiles(paths: string[]): FileDownloadResponse[] {
    const files = this.getFiles();
    const responses: FileDownloadResponse[] = [];

    for (const path of paths) {
      const fileData = files[path];
      if (!fileData) {
        responses.push({ path, content: null, error: "file_not_found" });
        continue;
      }

      const fileDataV2 = migrateToFileDataV2(fileData, path);

      if (typeof fileDataV2.content === "string") {
        const content = new TextEncoder().encode(fileDataV2.content);
        responses.push({ path, content, error: null });
      } else {
        responses.push({ path, content: fileDataV2.content, error: null });
      }
    }

    return responses;
  }
}
