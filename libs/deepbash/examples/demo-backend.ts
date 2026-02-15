import {
  type BackendProtocol,
  type FileInfo,
  type FileData,
  type GrepMatch,
  type WriteResult,
  type EditResult,
  type FileDownloadResponse,
  type FileUploadResponse,
} from "deepagents";

export class BaseDemoBackend implements BackendProtocol {
  isReadonly: boolean;

  files: Map<string, Uint8Array>;

  constructor(files: Record<string, string | Uint8Array> = {}) {
    this.files = new Map();
    const encoder = new TextEncoder();
    for (const [path, value] of Object.entries(files)) {
      this.files.set(
        path,
        typeof value === "string" ? encoder.encode(value) : value,
      );
    }
  }

  async lsInfo(dir: string): Promise<FileInfo[]> {
    const norm = dir.endsWith("/") ? dir : dir + "/";
    const seen = new Set<string>();
    const results: FileInfo[] = [];
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(norm)) {
        const rel = filePath.slice(norm.length);
        const parts = rel.split("/");
        if (parts.length > 1) {
          const subdir = norm + parts[0] + "/";
          if (!seen.has(subdir)) {
            results.push({ path: subdir, is_dir: true });
            seen.add(subdir);
          }
        } else if (parts[0]) {
          results.push({ path: norm + parts[0], is_dir: false });
        }
      }
    }
    return results;
  }

  async read(path: string, offset?: number, limit?: number): Promise<string> {
    const data = this.files.get(path);
    if (!data) throw new Error(`File not found: ${path}`);
    const text = new TextDecoder().decode(data);
    if (typeof offset === "number" || typeof limit === "number") {
      const lines = text.split("\n");
      const off = offset ?? 0;
      const lim = typeof limit === "number" ? limit : lines.length - off;
      return lines.slice(off, off + lim).join("\n");
    }
    return text;
  }

  async readRaw(path: string): Promise<FileData> {
    const data = this.files.get(path);
    if (!data) throw new Error(`File not found: ${path}`);
    const text = new TextDecoder().decode(data);
    const now = new Date().toISOString();
    return {
      content: text.split("\n"),
      created_at: now,
      modified_at: now,
    };
  }

  async grepRaw(
    pattern: string,
    dir?: string | null,
    glob?: string | null,
  ): Promise<GrepMatch[] | string> {
    const results: GrepMatch[] = [];
    for (const [filePath, data] of this.files.entries()) {
      if (dir && !filePath.startsWith(dir)) continue;
      if (glob && !filePath.match(globToRegExp(glob))) continue;
      const text = new TextDecoder().decode(data);
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        if (line.includes(pattern)) {
          results.push({ path: filePath, line: idx + 1, text: line });
        }
      });
    }
    return results;
  }

  async globInfo(pattern: string, path?: string): Promise<FileInfo[]> {
    const regex = globToRegExp(pattern);
    const basePath = path ?? "/";
    const norm = basePath.endsWith("/") ? basePath : basePath + "/";
    const results: FileInfo[] = [];
    for (const filePath of this.files.keys()) {
      // Match against the path relative to the base
      const rel = filePath.startsWith(norm)
        ? filePath.slice(norm.length)
        : filePath.startsWith("/")
          ? filePath.slice(1)
          : filePath;
      if (regex.test(rel)) {
        results.push({ path: filePath, is_dir: false });
      }
    }
    return results;
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    if (this.files.has(filePath)) {
      return { error: `File already exists: ${filePath}` };
    }
    this.files.set(filePath, new TextEncoder().encode(content));
    return { path: filePath, filesUpdate: null };
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const data = this.files.get(filePath);
    if (!data) return { error: `File not found: ${filePath}` };
    const text = new TextDecoder().decode(data);
    const count = text.split(oldString).length - 1;
    if (count === 0) return { error: `String not found in file '${filePath}'` };
    if (count > 1 && !replaceAll) {
      return { error: `Multiple occurrences found. Use replaceAll=true.` };
    }
    const newText = replaceAll
      ? text.split(oldString).join(newString)
      : text.replace(oldString, newString);
    this.files.set(filePath, new TextEncoder().encode(newText));
    return { path: filePath, filesUpdate: null, occurrences: count };
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    for (const [path, content] of files) {
      this.files.set(path, content);
    }
    return files.map(([path]) => ({ path, error: null }));
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return paths.map((path) => {
      const data = this.files.get(path);
      if (!data)
        return {
          path,
          content: null,
          error: "file_not_found" as const,
        };
      return { path, content: new Uint8Array(data), error: null };
    });
  }
}

// Helper: very primitive glob-to-regexp (supports only "**" and "*" wildcards)
function globToRegExp(glob: string): RegExp {
  // Escape regex special chars except for * and **
  let regex = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  // Handle **/ before lone ** to avoid the single-* replacement corrupting .*
  // **/ → match zero or more directory prefixes (e.g. "" or "dir/" or "a/b/")
  regex = regex.replace(/\*\*\//g, "(?:.+/)?");
  // ** at end of pattern → match anything
  regex = regex.replace(/\*\*/g, ".*");
  // Single * → match within a single path segment
  regex = regex.replace(/\*/g, "[^/]*");
  return new RegExp("^" + regex + "$");
}
