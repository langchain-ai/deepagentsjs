/**
 * BackendVirtualFileSystem — VirtualFileSystem implementation over a deepagents backend.
 *
 * File reads delegate to `backend.readRaw()`.
 * File writes are buffered in `pendingWrites` and flushed by the session after eval.
 * All other VFS operations (stat, readDir, rename, etc.) throw ENOSYS.
 */

import type { VirtualFileSystem, StatInfo, DirEntry } from "secure-exec";
import type { BackendProtocolV2 } from "deepagents";

type VirtualStat = StatInfo;
type VirtualDirEntry = DirEntry;

export interface PendingWrite {
  path: string;
  content: string;
}

const ENOSYS = () => new Error("ENOSYS: function not implemented");

export class BackendVirtualFileSystem implements VirtualFileSystem {
  private backend: BackendProtocolV2 | null = null;
  readonly pendingWrites: PendingWrite[] = [];

  setBackend(backend: BackendProtocolV2 | null): void {
    this.backend = backend;
  }

  async readTextFile(path: string): Promise<string> {
    if (!this.backend) {
      throw new Error(`ENOENT: no such file or directory '${path}'`);
    }
    let result: Awaited<ReturnType<BackendProtocolV2["readRaw"]>>;
    try {
      result = await this.backend.readRaw(path);
    } catch {
      throw new Error(`ENOENT: no such file or directory '${path}'`);
    }

    if (result.error || !result.data) {
      throw new Error(`ENOENT: no such file or directory '${path}'`);
    }

    const { content } = result.data;

    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return (content as string[]).join("\n");
    }
    throw new Error(`ENOENT: no such file or directory '${path}'`);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const text = await this.readTextFile(path);
    return new TextEncoder().encode(text);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const text =
      // eslint-disable-next-line no-instanceof/no-instanceof
      content instanceof Uint8Array
        ? new TextDecoder().decode(content)
        : content;
    this.pendingWrites.push({ path, content: text });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.readTextFile(path);
      return true;
    } catch {
      return false;
    }
  }

  async readDir(_path: string): Promise<string[]> {
    throw ENOSYS();
  }

  async readDirWithTypes(_path: string): Promise<VirtualDirEntry[]> {
    throw ENOSYS();
  }

  async createDir(_path: string): Promise<void> {
    // no-op: directories are implicit in the backend
  }

  async mkdir(_path: string): Promise<void> {
    // no-op: directories are implicit in the backend
  }

  async stat(_path: string): Promise<VirtualStat> {
    throw ENOSYS();
  }

  async removeFile(_path: string): Promise<void> {
    throw ENOSYS();
  }

  async removeDir(_path: string): Promise<void> {
    throw ENOSYS();
  }

  async rename(_oldPath: string, _newPath: string): Promise<void> {
    throw ENOSYS();
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw ENOSYS();
  }

  async readlink(_path: string): Promise<string> {
    throw ENOSYS();
  }

  async lstat(_path: string): Promise<VirtualStat> {
    throw ENOSYS();
  }

  async link(_oldPath: string, _newPath: string): Promise<void> {
    throw ENOSYS();
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    throw ENOSYS();
  }

  async chown(_path: string, _uid: number, _gid: number): Promise<void> {
    throw ENOSYS();
  }

  async utimes(_path: string, _atime: number, _mtime: number): Promise<void> {
    throw ENOSYS();
  }

  async truncate(_path: string, _length: number): Promise<void> {
    throw ENOSYS();
  }
}
