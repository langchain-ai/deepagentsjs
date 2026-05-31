/**
 * StoreBackend: Adapter for LangGraph's BaseStore (persistent, cross-thread).
 */

import {
  Item,
  getConfig,
  getCurrentTaskInput,
  getStore as getLangGraphStore,
} from "@langchain/langgraph";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
import type {
  BackendOptions,
  BackendProtocolV2,
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
  WriteResult,
  StateAndStore,
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

const NAMESPACE_COMPONENT_RE = /^[A-Za-z0-9\-_.@+:~]+$/;

function getObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function getAssistantIdFromRecord(
  value: Record<string, unknown> | undefined,
): string | undefined {
  const assistantId = value?.assistant_id ?? value?.assistantId;
  return typeof assistantId === "string" && assistantId.length > 0
    ? assistantId
    : undefined;
}

/**
 * Validate a namespace array.
 *
 * Each component must be a non-empty string containing only safe characters:
 * alphanumeric (a-z, A-Z, 0-9), hyphen (-), underscore (_), dot (.),
 * at sign (@), plus (+), colon (:), and tilde (~).
 *
 * Characters like *, ?, [, ], {, } etc. are rejected to prevent
 * wildcard or glob injection in store lookups.
 */
function validateNamespace(namespace: string[]): string[] {
  if (namespace.length === 0) {
    throw new Error("Namespace array must not be empty.");
  }
  for (let i = 0; i < namespace.length; i++) {
    const component = namespace[i];
    if (typeof component !== "string") {
      throw new TypeError(
        `Namespace component at index ${i} must be a string, got ${typeof component}.`,
      );
    }
    if (!component) {
      throw new Error(`Namespace component at index ${i} must not be empty.`);
    }
    if (!NAMESPACE_COMPONENT_RE.test(component)) {
      throw new Error(
        `Namespace component at index ${i} contains disallowed characters: "${component}". ` +
          `Only alphanumeric characters, hyphens, underscores, dots, @, +, colons, and tildes are allowed.`,
      );
    }
  }
  return namespace;
}

/**
 * Context provided to dynamic namespace factory functions.
 */
export interface StoreBackendContext<StateT = unknown> {
  /**
   * Current graph state, when available.
   *
   * In legacy factory mode this is the injected runtime state. In zero-arg mode
   * this is read from the current LangGraph execution context.
   */
  state: StateT;
  /**
   * Runnable config, when available.
   *
   * This mirrors the Python implementation's access to config metadata for
   * namespace resolution.
   */
  config?: {
    metadata?: Record<string, unknown>;
    configurable?: Record<string, unknown>;
  };
  /**
   * Legacy assistant identifier, resolved from config metadata first and then
   * from the injected runtime for backwards compatibility.
   */
  assistantId?: string;
}

export type StoreBackendNamespaceFactory<StateT = unknown> = (
  context: StoreBackendContext<StateT>,
) => string[];

/**
 * Options for StoreBackend constructor.
 */
export interface StoreBackendOptions<StateT = unknown> extends BackendOptions {
  /**
   * Explicit store instance to use for persistence.
   *
   * This mirrors the Python API and allows constructing a backend directly with
   * a store instance, e.g. `new StoreBackend({ store })`.
   *
   * When omitted, the backend uses the legacy injected runtime store or the
   * LangGraph execution-context store.
   */
  store?: BaseStore;
  /**
   * Custom namespace for store operations.
   *
   * Accepts either a static namespace array or a factory that derives the
   * namespace from the current backend context.
   *
   * If not provided, falls back to legacy assistant-id detection from config
   * metadata, then the injected runtime's `assistantId`, and finally
   * `["filesystem"]`.
   *
   * @example
   * ```typescript
   * // Static namespace
   * new StoreBackend({
   *   namespace: ["memories", orgId, userId, "filesystem"],
   * });
   *
   * // Dynamic namespace
   * new StoreBackend({
   *   namespace: ({ state }) => [
   *     "memories",
   *     (state as { userId: string }).userId,
   *     "filesystem",
   *   ],
   * });
   * ```
   */
  namespace?: string[] | StoreBackendNamespaceFactory<StateT>;
}

/**
 * Backend that stores files in LangGraph's BaseStore (persistent).
 *
 * Uses LangGraph's Store for persistent, cross-conversation storage.
 * Files are organized via namespaces and persist across all threads.
 *
 * The namespace can be customized via a factory function for flexible
 * isolation patterns (user-scoped, org-scoped, etc.), or falls back
 * to legacy assistant_id-based isolation.
 */
export class StoreBackend implements BackendProtocolV2 {
  private stateAndStore: StateAndStore | undefined;
  private storeOverride: BaseStore | undefined;
  private _namespace: string[] | StoreBackendNamespaceFactory | undefined;
  private fileFormat: "v1" | "v2";

  constructor(options?: StoreBackendOptions);
  /**
   * @deprecated Pass no `stateAndStore` argument
   */
  constructor(stateAndStore: StateAndStore, options?: StoreBackendOptions);
  constructor(
    stateAndStoreOrOptions?: StateAndStore | StoreBackendOptions,
    options?: StoreBackendOptions,
  ) {
    let opts: StoreBackendOptions | undefined;
    if (
      stateAndStoreOrOptions != null &&
      typeof stateAndStoreOrOptions === "object" &&
      "state" in stateAndStoreOrOptions
    ) {
      // Legacy path
      this.stateAndStore = stateAndStoreOrOptions;
      opts = options;
    } else {
      this.stateAndStore = undefined;
      opts = stateAndStoreOrOptions;
    }

    if (Array.isArray(opts?.namespace)) {
      this._namespace = validateNamespace(opts.namespace);
    } else if (opts?.namespace) {
      this._namespace = opts.namespace;
    }
    this.storeOverride = opts?.store;
    this.fileFormat = opts?.fileFormat ?? "v2";
  }

  /**
   * Get the BaseStore instance for persistent storage operations.
   *
   * In legacy mode, reads from the injected {@link StateAndStore}.
   * In zero-arg mode, retrieves the store from the LangGraph execution
   * context via {@link getLangGraphStore}.
   *
   * @returns BaseStore instance
   * @throws Error if no store is available in either mode
   */
  private getStore() {
    if (this.stateAndStore) {
      const store = this.stateAndStore.store;
      if (!store) {
        throw new Error("Store is required but not available in runtime");
      }
      return store;
    }

    if (this.storeOverride) {
      return this.storeOverride;
    }

    const store = getLangGraphStore();
    if (!store) {
      throw new Error(
        "Store is required but not available in LangGraph execution context. " +
          "Ensure the graph was configured with a store.",
      );
    }

    return store;
  }

  /**
   * Get the current graph state when available.
   */
  private getState(): unknown {
    if (this.stateAndStore) {
      return this.stateAndStore.state;
    }

    try {
      return getCurrentTaskInput();
    } catch {
      return undefined;
    }
  }

  /**
   * Get the most relevant runnable config for namespace resolution.
   */
  private getNamespaceConfig():
    | {
        metadata?: Record<string, unknown>;
        configurable?: Record<string, unknown>;
      }
    | undefined {
    const injectedConfig = getObjectRecord(
      (this.stateAndStore as { config?: unknown } | undefined)?.config,
    );
    if (injectedConfig) {
      return {
        metadata: getObjectRecord(injectedConfig.metadata),
        configurable: getObjectRecord(injectedConfig.configurable),
      };
    }

    try {
      const config = getConfig();
      const configRecord = getObjectRecord(config);
      if (!configRecord) {
        return undefined;
      }
      return {
        metadata: getObjectRecord(configRecord.metadata),
        configurable: getObjectRecord(configRecord.configurable),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Legacy assistant-id detection compatible with both Python and the
   * historical TypeScript `assistantId` runtime property.
   */
  private getLegacyAssistantId(): string | undefined {
    const config = this.getNamespaceConfig();
    const assistantIdFromConfig =
      getAssistantIdFromRecord(config?.metadata) ??
      getAssistantIdFromRecord(config?.configurable);
    if (assistantIdFromConfig) {
      return assistantIdFromConfig;
    }

    const assistantId = this.stateAndStore?.assistantId;
    return typeof assistantId === "string" && assistantId.length > 0
      ? assistantId
      : undefined;
  }

  /**
   * Get the namespace for store operations.
   *
   * Resolution order:
   * 1. Explicit namespace from constructor options
   * 2. Namespace factory resolved from the current backend context
   * 3. Assistant ID from runtime config / LangGraph config metadata
   * 4. Legacy `assistantId` from the injected runtime
   * 5. `["filesystem"]`
   */
  protected getNamespace(): string[] {
    if (Array.isArray(this._namespace)) {
      return this._namespace;
    }

    if (this._namespace) {
      return validateNamespace(
        this._namespace({
          state: this.getState(),
          config: this.getNamespaceConfig(),
          assistantId: this.getLegacyAssistantId(),
        }),
      );
    }

    const assistantId = this.getLegacyAssistantId();
    if (assistantId) {
      return [assistantId, "filesystem"];
    }

    return ["filesystem"];
  }

  /**
   * Convert a store Item to FileData format.
   *
   * @param storeItem - The store Item containing file data
   * @returns FileData object
   * @throws Error if required fields are missing or have incorrect types
   */
  private convertStoreItemToFileData(storeItem: Item): FileData {
    const value = storeItem.value as any;

    const hasValidContent =
      value.content !== undefined &&
      (Array.isArray(value.content) ||
        typeof value.content === "string" ||
        ArrayBuffer.isView(value.content));

    if (
      !hasValidContent ||
      typeof value.created_at !== "string" ||
      typeof value.modified_at !== "string"
    ) {
      throw new Error(
        `Store item does not contain valid FileData fields. Got keys: ${Object.keys(value).join(", ")}`,
      );
    }

    return {
      content: value.content,
      ...(value.mimeType ? { mimeType: value.mimeType } : {}),
      created_at: value.created_at,
      modified_at: value.modified_at,
    };
  }

  /**
   * Convert FileData to a value suitable for store.put().
   *
   * @param fileData - The FileData to convert
   * @returns Object with content, mimeType, created_at, and modified_at fields
   */
  private convertFileDataToStoreValue(fileData: FileData): Record<string, any> {
    return {
      content: fileData.content,
      ...("mimeType" in fileData ? { mimeType: fileData.mimeType } : {}),
      created_at: fileData.created_at,
      modified_at: fileData.modified_at,
    };
  }

  /**
   * Search store with automatic pagination to retrieve all results.
   *
   * @param store - The store to search
   * @param namespace - Hierarchical path prefix to search within
   * @param options - Optional query, filter, and page_size
   * @returns List of all items matching the search criteria
   */
  private async searchStorePaginated(
    store: any,
    namespace: string[],
    options: {
      query?: string;
      filter?: Record<string, any>;
      pageSize?: number;
    } = {},
  ): Promise<Item[]> {
    const { query, filter, pageSize = 100 } = options;
    const allItems: Item[] = [];
    let offset = 0;

    while (true) {
      const pageItems = await store.search(namespace, {
        query,
        filter,
        limit: pageSize,
        offset,
      });

      if (!pageItems || pageItems.length === 0) {
        break;
      }

      allItems.push(...pageItems);

      if (pageItems.length < pageSize) {
        break;
      }

      offset += pageSize;
    }

    return allItems;
  }

  /**
   * List files and directories in the specified directory (non-recursive).
   *
   * @param path - Absolute path to directory
   * @returns LsResult with list of FileInfo objects on success or error on failure.
   *          Directories have a trailing / in their path and is_dir=true.
   */
  async ls(path: string): Promise<LsResult> {
    const store = this.getStore();
    const namespace = this.getNamespace();

    // Retrieve all items and filter by path prefix locally to avoid
    // coupling to store-specific filter semantics
    const items = await this.searchStorePaginated(store, namespace);
    const infos: FileInfo[] = [];
    const subdirs = new Set<string>();

    // Normalize path to have trailing slash for proper prefix matching
    const normalizedPath = path.endsWith("/") ? path : path + "/";

    for (const item of items) {
      const itemKey = String(item.key);

      // Check if file is in the specified directory or a subdirectory
      if (!itemKey.startsWith(normalizedPath)) {
        continue;
      }

      // Get the relative path after the directory
      const relative = itemKey.substring(normalizedPath.length);

      // If relative path contains '/', it's in a subdirectory
      if (relative.includes("/")) {
        // Extract the immediate subdirectory name
        const subdirName = relative.split("/")[0];
        subdirs.add(normalizedPath + subdirName + "/");
        continue;
      }

      // This is a file directly in the current directory
      try {
        const fd = this.convertStoreItemToFileData(item);
        const size = isFileDataV1(fd)
          ? fd.content.join("\n").length
          : isFileDataBinary(fd)
            ? fd.content.byteLength
            : fd.content.length;
        infos.push({
          path: itemKey,
          is_dir: false,
          size: size,
          modified_at: fd.modified_at,
        });
      } catch {
        // Skip invalid items
        continue;
      }
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
  async read(
    filePath: string,
    offset: number = 0,
    limit: number = 500,
  ): Promise<ReadResult> {
    try {
      const readRawResult = await this.readRaw(filePath);
      if (readRawResult.error || !readRawResult.data) {
        return { error: readRawResult.error || "File data not found" };
      }

      const fileDataV2 = migrateToFileDataV2(readRawResult.data, filePath);

      // ignore pagination and return full content
      if (!isTextMimeType(fileDataV2.mimeType)) {
        return { content: fileDataV2.content, mimeType: fileDataV2.mimeType };
      }

      if (typeof fileDataV2.content !== "string") {
        return {
          error: `File '${filePath}' has binary content but text MIME type`,
        };
      }
      const lines = fileDataV2.content.split("\n");
      const selected = lines.slice(offset, offset + limit);
      return { content: selected.join("\n"), mimeType: fileDataV2.mimeType };
    } catch (e: any) {
      return { error: e.message };
    }
  }

  /**
   * Read file content as raw FileData.
   *
   * @param filePath - Absolute file path
   * @returns ReadRawResult with raw file data on success or error on failure
   */
  async readRaw(filePath: string): Promise<ReadRawResult> {
    const store = this.getStore();
    const namespace = this.getNamespace();
    const item = await store.get(namespace, filePath);

    if (!item) {
      return { error: `File '${filePath}' not found` };
    }
    return { data: this.convertStoreItemToFileData(item) };
  }

  /**
   * Create a new file with content.
   * Returns WriteResult. External storage sets filesUpdate=null.
   */
  async write(filePath: string, content: string): Promise<WriteResult> {
    const store = this.getStore();
    const namespace = this.getNamespace();

    // Check if file exists
    const existing = await store.get(namespace, filePath);
    if (existing) {
      return {
        error: `Cannot write to ${filePath} because it already exists. Read and then make an edit, or write to a new path.`,
      };
    }

    // Create new file
    const mimeType = getMimeType(filePath);
    const fileData = createFileData(
      content,
      undefined,
      this.fileFormat,
      mimeType,
    );
    const storeValue = this.convertFileDataToStoreValue(fileData);
    await store.put(namespace, filePath, storeValue);
    return { path: filePath, filesUpdate: null };
  }

  /**
   * Edit a file by replacing string occurrences.
   * Returns EditResult. External storage sets filesUpdate=null.
   */
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): Promise<EditResult> {
    const store = this.getStore();
    const namespace = this.getNamespace();

    // Get existing file
    const item = await store.get(namespace, filePath);
    if (!item) {
      return { error: `Error: File '${filePath}' not found` };
    }

    try {
      const fileData = this.convertStoreItemToFileData(item);
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

      // Update file in store
      const storeValue = this.convertFileDataToStoreValue(newFileData);
      await store.put(namespace, filePath, storeValue);
      return { path: filePath, filesUpdate: null, occurrences: occurrences };
    } catch (e: any) {
      return { error: `Error: ${e.message}` };
    }
  }

  /**
   * Search file contents for a literal text pattern.
   * Binary files are skipped.
   */
  async grep(
    pattern: string,
    path: string = "/",
    glob: string | null = null,
  ): Promise<GrepResult> {
    const store = this.getStore();
    const namespace = this.getNamespace();
    const items = await this.searchStorePaginated(store, namespace);

    const files: Record<string, FileData> = {};
    for (const item of items) {
      try {
        files[item.key] = this.convertStoreItemToFileData(item);
      } catch {
        // Skip invalid items
        continue;
      }
    }

    const matches = grepMatchesFromFiles(files, pattern, path, glob);
    return { matches };
  }

  /**
   * Structured glob matching returning FileInfo objects.
   */
  async glob(pattern: string, path: string = "/"): Promise<GlobResult> {
    const store = this.getStore();
    const namespace = this.getNamespace();
    const items = await this.searchStorePaginated(store, namespace);

    const files: Record<string, FileData> = {};
    for (const item of items) {
      try {
        files[item.key] = this.convertStoreItemToFileData(item);
      } catch {
        // Skip invalid items
        continue;
      }
    }

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
   * @param files - List of [path, content] tuples to upload
   * @returns List of FileUploadResponse objects, one per input file
   */
  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const store = this.getStore();
    const namespace = this.getNamespace();
    const responses: FileUploadResponse[] = [];

    for (const [path, content] of files) {
      try {
        const mimeType = getMimeType(path);
        const isBinary = this.fileFormat === "v2" && !isTextMimeType(mimeType);

        let fileData: FileData;
        if (isBinary) {
          fileData = createFileData(content, undefined, "v2", mimeType);
        } else {
          const contentStr = new TextDecoder().decode(content);
          fileData = createFileData(
            contentStr,
            undefined,
            this.fileFormat,
            mimeType,
          );
        }

        const storeValue = this.convertFileDataToStoreValue(fileData);
        await store.put(namespace, path, storeValue);
        responses.push({ path, error: null });
      } catch {
        responses.push({ path, error: "invalid_path" });
      }
    }

    return responses;
  }

  /**
   * Download multiple files.
   *
   * @param paths - List of file paths to download
   * @returns List of FileDownloadResponse objects, one per input path
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const store = this.getStore();
    const namespace = this.getNamespace();
    const responses: FileDownloadResponse[] = [];

    for (const path of paths) {
      try {
        const item = await store.get(namespace, path);
        if (!item) {
          responses.push({ path, content: null, error: "file_not_found" });
          continue;
        }

        const fileData = this.convertStoreItemToFileData(item);
        const fileDataV2 = migrateToFileDataV2(fileData, path);

        if (typeof fileDataV2.content === "string") {
          const content = new TextEncoder().encode(fileDataV2.content);
          responses.push({ path, content, error: null });
        } else {
          responses.push({ path, content: fileDataV2.content, error: null });
        }
      } catch {
        responses.push({ path, content: null, error: "file_not_found" });
      }
    }

    return responses;
  }
}
