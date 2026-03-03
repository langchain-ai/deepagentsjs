/**
 * KVBackend: In-memory key-value file store.
 *
 * A simple BackendProtocol implementation backed by a plain Map.
 * Writes mutate the map directly — no filesUpdate/Command indirection.
 *
 * Designed for use inside the QuickJS REPL where all operations happen
 * within a single tool call and there is no opportunity to return
 * LangGraph Commands between operations.
 */

import type {
  BackendProtocol,
  EditResult,
  FileData,
  FileDownloadResponse,
  FileInfo,
  FileUploadResponse,
  GrepMatch,
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

export class KVBackend implements BackendProtocol {
  private files: Map<string, FileData>;

  constructor(initial?: Record<string, FileData>) {
    this.files = new Map(initial ? Object.entries(initial) : []);
  }

  private getFiles(): Record<string, FileData> {
    return Object.fromEntries(this.files);
  }

  lsInfo(path: string): FileInfo[] {
    const normalizedPath = path.endsWith("/") ? path : path + "/";
    const infos: FileInfo[] = [];
    const subdirs = new Set<string>();

    for (const [k, fd] of this.files) {
      if (!k.startsWith(normalizedPath)) continue;

      const relative = k.substring(normalizedPath.length);
      if (relative.includes("/")) {
        const subdirName = relative.split("/")[0];
        subdirs.add(normalizedPath + subdirName + "/");
        continue;
      }

      infos.push({
        path: k,
        is_dir: false,
        size: fd.content.join("\n").length,
        modified_at: fd.modified_at,
      });
    }

    for (const subdir of Array.from(subdirs).sort()) {
      infos.push({ path: subdir, is_dir: true, size: 0, modified_at: "" });
    }

    infos.sort((a, b) => a.path.localeCompare(b.path));
    return infos;
  }

  read(filePath: string, offset: number = 0, limit: number = 500): string {
    const fileData = this.files.get(filePath);
    if (!fileData) return `Error: File '${filePath}' not found`;
    return formatReadResponse(fileData, offset, limit);
  }

  readRaw(filePath: string): FileData {
    const fileData = this.files.get(filePath);
    if (!fileData) throw new Error(`File '${filePath}' not found`);
    return fileData;
  }

  write(filePath: string, content: string): WriteResult {
    if (this.files.has(filePath)) {
      return {
        error: `Cannot write to ${filePath} because it already exists. Read and then make an edit, or write to a new path.`,
      };
    }

    const newFileData = createFileData(content);
    this.files.set(filePath, newFileData);
    return { path: filePath };
  }

  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): EditResult {
    const fileData = this.files.get(filePath);
    if (!fileData) return { error: `Error: File '${filePath}' not found` };

    const content = fileDataToString(fileData);
    const result = performStringReplacement(
      content,
      oldString,
      newString,
      replaceAll,
    );

    if (typeof result === "string") return { error: result };

    const [newContent, occurrences] = result;
    const newFileData = updateFileData(fileData, newContent);
    this.files.set(filePath, newFileData);
    return { path: filePath, occurrences };
  }

  grepRaw(
    pattern: string,
    path: string = "/",
    glob: string | null = null,
  ): GrepMatch[] | string {
    return grepMatchesFromFiles(this.getFiles(), pattern, path, glob);
  }

  globInfo(pattern: string, path: string = "/"): FileInfo[] {
    const files = this.getFiles();
    const result = globSearchFiles(files, pattern, path);
    if (result === "No files found") return [];

    const paths = result.split("\n");
    return paths.map((p) => {
      const fd = this.files.get(p);
      return {
        path: p,
        is_dir: false,
        size: fd ? fd.content.join("\n").length : 0,
        modified_at: fd?.modified_at || "",
      };
    });
  }

  uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): FileUploadResponse[] {
    const responses: FileUploadResponse[] = [];
    for (const [path, content] of files) {
      try {
        const contentStr = new TextDecoder().decode(content);
        this.files.set(path, createFileData(contentStr));
        responses.push({ path, error: null });
      } catch {
        responses.push({ path, error: "invalid_path" });
      }
    }
    return responses;
  }

  downloadFiles(paths: string[]): FileDownloadResponse[] {
    return paths.map((path) => {
      const fileData = this.files.get(path);
      if (!fileData) return { path, content: null, error: "file_not_found" as const };
      const content = new TextEncoder().encode(fileDataToString(fileData));
      return { path, content, error: null };
    });
  }
}
