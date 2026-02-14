import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WasixBackend } from "./backend.js";
import { createFsCallbacks, type FsCallbacks } from "./fs-callbacks.js";

describe("WasixBackend", () => {
  let backend: WasixBackend | undefined;

  afterEach(() => {
    backend?.close();
    backend = undefined;
  });

  describe("factory method", () => {
    it("creates an instance via WasixBackend.create()", async () => {
      backend = await WasixBackend.create();
      expect(backend).toBeInstanceOf(WasixBackend);
    });

    it("accepts options", async () => {
      backend = await WasixBackend.create({
        packages: ["bash", "coreutils"],
        timeout: 5000,
      });
      expect(backend).toBeInstanceOf(WasixBackend);
    });
  });

  describe("id", () => {
    it("has a unique id per instance", async () => {
      backend = await WasixBackend.create();
      const other = await WasixBackend.create();
      try {
        expect(backend.id).toBeTruthy();
        expect(other.id).toBeTruthy();
        expect(backend.id).not.toBe(other.id);
        expect(backend.id).toMatch(/^wasix-/);
      } finally {
        other.close();
      }
    });
  });

  describe("uploadFiles + downloadFiles roundtrip", () => {
    it("stores and retrieves files from in-memory FS", async () => {
      backend = await WasixBackend.create();
      const content = new TextEncoder().encode("hello world");

      const uploadResults = await backend.uploadFiles([
        ["/test/file.txt", content],
      ]);
      expect(uploadResults).toHaveLength(1);
      expect(uploadResults[0].error).toBeNull();

      const downloadResults = await backend.downloadFiles(["/test/file.txt"]);
      expect(downloadResults).toHaveLength(1);
      expect(downloadResults[0].error).toBeNull();
      expect(new TextDecoder().decode(downloadResults[0].content!)).toBe(
        "hello world",
      );
    });

    it("returns file_not_found for missing files", async () => {
      backend = await WasixBackend.create();
      const results = await backend.downloadFiles(["/nonexistent.txt"]);
      expect(results[0].error).toBe("file_not_found");
      expect(results[0].content).toBeNull();
    });

    it("returns is_directory for directory paths", async () => {
      backend = await WasixBackend.create();
      // Upload a file to create the /mydir directory
      await backend.uploadFiles([
        ["/mydir/file.txt", new Uint8Array([1, 2, 3])],
      ]);
      const results = await backend.downloadFiles(["/mydir"]);
      expect(results[0].error).toBe("is_directory");
    });

    it("handles multiple files in one call", async () => {
      backend = await WasixBackend.create();
      const enc = new TextEncoder();

      const uploadResults = await backend.uploadFiles([
        ["/a.txt", enc.encode("aaa")],
        ["/b.txt", enc.encode("bbb")],
      ]);
      expect(uploadResults).toHaveLength(2);
      expect(uploadResults.every((r) => r.error === null)).toBe(true);

      const downloadResults = await backend.downloadFiles(["/a.txt", "/b.txt"]);
      expect(downloadResults).toHaveLength(2);
      expect(new TextDecoder().decode(downloadResults[0].content!)).toBe("aaa");
      expect(new TextDecoder().decode(downloadResults[1].content!)).toBe("bbb");
    });
  });

  describe("execute (stub path)", () => {
    it("returns a stub response when WASM is not available", async () => {
      backend = await WasixBackend.create();
      const result = await backend.execute("echo hello");
      expect(result.output).toContain("echo hello");
      expect(result.output).toContain("WASIX stub");
      expect(result.exitCode).toBe(1);
      expect(result.truncated).toBe(false);
    });
  });

  describe("close", () => {
    it("does not throw", async () => {
      backend = await WasixBackend.create();
      expect(() => backend!.close()).not.toThrow();
    });

    it("can be called multiple times", async () => {
      backend = await WasixBackend.create();
      backend.close();
      expect(() => backend!.close()).not.toThrow();
      backend = undefined; // already closed
    });
  });
});

describe("createFsCallbacks", () => {
  let files: Map<string, Uint8Array>;
  let dirs: Set<string>;
  let cb: FsCallbacks;

  beforeEach(() => {
    files = new Map<string, Uint8Array>();
    dirs = new Set<string>(["/", "/workspace"]);
    cb = createFsCallbacks(files, dirs);
  });

  describe("fs_read_file / fs_write_file", () => {
    it("writes and reads a file", () => {
      const data = new TextEncoder().encode("hello");
      expect(cb.fs_write_file("/test.txt", data)).toBe(true);
      const result = cb.fs_read_file("/test.txt");
      expect(result).not.toBeNull();
      expect(new TextDecoder().decode(result!)).toBe("hello");
    });

    it("returns null for nonexistent file", () => {
      expect(cb.fs_read_file("/missing.txt")).toBeNull();
    });

    it("creates parent directories on write", () => {
      const data = new TextEncoder().encode("content");
      cb.fs_write_file("/a/b/c.txt", data);
      expect(dirs.has("/a")).toBe(true);
      expect(dirs.has("/a/b")).toBe(true);
    });
  });

  describe("fs_metadata", () => {
    it("returns file metadata", () => {
      const data = new TextEncoder().encode("12345");
      files.set("/file.txt", data);
      const meta = cb.fs_metadata("/file.txt");
      expect(meta).toEqual({ is_file: true, is_dir: false, len: 5 });
    });

    it("returns directory metadata", () => {
      const meta = cb.fs_metadata("/workspace");
      expect(meta).toEqual({ is_file: false, is_dir: true, len: 0 });
    });

    it("returns null for nonexistent path", () => {
      expect(cb.fs_metadata("/nope")).toBeNull();
    });
  });

  describe("fs_read_dir", () => {
    it("lists direct children", () => {
      files.set("/workspace/a.txt", new Uint8Array([1]));
      files.set("/workspace/b.txt", new Uint8Array([2, 3]));
      dirs.add("/workspace/sub");

      const entries = cb.fs_read_dir("/workspace");
      expect(entries).not.toBeNull();
      const names = entries!.map((e) => e.name).sort();
      expect(names).toEqual(["a.txt", "b.txt", "sub"]);
    });

    it("returns null for nonexistent directory", () => {
      expect(cb.fs_read_dir("/nonexistent")).toBeNull();
    });
  });

  describe("fs_create_dir / fs_remove_dir", () => {
    it("creates and removes a directory", () => {
      expect(cb.fs_create_dir("/mydir")).toBe(true);
      expect(dirs.has("/mydir")).toBe(true);

      expect(cb.fs_remove_dir("/mydir")).toBe(true);
      expect(dirs.has("/mydir")).toBe(false);
    });
  });

  describe("fs_remove_file", () => {
    it("removes a file", () => {
      files.set("/tmp.txt", new Uint8Array(0));
      expect(cb.fs_remove_file("/tmp.txt")).toBe(true);
      expect(files.has("/tmp.txt")).toBe(false);
    });

    it("returns false for nonexistent file", () => {
      expect(cb.fs_remove_file("/nope")).toBe(false);
    });
  });

  describe("fs_rename", () => {
    it("renames a file", () => {
      const data = new TextEncoder().encode("content");
      files.set("/old.txt", data);
      expect(cb.fs_rename("/old.txt", "/new.txt")).toBe(true);
      expect(files.has("/old.txt")).toBe(false);
      expect(files.has("/new.txt")).toBe(true);
    });

    it("renames a directory and moves its contents", () => {
      dirs.add("/src");
      files.set("/src/a.txt", new TextEncoder().encode("a"));
      dirs.add("/src/sub");

      expect(cb.fs_rename("/src", "/dest")).toBe(true);
      expect(dirs.has("/src")).toBe(false);
      expect(dirs.has("/dest")).toBe(true);
      expect(files.has("/dest/a.txt")).toBe(true);
      expect(dirs.has("/dest/sub")).toBe(true);
    });
  });

  describe("file handles", () => {
    it("opens, writes, seeks, reads, and closes a handle", () => {
      const handle = cb.fs_open("/handle-test.txt", {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: false,
      });
      expect(handle).toBeGreaterThan(0);

      const data = new TextEncoder().encode("hello world");
      const written = cb.fs_handle_write(handle, data);
      expect(written).toBe(data.byteLength);

      const pos = cb.fs_handle_seek(handle, 0, 0);
      expect(pos).toBe(0);

      const readData = cb.fs_handle_read(handle, 5);
      expect(readData).not.toBeNull();
      expect(new TextDecoder().decode(readData!)).toBe("hello");

      cb.fs_handle_close(handle);
      expect(cb.fs_handle_read(handle, 5)).toBeNull();
    });

    it("opens file in append mode", () => {
      files.set("/append.txt", new TextEncoder().encode("hello"));
      const handle = cb.fs_open("/append.txt", {
        read: false,
        write: true,
        create: false,
        truncate: false,
        append: true,
      });

      cb.fs_handle_write(handle, new TextEncoder().encode(" world"));
      cb.fs_handle_close(handle);

      const content = new TextDecoder().decode(files.get("/append.txt")!);
      expect(content).toBe("hello world");
    });

    it("opens file with truncate", () => {
      files.set("/trunc.txt", new TextEncoder().encode("old content"));
      const handle = cb.fs_open("/trunc.txt", {
        read: true,
        write: true,
        create: false,
        truncate: true,
        append: false,
      });

      const readData = cb.fs_handle_read(handle, 100);
      expect(readData).not.toBeNull();
      expect(readData!.byteLength).toBe(0);
      cb.fs_handle_close(handle);
    });

    it("returns -1 for open on nonexistent file without create", () => {
      const handle = cb.fs_open("/no-such-file.txt", {
        read: true,
        write: false,
        create: false,
        truncate: false,
        append: false,
      });
      expect(handle).toBe(-1);
    });

    it("seek with whence=1 (Current) works", () => {
      files.set("/seek.txt", new TextEncoder().encode("abcdef"));
      const handle = cb.fs_open("/seek.txt", {
        read: true,
        write: false,
        create: false,
        truncate: false,
        append: false,
      });

      cb.fs_handle_read(handle, 2);
      const pos = cb.fs_handle_seek(handle, 1, 1);
      expect(pos).toBe(3);

      const data = cb.fs_handle_read(handle, 3);
      expect(new TextDecoder().decode(data!)).toBe("def");
      cb.fs_handle_close(handle);
    });

    it("seek with whence=2 (End) works", () => {
      files.set("/end.txt", new TextEncoder().encode("abcdef"));
      const handle = cb.fs_open("/end.txt", {
        read: true,
        write: false,
        create: false,
        truncate: false,
        append: false,
      });

      const pos = cb.fs_handle_seek(handle, -2, 2);
      expect(pos).toBe(4);

      const data = cb.fs_handle_read(handle, 10);
      expect(new TextDecoder().decode(data!)).toBe("ef");
      cb.fs_handle_close(handle);
    });
  });

  describe("shared store with uploadFiles/downloadFiles", () => {
    it("FS callbacks see files written via the Map directly", () => {
      files.set("/uploaded.txt", new TextEncoder().encode("from upload"));

      const data = cb.fs_read_file("/uploaded.txt");
      expect(new TextDecoder().decode(data!)).toBe("from upload");

      const meta = cb.fs_metadata("/uploaded.txt");
      expect(meta?.is_file).toBe(true);
    });

    it("files written via callbacks are visible in the Map", () => {
      cb.fs_write_file("/cb-written.txt", new TextEncoder().encode("from cb"));

      expect(files.has("/cb-written.txt")).toBe(true);
      expect(new TextDecoder().decode(files.get("/cb-written.txt")!)).toBe(
        "from cb",
      );
    });
  });
});
