import { describe, it, expect, afterEach } from "vitest";
import { WasixBackend } from "./backend.js";

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

      const downloadResults = await backend.downloadFiles([
        "/a.txt",
        "/b.txt",
      ]);
      expect(downloadResults).toHaveLength(2);
      expect(new TextDecoder().decode(downloadResults[0].content!)).toBe("aaa");
      expect(new TextDecoder().decode(downloadResults[1].content!)).toBe("bbb");
    });
  });

  describe("execute", () => {
    it("returns a stub response with the command", async () => {
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
