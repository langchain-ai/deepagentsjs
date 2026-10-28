/**
 * StateBackend: Store files in LangGraph agent state (ephemeral).
 */

import type {
  DeleteResult,
  EditResult,
  FileData,
  FileDataV2,
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
import { applyGrepMaxCount } from "./protocol.js";
import {
  createFileData,
  createWriteFileData,
  fileDataToString,
  getMimeType,
  globSearchFiles,
  grepMatchesFromFiles,
  isFileDataBinary,
  isFileDataV1,
  isTextMimeType,
  migrateToFileDataV2,
  normalizeReadPagination,
  performStringReplacement,
  updateFileData,
} from "./utils.js";
import { getConfig } from "@langchain/langgraph";

function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end--;
  return path.slice(0, end);
}

const PREGEL_SEND_KEY = "__pregel_send";
const PREGEL_READ_KEY = "__pregel_read";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isBase64Encoded(
  data: FileData,
): data is FileDataV2 & { content: string; encoding: "base64" } {
  return (
    !isFileDataV1(data) &&
    data.encoding === "base64" &&
    typeof data.content === "string"
  );
}

/**
 * Store binary content as base64 text. State is checkpointed as JSON, which
 * turns a Uint8Array into an object of numeric keys that fails the files
 * schema on the next run.
 */
function toStoredFileData(data: FileData): FileData {
  if (!isFileDataBinary(data)) {
    return data;
  }
  return { ...data, content: bytesToBase64(data.content), encoding: "base64" };
}

/** Decode base64-stored content so readers keep getting Uint8Array bytes. */
function fromStoredFileData(data: FileData): FileData {
  if (!isBase64Encoded(data)) {
    return data;
  }
  return {
    content: base64ToBytes(data.content),
    mimeType: data.mimeType,
    created_at: data.created_at,
    modified_at: data.modified_at,
  };
}

function fileSize(data: FileData): number {
  if (isFileDataV1(data)) {
    return data.content.join("\n").length;
  }
  if (typeof data.content !== "string") {
    return data.content.byteLength;
  }
  if (data.encoding !== "base64") {
    return data.content.length;
  }
  const padding = data.content.endsWith("==")
    ? 2
    : data.content.endsWith("=")
      ? 1
      : 0;
  return (data.content.length * 3) / 4 - padding;
}

/** Strict UTF-8 decode; undefined when the bytes are not valid UTF-8. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

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
  /** Class identity discriminant for {@link StateBackend.isInstance}. */
  readonly backendKind = "state" as const;

  private runtime: BackendRuntime | undefined;
  private fileFormat: "v1" | "v2";

  /** Duck-typed so this survives the plain-object copies `adaptBackendProtocol` makes — a class check wouldn't. */
  static isInstance(backend: unknown): backend is StateBackend {
    return (
      typeof backend === "object" &&
      backend !== null &&
      (backend as Record<string, unknown>).backendKind === "state"
    );
  }

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
   * In zero-arg mode, reads via {@link PREGEL_READ_KEY} with fresh=true,
   * which applies any pending task writes through the reducer before returning.
   */
  private get files(): Record<string, FileData> {
    if (this.runtime) {
      return (
        (this.runtime.state as { files?: Record<string, FileData> }).files ?? {}
      );
    }

    const read = getConfig().configurable?.[PREGEL_READ_KEY] as
      | ((
          channel: string,
          fresh: boolean,
        ) => Record<string, FileData> | undefined)
      | undefined;

    return read?.("files", true) ?? {};
  }

  /**
   * Push a files state update through LangGraph's internal send channel.
   *
   * In zero-arg mode, sends the update via the `__pregel_send` function
   * from {@link getConfig}, mirroring Python's `CONFIG_KEY_SEND`.
   * In legacy mode, this is a no-op — the caller uses `filesUpdate`
   * from the return value instead.
   *
   * @param update - Map of file paths to their updated {@link FileData},
   *   or null deletion markers.
   */
  private sendFilesUpdate(update: Record<string, FileData | null>): void {
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
    const files = this.files;
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
      infos.push({
        path: k,
        is_dir: false,
        size: fileSize(fd),
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
    const files = this.files;
    const fileData = files[filePath];

    if (!fileData) {
      return { error: `File '${filePath}' not found` };
    }

    const fileDataV2 = migrateToFileDataV2(
      fromStoredFileData(fileData),
      filePath,
    );

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
    const { offset: normalizedOffset, limit: normalizedLimit } =
      normalizeReadPagination(offset, limit);
    const lines = fileDataV2.content.split("\n");
    const totalLines =
      lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    const selected = lines.slice(
      normalizedOffset,
      normalizedOffset + normalizedLimit,
    );
    if (
      selected.length === 0 ||
      normalizedOffset >= totalLines ||
      normalizedLimit === 0
    ) {
      return { content: selected.join("\n"), mimeType: fileDataV2.mimeType };
    }
    const endOffset = Math.min(normalizedOffset + selected.length, totalLines);
    return {
      content: selected.join("\n"),
      mimeType: fileDataV2.mimeType,
      totalLines,
      startLine: normalizedOffset + 1,
      endLine: endOffset,
      nextOffset: endOffset < totalLines ? endOffset : undefined,
    };
  }

  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns ReadRawResult with raw file data on success or error on failure
   */
  readRaw(filePath: string): ReadRawResult {
    const files = this.files;
    const fileData = files[filePath];

    if (!fileData) {
      return { error: `File '${filePath}' not found` };
    }
    return { data: fromStoredFileData(fileData) };
  }

  /**
   * Write content to a file, creating it or overwriting it if it already exists.
   * Returns WriteResult with filesUpdate to update LangGraph state.
   */
  write(filePath: string, content: string): WriteResult {
    const files = this.files;
    const stored = files[filePath];
    // A text path holding a non-UTF-8 upload is typed application/octet-stream;
    // text written over it must read back as the path's own type.
    const existing =
      stored && isBase64Encoded(stored)
        ? { ...stored, mimeType: getMimeType(filePath) }
        : stored;

    const newFileData = toStoredFileData(
      createWriteFileData(filePath, content, this.fileFormat, existing),
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
   * Delete a file or directory from state.
   *
   * Removes the exact file path plus every nested key under it.
   */
  delete(filePath: string): DeleteResult {
    const files = this.files;
    const base = trimTrailingSlashes(filePath) || "/";
    const prefix = base === "/" ? "/" : `${base}/`;
    const paths = Object.keys(files).filter(
      (path) => path === base || path.startsWith(prefix),
    );

    if (paths.length === 0) {
      return { error: `Error: File '${filePath}' not found` };
    }

    const update: Record<string, null> = Object.fromEntries(
      paths.map((path) => [path, null]),
    );

    if (!this.isLegacy) {
      this.sendFilesUpdate(update);
      return { path: filePath };
    }

    return { path: filePath, filesUpdate: update };
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
    const files = this.files;
    const fileData = files[filePath];

    if (!fileData) {
      return { error: `Error: File '${filePath}' not found` };
    }

    const content = fileDataToString(fromStoredFileData(fileData));
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
    maxCount: number | null = null,
  ): GrepResult {
    const files = this.files;
    const result = grepMatchesFromFiles(files, pattern, path, glob);
    return applyGrepMaxCount({ result: { matches: result }, maxCount });
  }

  /**
   * Structured glob matching returning FileInfo objects.
   */
  glob(pattern: string, path: string = "/"): GlobResult {
    const files = this.files;
    const result = globSearchFiles(files, pattern, path);

    if (result === "No files found") {
      return { files: [] };
    }

    const paths = result.split("\n");
    const infos: FileInfo[] = [];
    for (const p of paths) {
      const fd = files[p];
      infos.push({
        path: p,
        is_dir: false,
        size: fd ? fileSize(fd) : 0,
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
        updates[path] = toStoredFileData(
          this.createUploadFileData(path, content),
        );
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
   * Build FileData for an uploaded file.
   *
   * In v2, bytes at a binary MIME type stay binary, and bytes at a text MIME
   * type that are not valid UTF-8 are kept as application/octet-stream rather
   * than lossily decoded. v1 cannot hold binary, so it always decodes as text.
   */
  private createUploadFileData(path: string, content: Uint8Array): FileData {
    const mimeType = getMimeType(path);
    if (this.fileFormat === "v1") {
      const text = new TextDecoder().decode(content);
      return createFileData(text, undefined, "v1", mimeType);
    }
    if (!isTextMimeType(mimeType)) {
      return createFileData(content, undefined, "v2", mimeType);
    }
    const text = decodeUtf8(content);
    return text === undefined
      ? createFileData(content, undefined, "v2", "application/octet-stream")
      : createFileData(text, undefined, "v2", mimeType);
  }

  /**
   * Download multiple files.
   *
   * @param paths - List of file paths to download
   * @returns List of FileDownloadResponse objects, one per input path
   */
  downloadFiles(paths: string[]): FileDownloadResponse[] {
    const files = this.files;
    const responses: FileDownloadResponse[] = [];

    for (const path of paths) {
      const fileData = files[path];
      if (!fileData) {
        responses.push({ path, content: null, error: "file_not_found" });
        continue;
      }

      const fileDataV2 = migrateToFileDataV2(
        fromStoredFileData(fileData),
        path,
      );

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
