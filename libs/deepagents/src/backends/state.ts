/**
 * StateBackend: Store files in LangGraph agent state (ephemeral).
 */

import type {
  BackendProtocol,
  EditResult,
  FileData,
  FileDownloadResponse,
  FileInfo,
  FileUploadResponse,
  GrepMatch,
  StateAndStore,
  WriteResult,
} from "./protocol.js";
import {
  createFileData,
  fileDataToString,
  formatReadResponse,
  globSearchFiles,
  grepMatchesFromFiles,
  performStringReplacement,
  updateFileData,
} from "./utils.js";

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
export class StateBackend implements BackendProtocol {
  private stateAndStore: StateAndStore;

  constructor(stateAndStore: StateAndStore) {
    this.stateAndStore = stateAndStore;
  }

  /**
   * Get files from current state.
   */
  private getFiles(): Record<string, FileData> {
    return (
      ((this.stateAndStore.state as any).files as Record<string, FileData>) ||
      {}
    );
  }

  /**
   * List files and directories in the specified directory (non-recursive).
   *
   * @param path - Absolute path to directory
   * @returns List of FileInfo objects for files and directories directly in the directory.
   *          Directories have a trailing / in their path and is_dir=true.
   */
  lsInfo(path: string): FileInfo[] {
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
      const size = fd.content.join("\n").length;
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
    return infos;
  }

  /**
   * Read file content with line numbers.
   *
   * @param filePath - Absolute file path
   * @param offset - Line offset to start reading from (0-indexed)
   * @param limit - Maximum number of lines to read
   * @returns Formatted file content with line numbers, or error message
   */
  read(filePath: string, offset: number = 0, limit: number = 500): string {
    const files = this.getFiles();
    const fileData = files[filePath];

    if (!fileData) {
      return `Error: File '${filePath}' not found`;
    }

    return formatReadResponse(fileData, offset, limit);
  }

  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns Raw file content as FileData
   */
  readRaw(filePath: string): FileData {
    const files = this.getFiles();
    const fileData = files[filePath];

    if (!fileData) throw new Error(`File '${filePath}' not found`);
    return fileData;
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

    const newFileData = createFileData(content);
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
    return {
      path: filePath,
      filesUpdate: { [filePath]: newFileData },
      occurrences: occurrences,
    };
  }

  /**
   * Structured search results or error string for invalid input.
   */
  grepRaw(
    pattern: string,
    path: string = "/",
    glob: string | null = null,
  ): GrepMatch[] | string {
    const files = this.getFiles();
    return grepMatchesFromFiles(files, pattern, path, glob);
  }

  /**
   * Structured glob matching returning FileInfo objects.
   */
  globInfo(pattern: string, path: string = "/"): FileInfo[] {
    const files = this.getFiles();
    const result = globSearchFiles(files, pattern, path);

    if (result === "No files found") {
      return [];
    }

    const paths = result.split("\n");
    const infos: FileInfo[] = [];
    for (const p of paths) {
      const fd = files[p];
      const size = fd ? fd.content.join("\n").length : 0;
      infos.push({
        path: p,
        is_dir: false,
        size: size,
        modified_at: fd?.modified_at || "",
      });
    }
    return infos;
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
        const contentStr = new TextDecoder().decode(content);
        const fileData = createFileData(contentStr);
        updates[path] = fileData;
        responses.push({ path, error: null });
      } catch {
        responses.push({ path, error: "invalid_path" });
      }
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

      const contentStr = fileDataToString(fileData);
      const content = new TextEncoder().encode(contentStr);
      responses.push({ path, content, error: null });
    }

    return responses;
  }
}
