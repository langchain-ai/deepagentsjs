/**
 * Creates the JS callback object expected by the Rust ProxyFileSystem constructor.
 *
 * Each callback reads/writes the shared in-memory stores (files Map and dirs Set)
 * so that `uploadFiles`/`downloadFiles` and the WASM engine see the same data.
 */

/** Metadata shape expected by the Rust side */
interface FsMetadata {
  is_file: boolean;
  is_dir: boolean;
  len: number;
}

/** Directory entry shape expected by the Rust side */
interface DirEntry {
  name: string;
  metadata: FsMetadata;
}

/** Open file handle state */
interface FileHandle {
  path: string;
  position: number;
  read: boolean;
  write: boolean;
  append: boolean;
}

/** The callback object shape that ProxyFileSystem::new() expects */
export interface FsCallbacks {
  fs_read_file(path: string): Uint8Array | null;
  fs_write_file(path: string, contents: Uint8Array): boolean;
  fs_metadata(path: string): FsMetadata | null;
  fs_read_dir(path: string): DirEntry[] | null;
  fs_create_dir(path: string): boolean;
  fs_remove_dir(path: string): boolean;
  fs_remove_file(path: string): boolean;
  fs_rename(from: string, to: string): boolean;
  fs_open(
    path: string,
    flags: {
      read: boolean;
      write: boolean;
      create: boolean;
      truncate: boolean;
      append: boolean;
    },
  ): number;
  fs_handle_read(handle: number, len: number): Uint8Array | null;
  fs_handle_write(handle: number, data: Uint8Array): number;
  fs_handle_seek(handle: number, offset: number, whence: number): number;
  fs_handle_close(handle: number): void;
}

/**
 * Create the FS callbacks object for a given in-memory filesystem.
 *
 * @param files - The Map<string, Uint8Array> backing the virtual filesystem
 * @param dirs - The Set<string> tracking known directories
 */
export function createFsCallbacks(
  files: Map<string, Uint8Array>,
  dirs: Set<string>,
): FsCallbacks {
  let nextHandleId = 1;
  const handles = new Map<number, FileHandle>();

  /** Ensure parent directories exist for a file path */
  function ensureParentDirs(filePath: string): void {
    const parts = filePath.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += `/${parts[i]}`;
      dirs.add(current);
    }
  }

  return {
    fs_read_file(path: string): Uint8Array | null {
      return files.get(path) ?? null;
    },

    fs_write_file(path: string, contents: Uint8Array): boolean {
      ensureParentDirs(path);
      files.set(path, new Uint8Array(contents));
      return true;
    },

    fs_metadata(path: string): FsMetadata | null {
      if (dirs.has(path)) {
        return { is_file: false, is_dir: true, len: 0 };
      }
      const content = files.get(path);
      if (content !== undefined) {
        return { is_file: true, is_dir: false, len: content.byteLength };
      }
      return null;
    },

    fs_read_dir(path: string): DirEntry[] | null {
      // Normalize: ensure no trailing slash (except for root "/")
      const normalized = path === "/" ? "/" : path.replace(/\/$/, "");

      if (!dirs.has(normalized) && normalized !== "/") {
        return null;
      }

      const entries: DirEntry[] = [];
      const seen = new Set<string>();
      const prefix = normalized === "/" ? "/" : `${normalized}/`;

      // Find direct children among files
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const slashIdx = rest.indexOf("/");
        const childName = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
        if (!childName || seen.has(childName)) continue;
        seen.add(childName);

        if (slashIdx === -1) {
          // Direct file child
          const content = files.get(filePath)!;
          entries.push({
            name: childName,
            metadata: {
              is_file: true,
              is_dir: false,
              len: content.byteLength,
            },
          });
        } else {
          // Intermediate directory
          entries.push({
            name: childName,
            metadata: { is_file: false, is_dir: true, len: 0 },
          });
        }
      }

      // Find direct children among directories
      for (const dirPath of dirs) {
        if (!dirPath.startsWith(prefix)) continue;
        const rest = dirPath.slice(prefix.length);
        if (!rest || rest.includes("/")) continue;
        if (seen.has(rest)) continue;
        seen.add(rest);
        entries.push({
          name: rest,
          metadata: { is_file: false, is_dir: true, len: 0 },
        });
      }

      return entries;
    },

    fs_create_dir(path: string): boolean {
      ensureParentDirs(path);
      dirs.add(path);
      return true;
    },

    fs_remove_dir(path: string): boolean {
      return dirs.delete(path);
    },

    fs_remove_file(path: string): boolean {
      return files.delete(path);
    },

    fs_rename(from: string, to: string): boolean {
      // Rename file
      const content = files.get(from);
      if (content !== undefined) {
        files.delete(from);
        ensureParentDirs(to);
        files.set(to, content);
        return true;
      }
      // Rename directory
      if (dirs.has(from)) {
        dirs.delete(from);
        dirs.add(to);
        // Move all files under the old prefix
        const fromPrefix = from + "/";
        const toPrefix = to + "/";
        for (const [filePath, fileContent] of [...files.entries()]) {
          if (filePath.startsWith(fromPrefix)) {
            files.delete(filePath);
            files.set(
              toPrefix + filePath.slice(fromPrefix.length),
              fileContent,
            );
          }
        }
        // Move sub-directories
        for (const dirPath of [...dirs]) {
          if (dirPath.startsWith(fromPrefix)) {
            dirs.delete(dirPath);
            dirs.add(toPrefix + dirPath.slice(fromPrefix.length));
          }
        }
        return true;
      }
      return false;
    },

    fs_open(
      path: string,
      flags: {
        read: boolean;
        write: boolean;
        create: boolean;
        truncate: boolean;
        append: boolean;
      },
    ): number {
      const exists = files.has(path);

      if (!exists && flags.create) {
        ensureParentDirs(path);
        files.set(path, new Uint8Array(0));
      } else if (!exists) {
        return -1; // Signal error: file not found
      }

      if (exists && flags.truncate) {
        files.set(path, new Uint8Array(0));
      }

      const handleId = nextHandleId++;
      handles.set(handleId, {
        path,
        position: flags.append ? (files.get(path)?.byteLength ?? 0) : 0,
        read: flags.read,
        write: flags.write,
        append: flags.append,
      });

      return handleId;
    },

    fs_handle_read(handle: number, len: number): Uint8Array | null {
      const h = handles.get(handle);
      if (!h) return null;

      const content = files.get(h.path);
      if (!content) return null;

      const available = content.byteLength - h.position;
      if (available <= 0) return new Uint8Array(0);

      const toRead = Math.min(len, available);
      const slice = content.slice(h.position, h.position + toRead);
      h.position += toRead;
      return slice;
    },

    fs_handle_write(handle: number, data: Uint8Array): number {
      const h = handles.get(handle);
      if (!h) return 0;

      const content = files.get(h.path) ?? new Uint8Array(0);
      const pos = h.append ? content.byteLength : h.position;

      // Grow buffer if needed
      const needed = pos + data.byteLength;
      const newContent = new Uint8Array(Math.max(content.byteLength, needed));
      newContent.set(content);
      newContent.set(data, pos);
      files.set(h.path, newContent);

      h.position = pos + data.byteLength;
      return data.byteLength;
    },

    fs_handle_seek(handle: number, offset: number, whence: number): number {
      const h = handles.get(handle);
      if (!h) return -1;

      const content = files.get(h.path);
      const size = content?.byteLength ?? 0;

      // whence: 0=Start, 1=Current, 2=End
      switch (whence) {
        case 0: // Start
          h.position = Math.max(0, offset);
          break;
        case 1: // Current
          h.position = Math.max(0, h.position + offset);
          break;
        case 2: // End
          h.position = Math.max(0, size + offset);
          break;
        default:
          return -1;
      }

      return h.position;
    },

    fs_handle_close(handle: number): void {
      handles.delete(handle);
    },
  };
}
