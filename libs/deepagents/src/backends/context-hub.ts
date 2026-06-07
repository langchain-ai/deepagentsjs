/**
 * ContextHubBackend: Store files in a LangSmith Hub agent repo (persistent).
 */

import micromatch from "micromatch";
import { Client } from "langsmith";
import type { AgentContext, Entry } from "langsmith/schemas";
import type {
  BackendProtocolV2,
  EditResult,
  FileDownloadResponse,
  FileInfo,
  FileOperationError,
  FileUploadResponse,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "./protocol.js";
import { performStringReplacement } from "./utils.js";

const URL_COMMIT_SUFFIX_RE = /:([0-9a-f]{8,64})$/i;
const TEXT_MIME_TYPE = "text/plain";
const FNMATCH_OPTIONS = { bash: true };

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function splitLinesKeepEnds(content: string): string[] {
  const lines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      lines.push(content.slice(lineStart, index + 1));
      lineStart = index + 1;
    }
  }

  if (lineStart < content.length) {
    lines.push(content.slice(lineStart));
  }

  return lines;
}

function sliceReadContent(
  content: string,
  offset: number,
  limit: number,
): { content?: string; error?: string } {
  if (!content || content.trim() === "") {
    return { content };
  }

  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = splitLinesKeepEnds(normalized);
  const startIndex = offset;
  const endIndex = Math.min(startIndex + limit, lines.length);

  if (startIndex >= lines.length) {
    return {
      error: `Line offset ${offset} exceeds file length (${lines.length} lines)`,
    };
  }

  return { content: lines.slice(startIndex, endIndex).join("") };
}

function isLangSmithNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const maybeError = error as { name?: unknown; status?: unknown };
  return (
    maybeError.name === "LangSmithNotFoundError" || maybeError.status === 404
  );
}

function isLangSmithError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const maybeError = error as { name?: unknown; status?: unknown };
  return (
    (typeof maybeError.name === "string" &&
      maybeError.name.startsWith("LangSmith")) ||
    typeof maybeError.status === "number"
  );
}

function getLangSmithStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const maybeError = error as { status?: unknown };
  if (typeof maybeError.status === "number") {
    return maybeError.status;
  }

  return undefined;
}

function mapHubFileOperationError(error: unknown): FileOperationError {
  const status = getLangSmithStatus(error);
  if (status === 401 || status === 403) {
    return "permission_denied";
  }
  if (status === 404) {
    return "file_not_found";
  }
  return "invalid_path";
}

/**
 * Backend that stores files in a LangSmith Hub agent repo (persistent).
 */
export class ContextHubBackend implements BackendProtocolV2 {
  private identifier: string;
  private client: Client;
  private cache: Record<string, string> | null = null;
  private linkedEntries: Record<string, string> = {};
  private commitHash: string | null = null;

  constructor(
    identifier: string,
    options: {
      client?: Client;
    } = {},
  ) {
    this.identifier = identifier;
    this.client = options.client ?? new Client();
  }

  private static stripPrefix(path: string): string {
    return path.replace(/^\/+/, "");
  }

  private static toHubUnavailableError(error: unknown): string {
    return `Hub unavailable: ${getErrorMessage(error)}`;
  }

  private async loadTree(): Promise<void> {
    let context: AgentContext;
    try {
      context = await this.client.pullAgent(this.identifier);
    } catch (error) {
      if (isLangSmithNotFoundError(error)) {
        this.cache = {};
        this.linkedEntries = {};
        this.commitHash = null;
        return;
      }
      throw error;
    }

    this.commitHash = context.commit_hash;
    this.cache = {};
    this.linkedEntries = {};

    for (const [path, entry] of Object.entries(context.files)) {
      if (entry.type === "file") {
        this.cache[path] = entry.content;
      } else if (
        (entry.type === "agent" || entry.type === "skill") &&
        typeof entry.repo_handle === "string"
      ) {
        this.linkedEntries[path] = entry.repo_handle;
      }
    }
  }

  private async ensureCache(): Promise<Record<string, string>> {
    if (this.cache === null) {
      await this.loadTree();
    }
    if (this.cache === null) {
      throw new Error("Context Hub cache failed to initialize");
    }
    return this.cache;
  }

  private async commit(files: Record<string, string>): Promise<void> {
    if (Object.keys(files).length === 0) {
      return;
    }

    const payload: Record<string, Entry | null> = {};
    for (const [path, content] of Object.entries(files)) {
      payload[path] = { type: "file", content };
    }

    const url = await this.client.pushAgent(this.identifier, {
      files: payload,
      ...(this.commitHash ? { parentCommit: this.commitHash } : {}),
    });

    const match = URL_COMMIT_SUFFIX_RE.exec(url);
    if (match) {
      this.commitHash = match[1];
    }

    if (this.cache !== null) {
      for (const [path, content] of Object.entries(files)) {
        this.cache[path] = content;
      }
    }
  }

  /**
   * Return linked-entry paths mapped to their repo handles.
   */
  async getLinkedEntries(): Promise<Record<string, string>> {
    await this.ensureCache();
    return { ...this.linkedEntries };
  }

  /**
   * Return true if the hub repo already exists with at least one commit.
   */
  async hasPriorCommits(): Promise<boolean> {
    await this.ensureCache();
    return this.commitHash !== null;
  }

  async ls(path: string = "/"): Promise<LsResult> {
    const hubPrefix = ContextHubBackend.stripPrefix(path).replace(/\/+$/, "");

    let cache: Record<string, string>;
    try {
      cache = await this.ensureCache();
    } catch (error) {
      if (isLangSmithError(error)) {
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }

    const dirs = new Set<string>();
    const entries: FileInfo[] = [];

    for (const filePath of Object.keys(cache)) {
      if (hubPrefix && !filePath.startsWith(`${hubPrefix}/`)) {
        continue;
      }

      const relative = hubPrefix
        ? filePath.slice(hubPrefix.length + 1)
        : filePath;
      if (!relative) {
        continue;
      }

      const slashIndex = relative.indexOf("/");
      if (slashIndex === -1) {
        entries.push({ path: `/${filePath}`, is_dir: false });
        continue;
      }

      const dirName = relative.slice(0, slashIndex);
      const dirPath = hubPrefix ? `${hubPrefix}/${dirName}` : dirName;
      if (!dirs.has(dirPath)) {
        dirs.add(dirPath);
        entries.push({ path: `/${dirPath}`, is_dir: true });
      }
    }

    return { files: entries };
  }

  async read(
    filePath: string,
    offset: number = 0,
    limit: number = 2000,
  ): Promise<ReadResult> {
    const hubPath = ContextHubBackend.stripPrefix(filePath);

    let cache: Record<string, string>;
    try {
      cache = await this.ensureCache();
    } catch (error) {
      if (isLangSmithError(error)) {
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }

    const content = cache[hubPath];
    if (content === undefined) {
      return { error: `File '${filePath}' not found` };
    }

    const sliced = sliceReadContent(content, offset, limit);
    if (sliced.error) {
      return { error: sliced.error };
    }

    return { content: sliced.content ?? "", mimeType: TEXT_MIME_TYPE };
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    const readResult = await this.read(filePath, 0, Number.MAX_SAFE_INTEGER);
    if (readResult.error || typeof readResult.content !== "string") {
      return { error: readResult.error ?? `File '${filePath}' not found` };
    }

    const now = new Date().toISOString();
    return {
      data: {
        content: readResult.content,
        mimeType: TEXT_MIME_TYPE,
        created_at: now,
        modified_at: now,
      },
    };
  }

  async grep(
    pattern: string,
    path: string | null = null,
    glob: string | null = null,
  ): Promise<GrepResult> {
    let cache: Record<string, string>;
    try {
      cache = await this.ensureCache();
    } catch (error) {
      if (isLangSmithError(error)) {
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }

    const prefix = path
      ? ContextHubBackend.stripPrefix(path).replace(/\/+$/, "")
      : "";

    const matches: GrepMatch[] = [];
    for (const [filePath, content] of Object.entries(cache)) {
      if (prefix && !filePath.startsWith(prefix)) {
        continue;
      }
      if (glob && !micromatch.isMatch(filePath, glob, FNMATCH_OPTIONS)) {
        continue;
      }

      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.includes(pattern)) {
          matches.push({ path: `/${filePath}`, line: index + 1, text: line });
        }
      }
    }

    return { matches };
  }

  async glob(pattern: string, _path: string = "/"): Promise<GlobResult> {
    let cache: Record<string, string>;
    try {
      cache = await this.ensureCache();
    } catch (error) {
      if (isLangSmithError(error)) {
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }

    const files: FileInfo[] = [];
    for (const filePath of Object.keys(cache)) {
      if (
        micromatch.isMatch(`/${filePath}`, pattern, FNMATCH_OPTIONS) ||
        micromatch.isMatch(filePath, pattern, FNMATCH_OPTIONS)
      ) {
        files.push({ path: `/${filePath}`, is_dir: false });
      }
    }

    return { files };
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    const hubPath = ContextHubBackend.stripPrefix(filePath);

    try {
      await this.ensureCache();
      await this.commit({ [hubPath]: content });
    } catch (error) {
      if (isLangSmithError(error)) {
        this.cache = null;
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }

    return { path: filePath, filesUpdate: null };
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): Promise<EditResult> {
    const hubPath = ContextHubBackend.stripPrefix(filePath);

    try {
      const cache = await this.ensureCache();
      const current = cache[hubPath];
      if (current === undefined) {
        return { error: `Error: File '${filePath}' not found` };
      }

      const replacementResult = performStringReplacement(
        current,
        oldString,
        newString,
        replaceAll,
      );
      if (typeof replacementResult === "string") {
        return { error: replacementResult };
      }

      const [newContent, occurrences] = replacementResult;
      await this.commit({ [hubPath]: newContent });
      return {
        path: filePath,
        filesUpdate: null,
        occurrences,
      };
    } catch (error) {
      if (isLangSmithError(error)) {
        this.cache = null;
        return { error: ContextHubBackend.toHubUnavailableError(error) };
      }
      throw error;
    }
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const decoded: Array<[string, string | null]> = [];
    const validFiles: Record<string, string> = {};

    for (const [path, content] of files) {
      try {
        const text = decoder.decode(content);
        decoded.push([path, text]);
        validFiles[ContextHubBackend.stripPrefix(path)] = text;
      } catch {
        decoded.push([path, null]);
      }
    }

    let commitError: FileOperationError | null = null;
    if (Object.keys(validFiles).length > 0) {
      try {
        await this.ensureCache();
        await this.commit(validFiles);
      } catch (error) {
        if (isLangSmithError(error)) {
          this.cache = null;
          commitError = mapHubFileOperationError(error);
        } else {
          throw error;
        }
      }
    }

    return decoded.map(([path, text]) => {
      if (text === null) {
        return { path, error: "invalid_path" };
      }
      if (commitError !== null) {
        return { path, error: commitError };
      }
      return { path, error: null };
    });
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    let cache: Record<string, string>;
    try {
      cache = await this.ensureCache();
    } catch (error) {
      if (isLangSmithError(error)) {
        const mappedError = mapHubFileOperationError(error);
        return paths.map((path) => ({
          path,
          content: null,
          error: mappedError,
        }));
      }
      throw error;
    }

    const encoder = new TextEncoder();
    return paths.map((path) => {
      const hubPath = ContextHubBackend.stripPrefix(path);
      const content = cache[hubPath];
      if (content !== undefined) {
        return { path, content: encoder.encode(content), error: null };
      }
      return { path, content: null, error: "file_not_found" };
    });
  }
}
