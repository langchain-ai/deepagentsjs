/* oxlint-disable no-instanceof/no-instanceof */
/**
 * Node.js VFS backend implementation of BackendProtocolV2.
 *
 * This module provides an in-memory virtual file system backend for deepagents,
 * enabling agents to work with files in an isolated environment without touching
 * the real filesystem.
 *
 * Uses the node-vfs-polyfill package which implements the upcoming Node.js VFS
 * feature (nodejs/node#61478).
 *
 * @packageDocumentation
 */

import path from "node:path";
import type { Stats } from "node:fs";

import {
  type BackendProtocolV2,
  type DeleteResult,
  type EditResult,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
  type GlobResult,
  type GrepResult,
  type LsResult,
  type ReadRawResult,
  type ReadResult,
  type BackendFactory,
  type WriteResult,
} from "deepagents";

import { VirtualFileSystem } from "node-vfs-polyfill";

import { VfsSandboxError, type VfsBackendOptions } from "./types.js";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aiff": "audio/aiff",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mpeg": "video/mpeg",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".mpg": "video/mpeg",
  ".wmv": "video/x-ms-wmv",
  ".3gpp": "video/3gpp",
  ".pdf": "application/pdf",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function getMimeType(filePath: string): string {
  const ext = path.posix.extname(filePath).toLocaleLowerCase();
  return MIME_TYPES[ext] || "text/plain";
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/javascript" ||
    mimeType === "image/svg+xml"
  );
}

const MAX_GLOB_PATTERN_LENGTH = 512;
const MAX_GLOB_SEGMENTS = 64;
const MAX_GLOBSTAR_SEGMENTS = 16;

type SegmentToken =
  | { type: "star" }
  | { type: "qmark" }
  | { type: "literal"; value: string }
  | { type: "class"; negated: boolean; specs: CharacterClassSpec[] };

type CharacterClassSpec =
  | { type: "char"; value: string }
  | { type: "range"; start: string; end: string };

function validateGlobPattern(pattern: string): string | null {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
    return `Glob pattern exceeds maximum length (${MAX_GLOB_PATTERN_LENGTH})`;
  }
  if (
    pattern.includes("\u0000") ||
    pattern.includes("\r") ||
    pattern.includes("\n")
  ) {
    return "Glob pattern contains invalid control characters";
  }

  const segments = pattern.split("/");
  if (segments.length > MAX_GLOB_SEGMENTS) {
    return `Glob pattern exceeds maximum segment count (${MAX_GLOB_SEGMENTS})`;
  }

  const globstarCount = segments.filter((segment) => segment === "**").length;
  if (globstarCount > MAX_GLOBSTAR_SEGMENTS) {
    return `Glob pattern exceeds maximum '**' count (${MAX_GLOBSTAR_SEGMENTS})`;
  }

  return null;
}

function tokenizeSegmentPattern(segmentPattern: string): SegmentToken[] {
  const tokens: SegmentToken[] = [];

  for (let i = 0; i < segmentPattern.length; i++) {
    const ch = segmentPattern[i];

    if (ch === "*") {
      // Collapse consecutive '*' tokens in a single segment.
      if (tokens[tokens.length - 1]?.type !== "star") {
        tokens.push({ type: "star" });
      }
      continue;
    }

    if (ch === "?") {
      tokens.push({ type: "qmark" });
      continue;
    }

    if (ch !== "[") {
      tokens.push({ type: "literal", value: ch });
      continue;
    }

    let j = i + 1;
    while (j < segmentPattern.length && segmentPattern[j] !== "]") {
      j++;
    }

    // Treat unterminated classes literally.
    if (j >= segmentPattern.length) {
      tokens.push({ type: "literal", value: "[" });
      continue;
    }

    const rawClass = segmentPattern.slice(i + 1, j);
    const parsedClass = parseCharacterClass(rawClass);
    if (parsedClass.specs.length === 0) {
      // Preserve previous behavior for malformed classes by treating '[' literally.
      tokens.push({ type: "literal", value: "[" });
      continue;
    }

    tokens.push({
      type: "class",
      negated: parsedClass.negated,
      specs: parsedClass.specs,
    });
    i = j;
  }

  return tokens;
}

function parseCharacterClass(rawClass: string): {
  negated: boolean;
  specs: CharacterClassSpec[];
} {
  if (!rawClass) {
    return { negated: false, specs: [] };
  }

  let cursor = 0;
  let negated = false;
  if (rawClass[0] === "!" || rawClass[0] === "^") {
    negated = true;
    cursor = 1;
  }

  const specs: CharacterClassSpec[] = [];
  while (cursor < rawClass.length) {
    const start = rawClass[cursor];
    const hasRange =
      cursor + 2 < rawClass.length && rawClass[cursor + 1] === "-";

    if (hasRange) {
      specs.push({
        type: "range",
        start,
        end: rawClass[cursor + 2],
      });
      cursor += 3;
      continue;
    }

    specs.push({ type: "char", value: start });
    cursor += 1;
  }

  return { negated, specs };
}

function matchesCharacterClass(
  ch: string,
  negated: boolean,
  specs: CharacterClassSpec[],
): boolean {
  let matched = false;
  const code = ch.charCodeAt(0);

  for (const spec of specs) {
    if (spec.type === "char") {
      if (ch === spec.value) {
        matched = true;
        break;
      }
      continue;
    }

    const startCode = spec.start.charCodeAt(0);
    const endCode = spec.end.charCodeAt(0);
    const lower = Math.min(startCode, endCode);
    const upper = Math.max(startCode, endCode);
    if (code >= lower && code <= upper) {
      matched = true;
      break;
    }
  }

  return negated ? !matched : matched;
}

function matchSegmentPattern(segmentPattern: string, segment: string): boolean {
  const tokens = tokenizeSegmentPattern(segmentPattern);
  const memo = new Map<string, boolean>();

  const match = (ti: number, si: number): boolean => {
    const key = `${ti}:${si}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    if (ti === tokens.length) {
      const done = si === segment.length;
      memo.set(key, done);
      return done;
    }

    const token = tokens[ti];
    let result = false;

    if (token.type === "star") {
      result = match(ti + 1, si) || (si < segment.length && match(ti, si + 1));
    } else if (token.type === "qmark") {
      result = si < segment.length && match(ti + 1, si + 1);
    } else if (token.type === "literal") {
      result =
        si < segment.length &&
        segment[si] === token.value &&
        match(ti + 1, si + 1);
    } else if (token.type === "class") {
      result =
        si < segment.length &&
        matchesCharacterClass(segment[si], token.negated, token.specs) &&
        match(ti + 1, si + 1);
    }

    memo.set(key, result);
    return result;
  };

  return match(0, 0);
}

function splitPathSegments(value: string): string[] {
  if (!value) return [];
  return value.split("/").filter((segment) => segment.length > 0);
}

function globMatchesPath(pattern: string, candidate: string): boolean {
  const patternSegments = splitPathSegments(pattern);
  const candidateSegments = splitPathSegments(candidate);
  const memo = new Map<string, boolean>();

  const match = (pi: number, ci: number): boolean => {
    const key = `${pi}:${ci}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }

    if (pi === patternSegments.length) {
      const done = ci === candidateSegments.length;
      memo.set(key, done);
      return done;
    }

    const segmentPattern = patternSegments[pi];
    let result = false;

    if (segmentPattern === "**") {
      // "**" can match zero segments or consume one segment and continue.
      result =
        match(pi + 1, ci) ||
        (ci < candidateSegments.length && match(pi, ci + 1));
    } else {
      result =
        ci < candidateSegments.length &&
        matchSegmentPattern(segmentPattern, candidateSegments[ci]) &&
        match(pi + 1, ci + 1);
    }

    memo.set(key, result);
    return result;
  };

  return match(0, 0);
}

function performStringReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): [string, number] | string {
  if (content === "" && oldString === "") {
    return [newString, 0];
  }

  if (oldString === "") {
    return "Error: oldString cannot be empty when file has content";
  }

  const occurrences = content.split(oldString).length - 1;

  if (occurrences === 0) {
    return `Error: String not found in file: '${oldString}'`;
  }

  if (occurrences > 1 && !replaceAll) {
    return `Error: String '${oldString}' has multiple occurrences (appears ${occurrences} times) in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.`;
  }

  return [content.split(oldString).join(newString), occurrences];
}

/**
 * Node.js VFS backend for deepagents.
 *
 * Provides an in-memory virtual file system for agent operations, allowing
 * agents to read/write files without affecting the real filesystem.
 *
 * This implementation uses node-vfs-polyfill which implements the upcoming
 * Node.js VFS feature. Files are stored entirely in-memory using the VFS.
 *
 * ## Basic Usage
 *
 * ```typescript
 * import { VfsBackend } from "@langchain/node-vfs";
 *
 * // Create and initialize a VFS backend
 * const backend = await VfsBackend.create({
 *   initialFiles: {
 *     "/src/index.js": "console.log('Hello')",
 *   },
 * });
 *
 * try {
 *   // Read files directly
 *   const result = await backend.read("/src/index.js");
 *   console.log(result.content);
 * } finally {
 *   await backend.stop();
 * }
 * ```
 *
 * ## Using with DeepAgent
 *
 * ```typescript
 * import { createDeepAgent } from "deepagents";
 * import { VfsBackend } from "@langchain/node-vfs";
 *
 * const backend = await VfsBackend.create();
 *
 * const agent = createDeepAgent({
 *   model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *   systemPrompt: "You are a coding assistant with VFS access.",
 *   backend,
 * });
 * ```
 */
export class VfsBackend implements BackendProtocolV2 {
  /** Private reference to the VirtualFileSystem instance */
  #vfs?: VirtualFileSystem;

  /** Configuration options for this backend */
  #options: VfsBackendOptions;

  /** The working directory path (virtual) */
  #workingDirectory: string;

  /** Whether the backend is initialized */
  #initialized = false;

  /**
   * Get the VirtualFileSystem instance.
   */
  get instance(): VirtualFileSystem {
    if (!this.#vfs) {
      throw new VfsSandboxError(
        "VFS not initialized. Call initialize() or use VfsBackend.create()",
        "NOT_INITIALIZED",
      );
    }
    return this.#vfs;
  }

  /**
   * Get the working directory path.
   */
  get workingDirectory(): string {
    return this.#workingDirectory;
  }

  /**
   * Check if the backend is initialized and running.
   */
  get isRunning(): boolean {
    return this.#initialized;
  }

  /**
   * Check if VFS mode is active.
   */
  get isVfsMode(): boolean {
    return this.#vfs !== undefined;
  }

  /**
   * Create a new VfsBackend instance.
   *
   * Note: This only creates the instance. Call `initialize()` to actually
   * set up the VFS, or use the static `VfsBackend.create()` method.
   *
   * @param options - Configuration options for the backend
   */
  constructor(options: VfsBackendOptions = {}) {
    this.#options = options;
    this.#workingDirectory = "/workspace";
  }

  /**
   * Initialize the VFS backend.
   *
   * This method sets up the virtual file system and populates it with
   * any initial files specified in the options.
   *
   * @throws {VfsSandboxError} If already initialized (`ALREADY_INITIALIZED`)
   * @throws {VfsSandboxError} If initialization fails (`INITIALIZATION_FAILED`)
   */
  async initialize(): Promise<void> {
    if (this.#initialized) {
      throw new VfsSandboxError(
        "VFS Backend is already initialized.",
        "ALREADY_INITIALIZED",
      );
    }

    // Create VFS instance
    this.#vfs = new VirtualFileSystem();

    // Create the root workspace directory
    this.#vfs.mkdirSync(this.#workingDirectory, { recursive: true });

    // Populate initial files if provided
    if (this.#options.initialFiles) {
      for (const [filePath, content] of Object.entries(
        this.#options.initialFiles,
      )) {
        const fullPath = path.posix.join(this.#workingDirectory, filePath);
        const parentDir = path.posix.dirname(fullPath);

        // Ensure parent directory exists
        this.#vfs.mkdirSync(parentDir, { recursive: true });

        // Write the file
        const data =
          typeof content === "string" ? content : Buffer.from(content);
        this.#vfs.writeFileSync(fullPath, data);
      }
    }

    this.#initialized = true;
  }

  #resolvePath(inputPath: string): string | null {
    const raw = inputPath.trim() || ".";
    const normalizedInput = raw === "/" ? "." : path.posix.normalize(raw);

    const candidate =
      normalizedInput === this.#workingDirectory ||
      normalizedInput.startsWith(`${this.#workingDirectory}/`)
        ? normalizedInput
        : path.posix.resolve(
            this.#workingDirectory,
            normalizedInput.startsWith("/")
              ? normalizedInput.slice(1)
              : normalizedInput,
          );

    if (
      candidate !== this.#workingDirectory &&
      !candidate.startsWith(`${this.#workingDirectory}/`)
    ) {
      return null;
    }

    return candidate;
  }

  #toPublicPath(absolutePath: string): string {
    const relative = path.posix.relative(this.#workingDirectory, absolutePath);
    if (!relative || relative === ".") {
      return ".";
    }
    return relative;
  }

  #walk(
    basePath: string,
    callback: (
      fullPath: string,
      isDir: boolean,
      mtime: Date,
      size: number,
    ) => void,
  ): void {
    let entries: Array<{ name: string }>;
    try {
      entries = this.instance.readdirSync(basePath, {
        withFileTypes: true,
      }) as Array<{ name: string }>;
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.posix.join(basePath, entry.name);
      let stat: Stats;
      try {
        stat = this.instance.statSync(entryPath);
      } catch {
        continue;
      }

      const isDir = stat.isDirectory();
      callback(entryPath, isDir, stat.mtime, isDir ? 0 : stat.size);

      if (isDir) {
        this.#walk(entryPath, callback);
      }
    }
  }

  /**
   * Upload files to the backend.
   *
   * Files are written to the VFS.
   * Parent directories are created automatically if they don't exist.
   *
   * @param files - Array of [path, content] tuples to upload
   * @returns Upload result for each file, with success or error status
   */
  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    this.#ensureInitialized();
    const results: FileUploadResponse[] = [];

    for (const [filePath, content] of files) {
      try {
        const fullPath = this.#resolvePath(filePath);
        if (!fullPath) {
          results.push({ path: filePath, error: "invalid_path" });
          continue;
        }
        const parentDir = path.posix.dirname(fullPath);

        // Ensure parent directory exists
        this.instance.mkdirSync(parentDir, { recursive: true });
        this.instance.writeFileSync(fullPath, Buffer.from(content));

        results.push({ path: filePath, error: null });
      } catch (error) {
        results.push({ path: filePath, error: this.#mapError(error) });
      }
    }

    return results;
  }

  /**
   * Download files from the backend.
   *
   * @param paths - Array of file paths to download
   * @returns Download result for each file, with content or error
   */
  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    this.#ensureInitialized();
    const results: FileDownloadResponse[] = [];

    for (const filePath of paths) {
      try {
        const fullPath = this.#resolvePath(filePath);
        if (!fullPath) {
          results.push({
            path: filePath,
            content: null,
            error: "invalid_path",
          });
          continue;
        }

        if (!this.instance.existsSync(fullPath)) {
          results.push({
            path: filePath,
            content: null,
            error: "file_not_found",
          });
          continue;
        }

        const stat = this.instance.statSync(fullPath);
        if (stat.isDirectory()) {
          results.push({
            path: filePath,
            content: null,
            error: "is_directory",
          });
          continue;
        }

        const content = this.instance.readFileSync(fullPath) as Buffer;
        results.push({
          path: filePath,
          content: new Uint8Array(content),
          error: null,
        });
      } catch (error) {
        results.push({
          path: filePath,
          content: null,
          error: this.#mapError(error),
        });
      }
    }

    return results;
  }

  /**
   * Stop the backend and release all resources.
   */
  async stop(): Promise<void> {
    // Clear VFS reference
    this.#vfs = undefined;
    this.#initialized = false;
    this.#workingDirectory = "/workspace";
  }

  /**
   * Read file content.
   */
  async read(
    filePath: string,
    offset: number = 0,
    limit: number = 500,
  ): Promise<ReadResult> {
    this.#ensureInitialized();

    const resolvedPath = this.#resolvePath(filePath);
    if (!resolvedPath || !this.instance.existsSync(resolvedPath)) {
      return { error: `File '${filePath}' not found` };
    }

    let stat: Stats;
    try {
      stat = this.instance.statSync(resolvedPath);
    } catch {
      return { error: `File '${filePath}' not found` };
    }

    if (!stat.isFile()) {
      return { error: `File '${filePath}' not found` };
    }

    const mimeType = getMimeType(filePath);
    if (!isTextMimeType(mimeType)) {
      const content = this.instance.readFileSync(resolvedPath) as Buffer;
      return { content: new Uint8Array(content), mimeType };
    }

    if (limit === 0) {
      return { content: "", mimeType };
    }

    const content = this.instance.readFileSync(resolvedPath, {
      encoding: "utf-8",
    }) as string;
    const lines = content.split("\n");
    const start = Math.max(0, offset);
    const end = Math.max(start, start + Math.max(0, limit));

    if (start >= lines.length) {
      return { content: "", mimeType };
    }

    return { content: lines.slice(start, end).join("\n"), mimeType };
  }

  /**
   * Read file content as raw FileData.
   */
  async readRaw(filePath: string): Promise<ReadRawResult> {
    this.#ensureInitialized();

    const resolvedPath = this.#resolvePath(filePath);
    if (!resolvedPath || !this.instance.existsSync(resolvedPath)) {
      return { error: `File '${filePath}' not found` };
    }

    let stat: Stats;
    try {
      stat = this.instance.statSync(resolvedPath);
    } catch {
      return { error: `File '${filePath}' not found` };
    }

    if (!stat.isFile()) {
      return { error: `File '${filePath}' not found` };
    }

    const mimeType = getMimeType(filePath);
    const createdAt = stat.ctime.toISOString();
    const modifiedAt = stat.mtime.toISOString();

    if (!isTextMimeType(mimeType)) {
      const content = this.instance.readFileSync(resolvedPath) as Buffer;
      return {
        data: {
          content: new Uint8Array(content),
          mimeType,
          created_at: createdAt,
          modified_at: modifiedAt,
        },
      };
    }

    const content = this.instance.readFileSync(resolvedPath, {
      encoding: "utf-8",
    }) as string;
    return {
      data: {
        content,
        mimeType,
        created_at: createdAt,
        modified_at: modifiedAt,
      },
    };
  }

  /**
   * Write content to a file, creating it or overwriting it if it already exists.
   */
  async write(filePath: string, content: string): Promise<WriteResult> {
    this.#ensureInitialized();

    const resolvedPath = this.#resolvePath(filePath);
    if (!resolvedPath) {
      return { error: `Error writing file '${filePath}': invalid path` };
    }

    try {
      if (
        this.instance.existsSync(resolvedPath) &&
        this.instance.lstatSync(resolvedPath).isSymbolicLink()
      ) {
        return {
          error: `Cannot write to ${filePath} because it is a symlink. Symlinks are not allowed.`,
        };
      }

      this.instance.mkdirSync(path.posix.dirname(resolvedPath), {
        recursive: true,
      });

      const mimeType = getMimeType(filePath);
      if (isTextMimeType(mimeType)) {
        this.instance.writeFileSync(resolvedPath, content);
      } else {
        this.instance.writeFileSync(
          resolvedPath,
          Buffer.from(content, "base64"),
        );
      }

      return { path: filePath, filesUpdate: null };
    } catch (error) {
      return {
        error: `Error writing file '${filePath}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /**
   * Delete a file or directory recursively.
   */
  async delete(filePath: string): Promise<DeleteResult> {
    this.#ensureInitialized();

    const resolvedPath = this.#resolvePath(filePath);
    if (!resolvedPath) {
      return { error: `Error deleting '${filePath}': invalid path` };
    }

    try {
      if (!this.instance.existsSync(resolvedPath)) {
        return { error: `Error: '${filePath}' not found` };
      }
      this.instance.rmSync(resolvedPath, { recursive: true, force: false });
      return { path: filePath, filesUpdate: null };
    } catch (error) {
      return {
        error: `Error deleting '${filePath}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /**
   * Edit a file by replacing string occurrences.
   */
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): Promise<EditResult> {
    this.#ensureInitialized();

    const resolvedPath = this.#resolvePath(filePath);
    if (!resolvedPath || !this.instance.existsSync(resolvedPath)) {
      return { error: `Error: File '${filePath}' not found` };
    }

    let stat: Stats;
    try {
      stat = this.instance.statSync(resolvedPath);
    } catch {
      return { error: `Error: File '${filePath}' not found` };
    }

    if (!stat.isFile()) {
      return { error: `Error: File '${filePath}' not found` };
    }

    const mimeType = getMimeType(filePath);
    if (!isTextMimeType(mimeType)) {
      return {
        error: `Error editing file '${filePath}': binary files are not supported`,
      };
    }

    try {
      const content = this.instance.readFileSync(resolvedPath, {
        encoding: "utf-8",
      }) as string;
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
      this.instance.writeFileSync(resolvedPath, newContent);
      return { path: filePath, filesUpdate: null, occurrences };
    } catch (error) {
      return {
        error: `Error editing file '${filePath}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /**
   * Delete a file.
   */
  async delete(filePath: string): Promise<DeleteResult> {
    this.#ensureInitialized();

    const resolvedPath = this.#resolvePath(filePath);
    if (!resolvedPath || !this.instance.existsSync(resolvedPath)) {
      return { error: `Error: File '${filePath}' not found` };
    }

    try {
      const stat = this.instance.statSync(resolvedPath);
      if (!stat.isFile()) {
        return { error: `Error: '${filePath}' is a directory, not a file` };
      }

      this.instance.unlinkSync(resolvedPath);
      return { path: filePath };
    } catch (error) {
      return {
        error: `Error deleting file '${filePath}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /**
   * List files and directories in the specified directory.
   */
  async ls(dirPath: string): Promise<LsResult> {
    this.#ensureInitialized();

    const resolvedPath = this.#resolvePath(dirPath);
    if (!resolvedPath || !this.instance.existsSync(resolvedPath)) {
      return { files: [] };
    }

    let dirStat: Stats;
    try {
      dirStat = this.instance.statSync(resolvedPath);
    } catch {
      return { files: [] };
    }

    if (!dirStat.isDirectory()) {
      return { files: [] };
    }

    let entries: Array<{ name: string }>;
    try {
      entries = this.instance.readdirSync(resolvedPath, {
        withFileTypes: true,
      }) as Array<{ name: string }>;
    } catch {
      return { files: [] };
    }

    const files = entries
      .map((entry) => {
        const fullPath = path.posix.join(resolvedPath, entry.name);
        const stat = this.instance.statSync(fullPath);
        const isDir = stat.isDirectory();
        return {
          path: this.#toPublicPath(fullPath) + (isDir ? "/" : ""),
          is_dir: isDir,
          size: isDir ? 0 : stat.size,
          modified_at: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));

    return { files };
  }

  /**
   * Search for a literal text pattern in files.
   */
  async grep(
    pattern: string,
    searchPath: string = "/",
    glob: string | null = null,
  ): Promise<GrepResult> {
    this.#ensureInitialized();

    const resolvedPath = this.#resolvePath(searchPath);
    if (!resolvedPath || !this.instance.existsSync(resolvedPath)) {
      return { matches: [] };
    }

    let rootStat: Stats;
    try {
      rootStat = this.instance.statSync(resolvedPath);
    } catch {
      return { matches: [] };
    }

    if (glob) {
      const globValidationError = validateGlobPattern(glob);
      if (globValidationError) {
        return { error: globValidationError, matches: [] };
      }
    }

    const matches: NonNullable<GrepResult["matches"]> = [];

    const scanFile = (fileAbsolutePath: string) => {
      if (
        glob &&
        !globMatchesPath(glob, path.posix.basename(fileAbsolutePath))
      ) {
        return;
      }

      const publicPath = this.#toPublicPath(fileAbsolutePath);
      const mimeType = getMimeType(publicPath);
      if (!isTextMimeType(mimeType)) {
        return;
      }

      let text: string;
      try {
        text = this.instance.readFileSync(fileAbsolutePath, {
          encoding: "utf-8",
        }) as string;
      } catch {
        return;
      }

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(pattern)) {
          matches.push({
            path: publicPath,
            line: i + 1,
            text: lines[i],
          });
        }
      }
    };

    if (rootStat.isDirectory()) {
      this.#walk(resolvedPath, (fileAbsolutePath, isDir) => {
        if (!isDir) {
          scanFile(fileAbsolutePath);
        }
      });
    } else {
      scanFile(resolvedPath);
    }

    return { matches };
  }

  /**
   * Structured glob matching returning FileInfo objects.
   */
  async glob(pattern: string, searchPath: string = "/"): Promise<GlobResult> {
    this.#ensureInitialized();

    let effectivePattern = pattern;
    if (effectivePattern.startsWith("/")) {
      effectivePattern = effectivePattern.slice(1);
    }

    const globValidationError = validateGlobPattern(effectivePattern);
    if (globValidationError) {
      return { error: globValidationError, files: [] };
    }

    const resolvedPath = this.#resolvePath(searchPath);
    if (!resolvedPath || !this.instance.existsSync(resolvedPath)) {
      return { files: [] };
    }

    let rootStat: Stats;
    try {
      rootStat = this.instance.statSync(resolvedPath);
    } catch {
      return { files: [] };
    }

    if (!rootStat.isDirectory()) {
      return { files: [] };
    }

    const files: NonNullable<GlobResult["files"]> = [];

    this.#walk(resolvedPath, (entryPath, isDir, mtime, size) => {
      const relPath = path.posix.relative(resolvedPath, entryPath);
      if (!relPath) return;

      if (globMatchesPath(effectivePattern, relPath)) {
        files.push({
          path: relPath,
          is_dir: isDir,
          size,
          modified_at: mtime.toISOString(),
        });
      }
    });

    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files };
  }

  /**
   * Ensure the backend is initialized before operations.
   */
  #ensureInitialized(): void {
    if (!this.#initialized) {
      throw new VfsSandboxError(
        "VFS Backend not initialized. Call initialize() or use VfsBackend.create()",
        "NOT_INITIALIZED",
      );
    }
  }

  /**
   * Map errors to standardized FileOperationError codes.
   */
  #mapError(error: unknown): FileOperationError {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT" || msg.includes("not found")) {
        return "file_not_found";
      }
      if (code === "EACCES" || msg.includes("permission")) {
        return "permission_denied";
      }
      if (code === "EISDIR" || msg.includes("directory")) {
        return "is_directory";
      }
    }

    return "invalid_path";
  }

  /**
   * Create and initialize a new VfsBackend in one step.
   *
   * This is the recommended way to create a backend. It combines
   * construction and initialization into a single async operation.
   *
   * @param options - Configuration options for the backend
   * @returns An initialized and ready-to-use backend
   *
   * @example
   * ```typescript
   * const backend = await VfsBackend.create({
   *   initialFiles: {
   *     "/src/index.js": "console.log('Hello')",
   *   },
   * });
   * ```
   */
  static async create(options?: VfsBackendOptions): Promise<VfsBackend> {
    const backend = new VfsBackend(options);
    await backend.initialize();
    return backend;
  }
}

/**
 * Create a backend factory that creates a new VFS backend per invocation.
 *
 * @param options - Optional configuration for backend creation
 * @returns A factory function that creates new backends
 *
 * @example
 * ```typescript
 * import { VfsBackend, createVfsBackendFactory } from "@langchain/node-vfs";
 *
 * const factory = createVfsBackendFactory({
 *   initialFiles: { "/README.md": "# Hello" },
 * });
 *
 * const backend = await factory();
 * ```
 */
export function createVfsBackendFactory(
  options?: VfsBackendOptions,
): () => Promise<VfsBackend> {
  return async () => {
    return await VfsBackend.create(options);
  };
}

/**
 * Create a backend factory that reuses an existing VFS backend.
 *
 * @param backend - An existing VfsBackend instance (must be initialized)
 * @returns A BackendFactory that returns the provided backend
 *
 * @example
 * ```typescript
 * const backend = await VfsBackend.create();
 *
 * const agent = createDeepAgent({
 *   model: new ChatAnthropic({ model: "claude-sonnet-4-20250514" }),
 *   systemPrompt: "You are a coding assistant.",
 *   middlewares: [
 *     createFilesystemMiddleware({
 *       backend: createVfsBackendFactoryFromBackend(backend),
 *     }),
 *   ],
 * });
 * ```
 */
export function createVfsBackendFactoryFromBackend(
  backend: VfsBackend,
): BackendFactory {
  return () => backend;
}
