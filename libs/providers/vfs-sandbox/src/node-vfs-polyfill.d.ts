/**
 * Type declarations for node-vfs-polyfill.
 *
 * This package implements the upcoming Node.js VFS feature (nodejs/node#61478).
 * See: https://github.com/vercel-labs/node-vfs-polyfill
 */

declare module "node-vfs-polyfill" {
  import type { Stats, Dirent, WriteStream } from "node:fs";

  /**
   * Options for creating a VirtualFileSystem.
   */
  export interface VirtualFileSystemOptions {
    /** Whether to enable require/import hooks (default: true) */
    moduleHooks?: boolean;
    /** Whether to enable virtual working directory */
    virtualCwd?: boolean;
    /** Whether to enable overlay mode (only intercept existing files) */
    overlay?: boolean;
  }

  /**
   * Options for mounting a VirtualFileSystem.
   */
  export interface MountOptions {
    /** Whether to suppress the experimental warning */
    suppressWarning?: boolean;
  }

  /**
   * Base class for VFS providers.
   */
  export abstract class VirtualProvider {
    /** Whether this provider is read-only */
    readonly readonly: boolean;

    /**
     * Open a file synchronously.
     * @param path The file path
     * @param flags Open flags (e.g., 'r', 'w', 'a')
     * @param mode File mode for new files
     */
    openSync(path: string, flags: string, mode?: number): number;

    /**
     * Read from an open file synchronously.
     */
    readSync(
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null
    ): number;

    /**
     * Write to an open file synchronously.
     */
    writeSync(
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null
    ): number;

    /**
     * Close an open file descriptor.
     */
    closeSync(fd: number): void;

    /**
     * Get file stats synchronously.
     */
    statSync(path: string): Stats;

    /**
     * Get file stats for an open file descriptor.
     */
    fstatSync(fd: number): Stats;

    /**
     * Get file stats without following symlinks.
     */
    lstatSync(path: string): Stats;

    /**
     * Read a directory synchronously.
     */
    readdirSync(
      path: string,
      options?: { withFileTypes?: boolean }
    ): string[] | Dirent[];

    /**
     * Create a directory synchronously.
     */
    mkdirSync(path: string, options?: { recursive?: boolean }): void;

    /**
     * Remove a directory synchronously.
     */
    rmdirSync(path: string): void;

    /**
     * Remove a file synchronously.
     */
    unlinkSync(path: string): void;

    /**
     * Rename a file or directory.
     */
    renameSync(oldPath: string, newPath: string): void;

    /**
     * Check if a path exists.
     */
    existsSync(path: string): boolean;

    /**
     * Read a symbolic link.
     */
    readlinkSync(path: string): string;

    /**
     * Create a symbolic link.
     */
    symlinkSync(target: string, path: string): void;

    /**
     * Get the real path (resolve symlinks).
     */
    realpathSync(path: string): string;

    /**
     * Truncate a file.
     */
    truncateSync(path: string, length: number): void;

    /**
     * Change file access and modification times.
     */
    utimesSync(path: string, atime: Date, mtime: Date): void;

    /**
     * Change file mode.
     */
    chmodSync(path: string, mode: number): void;
  }

  /**
   * In-memory file system provider.
   */
  export class MemoryProvider extends VirtualProvider {
    constructor();
  }

  /**
   * Real file system provider (pass-through to Node.js fs).
   */
  export class RealFSProvider extends VirtualProvider {
    constructor(basePath?: string);
  }

  /**
   * Virtual File System implementation.
   *
   * Provides an in-memory file system that can be mounted to intercept
   * Node.js fs operations.
   */
  export class VirtualFileSystem {
    /**
     * Create a new VirtualFileSystem.
     * @param provider The provider to use (defaults to MemoryProvider)
     * @param options Configuration options
     */
    constructor(provider?: VirtualProvider, options?: VirtualFileSystemOptions);

    /**
     * Create a new VirtualFileSystem.
     * @param options Configuration options (uses MemoryProvider)
     */
    constructor(options?: VirtualFileSystemOptions);

    /** The underlying provider */
    readonly provider: VirtualProvider;

    /** The mount point path, or null if not mounted */
    readonly mountPoint: string | null;

    /** Whether the VFS is mounted */
    readonly mounted: boolean;

    /** Whether the provider is read-only */
    readonly readonly: boolean;

    /** Whether overlay mode is enabled */
    readonly overlay: boolean;

    /** Whether virtual working directory is enabled */
    readonly virtualCwdEnabled: boolean;

    /**
     * Mount the VFS at the specified path.
     * After mounting, fs operations to paths under the mount point
     * will be handled by this VFS.
     */
    mount(mountPoint: string, options?: MountOptions): void;

    /**
     * Unmount the VFS.
     */
    unmount(): void;

    /**
     * Get the virtual current working directory.
     */
    cwd(): string | null;

    /**
     * Set the virtual current working directory.
     */
    chdir(dirPath: string): void;

    // ==================== Synchronous File Operations ====================

    /** Check if a path exists */
    existsSync(path: string): boolean;

    /** Get file stats */
    statSync(path: string): Stats;

    /** Get file stats without following symlinks */
    lstatSync(path: string): Stats;

    /** Read a file */
    readFileSync(path: string, options?: { encoding?: null }): Buffer;
    readFileSync(path: string, options: { encoding: BufferEncoding }): string;
    readFileSync(
      path: string,
      options?: { encoding?: BufferEncoding | null }
    ): Buffer | string;

    /** Write a file */
    writeFileSync(
      path: string,
      data: string | Buffer | Uint8Array,
      options?: { encoding?: BufferEncoding; mode?: number; flag?: string }
    ): void;

    /** Append to a file */
    appendFileSync(
      path: string,
      data: string | Buffer,
      options?: { encoding?: BufferEncoding; mode?: number; flag?: string }
    ): void;

    /** Create a directory */
    mkdirSync(
      path: string,
      options?: { recursive?: boolean; mode?: number }
    ): void;

    /** Read a directory */
    readdirSync(path: string): string[];
    readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
    readdirSync(
      path: string,
      options?: { withFileTypes?: boolean }
    ): string[] | Dirent[];

    /** Remove a directory */
    rmdirSync(path: string): void;

    /** Remove a file or directory */
    rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;

    /** Remove a file */
    unlinkSync(path: string): void;

    /** Rename a file or directory */
    renameSync(oldPath: string, newPath: string): void;

    /** Copy a file */
    copyFileSync(src: string, dest: string, mode?: number): void;

    /** Read a symbolic link */
    readlinkSync(path: string): string;

    /** Create a symbolic link */
    symlinkSync(target: string, path: string, type?: string): void;

    /** Get the real path (resolve symlinks) */
    realpathSync(path: string): string;

    /** Check file access */
    accessSync(path: string, mode?: number): void;

    /** Truncate a file */
    truncateSync(path: string, length?: number): void;

    /** Change file access and modification times */
    utimesSync(
      path: string,
      atime: Date | number | string,
      mtime: Date | number | string
    ): void;

    /** Change file mode */
    chmodSync(path: string, mode: number): void;

    // ==================== File Descriptor Operations ====================

    /** Open a file and return a file descriptor */
    openSync(path: string, flags: string, mode?: number): number;

    /** Read from an open file */
    readSync(
      fd: number,
      buffer: Buffer,
      offset?: number,
      length?: number,
      position?: number | null
    ): number;

    /** Write to an open file */
    writeSync(
      fd: number,
      buffer: Buffer | string,
      offset?: number,
      length?: number,
      position?: number | null
    ): number;

    /** Close an open file */
    closeSync(fd: number): void;

    /** Get stats for an open file */
    fstatSync(fd: number): Stats;

    /** Truncate an open file */
    ftruncateSync(fd: number, length?: number): void;

    /** Sync data to disk */
    fsyncSync(fd: number): void;

    /** Sync data to disk (data only) */
    fdatasyncSync(fd: number): void;

    // ==================== Streams ====================

    /** Create a readable stream */
    createReadStream(
      path: string,
      options?: {
        flags?: string;
        encoding?: BufferEncoding;
        start?: number;
        end?: number;
        highWaterMark?: number;
      }
    ): NodeJS.ReadableStream;

    /** Create a writable stream */
    createWriteStream(
      path: string,
      options?: {
        flags?: string;
        encoding?: BufferEncoding;
        mode?: number;
        start?: number;
      }
    ): WriteStream;

    // ==================== Promises API ====================

    /** Promise-based file operations */
    readonly promises: {
      readFile(
        path: string,
        options?: { encoding?: BufferEncoding | null }
      ): Promise<Buffer | string>;
      writeFile(
        path: string,
        data: string | Buffer | Uint8Array,
        options?: { encoding?: BufferEncoding; mode?: number; flag?: string }
      ): Promise<void>;
      appendFile(
        path: string,
        data: string | Buffer,
        options?: { encoding?: BufferEncoding; mode?: number; flag?: string }
      ): Promise<void>;
      mkdir(
        path: string,
        options?: { recursive?: boolean; mode?: number }
      ): Promise<void>;
      readdir(path: string): Promise<string[]>;
      readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
      rmdir(path: string): Promise<void>;
      rm(
        path: string,
        options?: { recursive?: boolean; force?: boolean }
      ): Promise<void>;
      unlink(path: string): Promise<void>;
      rename(oldPath: string, newPath: string): Promise<void>;
      copyFile(src: string, dest: string, mode?: number): Promise<void>;
      stat(path: string): Promise<Stats>;
      lstat(path: string): Promise<Stats>;
      access(path: string, mode?: number): Promise<void>;
      readlink(path: string): Promise<string>;
      symlink(target: string, path: string, type?: string): Promise<void>;
      realpath(path: string): Promise<string>;
      truncate(path: string, length?: number): Promise<void>;
      utimes(
        path: string,
        atime: Date | number | string,
        mtime: Date | number | string
      ): Promise<void>;
      chmod(path: string, mode: number): Promise<void>;
      open(path: string, flags: string, mode?: number): Promise<FileHandle>;
    };

    // ==================== Watch ====================

    /** Watch for file changes */
    watch(
      path: string,
      options?: { persistent?: boolean; recursive?: boolean },
      listener?: (eventType: string, filename: string) => void
    ): FSWatcher;

    /** Watch a file for changes */
    watchFile(
      path: string,
      options?: { persistent?: boolean; interval?: number },
      listener?: (curr: Stats, prev: Stats) => void
    ): void;

    /** Stop watching a file */
    unwatchFile(
      path: string,
      listener?: (curr: Stats, prev: Stats) => void
    ): void;

    // ==================== Glob ====================

    /** Find files matching a pattern */
    globSync(
      pattern: string | string[],
      options?: { cwd?: string; exclude?: (path: string) => boolean }
    ): string[];

    /** Find files matching a pattern (async) */
    glob(
      pattern: string | string[],
      options?: { cwd?: string; exclude?: (path: string) => boolean }
    ): Promise<string[]>;
  }

  /**
   * File handle for promise-based operations.
   */
  export interface FileHandle {
    readonly fd: number;
    read(
      buffer: Buffer,
      offset?: number,
      length?: number,
      position?: number | null
    ): Promise<{ bytesRead: number; buffer: Buffer }>;
    write(
      buffer: Buffer | string,
      offset?: number,
      length?: number,
      position?: number | null
    ): Promise<{ bytesWritten: number; buffer: Buffer }>;
    close(): Promise<void>;
    stat(): Promise<Stats>;
    truncate(length?: number): Promise<void>;
    sync(): Promise<void>;
    datasync(): Promise<void>;
  }

  /**
   * File system watcher.
   */
  export interface FSWatcher {
    close(): void;
    ref(): this;
    unref(): this;
  }

  /**
   * Virtual write stream class.
   */
  export class VirtualWriteStream extends WriteStream {}

  /**
   * Create a new VirtualFileSystem instance.
   */
  export function create(
    provider?: VirtualProvider,
    options?: VirtualFileSystemOptions
  ): VirtualFileSystem;
  export function create(options?: VirtualFileSystemOptions): VirtualFileSystem;
}
