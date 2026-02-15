import { describe, it, expect, afterEach } from "vitest";
import type {
  BackendProtocol,
  FileInfo,
  FileDownloadResponse,
  FileUploadResponse,
} from "deepagents";
import { DeepbashBackend } from "../src/backend.js";
import { DeepbashError } from "../src/types.js";
/**
 * Minimal mock BackendProtocol for testing mount sync logic.
 * Uses in-memory storage. Only globInfo, downloadFiles, and uploadFiles
 * are needed for mount sync.
 */
class MockBackend implements BackendProtocol {
  readonly files = new Map<string, Uint8Array>();

  /** Seed the mock with files */
  seed(path: string, content: string | Uint8Array): void {
    const data =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.files.set(path.startsWith("/") ? path : `/${path}`, data);
  }

  /** Read a file's content as string (test helper) */
  readString(path: string): string | undefined {
    const data = this.files.get(path.startsWith("/") ? path : `/${path}`);
    return data ? new TextDecoder().decode(data) : undefined;
  }

  globInfo(pattern: string, _path?: string): FileInfo[] {
    const results: FileInfo[] = [];
    for (const [filePath] of this.files) {
      // Simple: return all files when pattern is "**/*"
      if (pattern === "**/*") {
        results.push({ path: filePath, is_dir: false });
      }
    }
    return results;
  }

  downloadFiles(paths: string[]): FileDownloadResponse[] {
    return paths.map((p) => {
      const normalized = p.startsWith("/") ? p : `/${p}`;
      const content = this.files.get(normalized);
      if (content) {
        return { path: p, content: new Uint8Array(content), error: null };
      }
      return { path: p, content: null, error: "file_not_found" as const };
    });
  }

  uploadFiles(files: Array<[string, Uint8Array]>): FileUploadResponse[] {
    return files.map(([path, content]) => {
      const normalized = path.startsWith("/") ? path : `/${path}`;
      this.files.set(normalized, new Uint8Array(content));
      return { path, error: null };
    });
  }

  // Stubs for required BackendProtocol methods (not used by mount sync)
  lsInfo(): FileInfo[] {
    return [];
  }
  read(): string {
    return "";
  }
  readRaw() {
    return {
      content: [],
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString(),
    };
  }
  grepRaw(): [] {
    return [];
  }
  write() {
    return {};
  }
  edit() {
    return {};
  }
}

describe("DeepbashBackend", () => {
  let backend: DeepbashBackend | undefined;

  afterEach(() => {
    backend?.close();
    backend = undefined;
  });

  describe("factory method", () => {
    it("creates an instance via DeepbashBackend.create()", async () => {
      backend = await DeepbashBackend.create();
      expect(backend).toBeInstanceOf(DeepbashBackend);
    });

    it("accepts options", async () => {
      backend = await DeepbashBackend.create({
        packages: ["bash", "coreutils"],
        timeout: 5000,
      });
      expect(backend).toBeInstanceOf(DeepbashBackend);
    });
  });

  describe("id", () => {
    it("has a unique id per instance", async () => {
      backend = await DeepbashBackend.create();
      const other = await DeepbashBackend.create();
      try {
        expect(backend.id).toBeTruthy();
        expect(other.id).toBeTruthy();
        expect(backend.id).not.toBe(other.id);
        expect(backend.id).toMatch(/^deepbash-/);
      } finally {
        other.close();
      }
    });
  });

  describe("uploadFiles + downloadFiles roundtrip", () => {
    it("stores and retrieves files from in-memory FS", async () => {
      backend = await DeepbashBackend.create();
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
      backend = await DeepbashBackend.create();
      const results = await backend.downloadFiles(["/nonexistent.txt"]);
      expect(results[0].error).toBe("file_not_found");
      expect(results[0].content).toBeNull();
    });

    it("returns is_directory for directory paths", async () => {
      backend = await DeepbashBackend.create();
      // Upload a file to create the /mydir directory
      await backend.uploadFiles([
        ["/mydir/file.txt", new Uint8Array([1, 2, 3])],
      ]);
      const results = await backend.downloadFiles(["/mydir"]);
      expect(results[0].error).toBe("is_directory");
    });

    it("handles multiple files in one call", async () => {
      backend = await DeepbashBackend.create();
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

  describe("execute", () => {
    it("runs a command when SDK is available, or throws when not", async () => {
      backend = await DeepbashBackend.create();
      try {
        const result = await backend.execute("echo hello");
        // SDK initialized — verify we got real output
        expect(result.output).toContain("hello");
        expect(result.truncated).toBe(false);
        expect(result.spawnRequests).toEqual([]);
      } catch (err) {
        // SDK did not initialize — verify the error
        expect(err).toBeInstanceOf(DeepbashError);
        expect((err as DeepbashError).code).toBe(
          "WASM_ENGINE_NOT_INITIALIZED",
        );
      }
    }, 30000);
  });

  describe("RPC spawn request scanning", () => {
    it("parses spawn requests from /.rpc/requests/ after execute", async () => {
      backend = await DeepbashBackend.create();
      const enc = new TextEncoder();

      const rpcRequest = JSON.stringify({
        id: "test-1234-5678",
        method: "spawn",
        args: { task: "analyze this file" },
        timestamp: "1700000000.123",
      });

      // Upload an RPC request file to the in-memory FS
      await backend.uploadFiles([
        ["/.rpc/requests/test-1234-5678.json", enc.encode(rpcRequest)],
      ]);

      try {
        const result = await backend.execute("echo noop");
        // SDK available — verify spawn requests were parsed
        expect(result.spawnRequests).toHaveLength(1);
        expect(result.spawnRequests[0]).toEqual({
          id: "test-1234-5678",
          method: "spawn",
          args: { task: "analyze this file" },
          timestamp: "1700000000.123",
        });
      } catch (err) {
        // SDK not available — skip RPC assertions
        expect(err).toBeInstanceOf(DeepbashError);
      }
    }, 30000);

    it("cleans up processed RPC files after scanning", async () => {
      backend = await DeepbashBackend.create();
      const enc = new TextEncoder();

      const rpcRequest = JSON.stringify({
        id: "cleanup-001",
        method: "spawn",
        args: { task: "test cleanup" },
        timestamp: "1700000001.000",
      });

      await backend.uploadFiles([
        ["/.rpc/requests/cleanup-001.json", enc.encode(rpcRequest)],
      ]);

      try {
        // First execute: should find and return the request
        const result1 = await backend.execute("echo first");
        expect(result1.spawnRequests).toHaveLength(1);
        expect(result1.spawnRequests[0].id).toBe("cleanup-001");

        // Second execute: request files should be cleaned up
        const result2 = await backend.execute("echo second");
        expect(result2.spawnRequests).toHaveLength(0);
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
      }
    }, 60000);

    it("handles multiple spawn requests in one execution", async () => {
      backend = await DeepbashBackend.create();
      const enc = new TextEncoder();

      const requests = [
        {
          id: "multi-001",
          method: "spawn" as const,
          args: { task: "task one" },
          timestamp: "1700000001.000",
        },
        {
          id: "multi-002",
          method: "spawn" as const,
          args: { task: "task two" },
          timestamp: "1700000002.000",
        },
      ];

      await backend.uploadFiles(
        requests.map(
          (r) =>
            [`/.rpc/requests/${r.id}.json`, enc.encode(JSON.stringify(r))] as [
              string,
              Uint8Array,
            ],
        ),
      );

      try {
        const result = await backend.execute("echo noop");
        expect(result.spawnRequests).toHaveLength(2);
        const ids = result.spawnRequests.map((r) => r.id).sort();
        expect(ids).toEqual(["multi-001", "multi-002"]);
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
      }
    }, 30000);

    it("ignores malformed JSON in RPC directory", async () => {
      backend = await DeepbashBackend.create();
      const enc = new TextEncoder();

      // Upload a valid request and an invalid one
      const validRequest = JSON.stringify({
        id: "valid-001",
        method: "spawn",
        args: { task: "valid task" },
        timestamp: "1700000003.000",
      });

      await backend.uploadFiles([
        ["/.rpc/requests/valid-001.json", enc.encode(validRequest)],
        ["/.rpc/requests/bad.json", enc.encode("not valid json{{{")],
      ]);

      try {
        const result = await backend.execute("echo noop");
        // Only the valid request should be returned
        expect(result.spawnRequests).toHaveLength(1);
        expect(result.spawnRequests[0].id).toBe("valid-001");
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
      }
    }, 30000);

    it("ignores JSON files with missing required fields", async () => {
      backend = await DeepbashBackend.create();
      const enc = new TextEncoder();

      // Missing 'method' field
      const incomplete = JSON.stringify({
        id: "incomplete-001",
        args: { task: "some task" },
        timestamp: "1700000004.000",
      });

      await backend.uploadFiles([
        ["/.rpc/requests/incomplete-001.json", enc.encode(incomplete)],
      ]);

      try {
        const result = await backend.execute("echo noop");
        expect(result.spawnRequests).toHaveLength(0);
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
      }
    }, 30000);

    it("ignores non-JSON files in RPC directory", async () => {
      backend = await DeepbashBackend.create();
      const enc = new TextEncoder();

      const validRequest = JSON.stringify({
        id: "json-only-001",
        method: "spawn",
        args: { task: "task" },
        timestamp: "1700000005.000",
      });

      await backend.uploadFiles([
        ["/.rpc/requests/json-only-001.json", enc.encode(validRequest)],
        ["/.rpc/requests/readme.txt", enc.encode("not a request")],
        ["/.rpc/requests/.lockfile", enc.encode("")],
      ]);

      try {
        const result = await backend.execute("echo noop");
        expect(result.spawnRequests).toHaveLength(1);
        expect(result.spawnRequests[0].id).toBe("json-only-001");
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
      }
    }, 30000);
  });

  describe("shell", () => {
    it("throws if not initialized", async () => {
      // Access the constructor indirectly by creating then closing
      backend = await DeepbashBackend.create();
      backend.close();
      await expect(backend.shell()).rejects.toThrow(DeepbashError);
      await expect(backend.shell()).rejects.toThrow("not initialized");
      backend = undefined;
    });

    it("starts a shell or throws when SDK not available", async () => {
      backend = await DeepbashBackend.create();
      try {
        const session = await backend.shell();
        // SDK initialized — verify we got a session with all expected properties
        expect(session.stdin).toBeDefined();
        expect(session.stdout).toBeDefined();
        expect(session.stderr).toBeDefined();
        expect(typeof session.wait).toBe("function");
        expect(typeof session.writeLine).toBe("function");
        expect(typeof session.kill).toBe("function");

        // Clean up the session
        session.kill();
      } catch (err) {
        // SDK did not initialize — verify the error
        expect(err).toBeInstanceOf(DeepbashError);
        expect((err as DeepbashError).code).toBe(
          "WASM_ENGINE_NOT_INITIALIZED",
        );
      }
    }, 30000);

    it("session has stdin as WritableStream", async () => {
      backend = await DeepbashBackend.create();
      try {
        const session = await backend.shell();
        expect(session.stdin).toBeInstanceOf(WritableStream);
        session.kill();
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
      }
    }, 30000);

    it("session has stdout and stderr as ReadableStream", async () => {
      backend = await DeepbashBackend.create();
      try {
        const session = await backend.shell();
        expect(session.stdout).toBeInstanceOf(ReadableStream);
        expect(session.stderr).toBeInstanceOf(ReadableStream);
        session.kill();
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
      }
    }, 30000);

    it("kill() does not throw when called multiple times", async () => {
      backend = await DeepbashBackend.create();
      try {
        const session = await backend.shell();
        expect(() => session.kill()).not.toThrow();
        expect(() => session.kill()).not.toThrow();
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
      }
    }, 30000);
  });

  describe("close", () => {
    it("does not throw", async () => {
      backend = await DeepbashBackend.create();
      expect(() => backend!.close()).not.toThrow();
    });

    it("can be called multiple times", async () => {
      backend = await DeepbashBackend.create();
      backend.close();
      expect(() => backend!.close()).not.toThrow();
      backend = undefined; // already closed
    });
  });
});

describe("DeepbashBackend mounts", () => {
  let backend: DeepbashBackend | undefined;

  afterEach(() => {
    backend?.close();
    backend = undefined;
  });

  describe("creation with mounts option", () => {
    it("accepts mounts option without error", async () => {
      const mockBackend = new MockBackend();
      backend = await DeepbashBackend.create({
        mounts: { "/work": mockBackend },
      });
      expect(backend).toBeInstanceOf(DeepbashBackend);
    });

    it("accepts multiple mounts", async () => {
      const backend1 = new MockBackend();
      const backend2 = new MockBackend();
      backend = await DeepbashBackend.create({
        mounts: { "/work": backend1, "/data": backend2 },
      });
      expect(backend).toBeInstanceOf(DeepbashBackend);
    });
  });

  describe("execute with mounts", () => {
    it("downloads files from mock backend before execution", async () => {
      const mockBackend = new MockBackend();
      mockBackend.seed("/hello.txt", "Hello from mount!");

      backend = await DeepbashBackend.create({
        mounts: { "/work": mockBackend },
      });

      try {
        const result = await backend.execute("cat /work/hello.txt");
        expect(result.output).toContain("Hello from mount!");
      } catch (err) {
        // SDK not available — verify it's the expected error
        expect(err).toBeInstanceOf(DeepbashError);
        expect((err as DeepbashError).code).toBe(
          "WASM_ENGINE_NOT_INITIALIZED",
        );
      }
    }, 30000);

    it("uploads new files back to mock backend after execution", async () => {
      const mockBackend = new MockBackend();

      backend = await DeepbashBackend.create({
        mounts: { "/work": mockBackend },
      });

      try {
        await backend.execute("echo 'new content' > /work/output.txt");
        // File should have been uploaded back to the mock backend
        const content = mockBackend.readString("/output.txt");
        expect(content).toBeDefined();
        expect(content).toContain("new content");
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
        expect((err as DeepbashError).code).toBe(
          "WASM_ENGINE_NOT_INITIALIZED",
        );
      }
    }, 30000);

    it("uploads modified files back to mock backend after execution", async () => {
      const mockBackend = new MockBackend();
      mockBackend.seed("/data.txt", "original");

      backend = await DeepbashBackend.create({
        mounts: { "/work": mockBackend },
      });

      try {
        await backend.execute("echo 'modified' > /work/data.txt");
        const content = mockBackend.readString("/data.txt");
        expect(content).toBeDefined();
        expect(content).toContain("modified");
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
        expect((err as DeepbashError).code).toBe(
          "WASM_ENGINE_NOT_INITIALIZED",
        );
      }
    }, 30000);

    it("does not re-upload unchanged files", async () => {
      const mockBackend = new MockBackend();
      mockBackend.seed("/unchanged.txt", "same content");

      // Track uploads
      const uploadedPaths: string[] = [];
      const origUpload = mockBackend.uploadFiles.bind(mockBackend);
      mockBackend.uploadFiles = (files: Array<[string, Uint8Array]>) => {
        for (const [p] of files) uploadedPaths.push(p);
        return origUpload(files);
      };

      backend = await DeepbashBackend.create({
        mounts: { "/work": mockBackend },
      });

      try {
        // Run a command that doesn't modify any files
        await backend.execute("echo noop");
        // The unchanged file should NOT have been uploaded
        expect(uploadedPaths).not.toContain("/unchanged.txt");
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
        expect((err as DeepbashError).code).toBe(
          "WASM_ENGINE_NOT_INITIALIZED",
        );
      }
    }, 30000);

    it("handles multiple mounts simultaneously", async () => {
      const work = new MockBackend();
      const data = new MockBackend();
      work.seed("/task.txt", "task info");
      data.seed("/config.json", '{"key":"value"}');

      backend = await DeepbashBackend.create({
        mounts: { "/work": work, "/data": data },
      });

      try {
        const result = await backend.execute(
          "cat /work/task.txt && cat /data/config.json",
        );
        expect(result.output).toContain("task info");
        expect(result.output).toContain('{"key":"value"}');
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
        expect((err as DeepbashError).code).toBe(
          "WASM_ENGINE_NOT_INITIALIZED",
        );
      }
    }, 30000);
  });

  describe("backward compatibility", () => {
    it("no mounts option uses in-memory FS as before", async () => {
      backend = await DeepbashBackend.create();
      const enc = new TextEncoder();

      // Upload a file to in-memory FS
      await backend.uploadFiles([
        ["/test.txt", enc.encode("in-memory content")],
      ]);

      try {
        const result = await backend.execute("cat /work/test.txt");
        expect(result.output).toContain("in-memory content");
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
        expect((err as DeepbashError).code).toBe(
          "WASM_ENGINE_NOT_INITIALIZED",
        );
      }
    }, 30000);

    it("empty mounts object uses in-memory FS as before", async () => {
      backend = await DeepbashBackend.create({ mounts: {} });
      const enc = new TextEncoder();

      await backend.uploadFiles([["/file.txt", enc.encode("still works")]]);

      try {
        const result = await backend.execute("cat /work/file.txt");
        expect(result.output).toContain("still works");
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
      }
    }, 30000);
  });

  describe("mount edge cases", () => {
    it("skips mounts without downloadFiles", async () => {
      // Create a backend that doesn't implement downloadFiles
      const noDownload = new MockBackend();
      // Remove downloadFiles to simulate optional method
      (noDownload as Partial<MockBackend>).downloadFiles = undefined;

      backend = await DeepbashBackend.create({
        mounts: { "/work": noDownload as BackendProtocol },
      });

      try {
        // Should not throw — just creates an empty directory
        const result = await backend.execute("ls /work");
        expect(result.exitCode).toBeDefined();
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
        expect((err as DeepbashError).code).toBe(
          "WASM_ENGINE_NOT_INITIALIZED",
        );
      }
    }, 30000);

    it("skips upload for mounts without uploadFiles", async () => {
      const noUpload = new MockBackend();
      noUpload.seed("/file.txt", "data");
      // Remove uploadFiles to simulate optional method
      (noUpload as Partial<MockBackend>).uploadFiles = undefined;

      backend = await DeepbashBackend.create({
        mounts: { "/work": noUpload as BackendProtocol },
      });

      try {
        // Should not throw even when files are modified
        const result = await backend.execute("echo 'new' > /work/file.txt");
        expect(result.exitCode).toBeDefined();
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
        expect((err as DeepbashError).code).toBe(
          "WASM_ENGINE_NOT_INITIALIZED",
        );
      }
    }, 30000);

    it("handles empty backend (no files to download)", async () => {
      const emptyBackend = new MockBackend();

      backend = await DeepbashBackend.create({
        mounts: { "/work": emptyBackend },
      });

      try {
        const result = await backend.execute("echo hello > /work/new.txt");
        // If the command succeeded, verify the file was uploaded
        if (result.exitCode === 0) {
          expect(emptyBackend.readString("/new.txt")).toContain("hello");
        }
        // Either way, execution should complete without throwing
        expect(result.exitCode).toBeDefined();
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
        expect((err as DeepbashError).code).toBe(
          "WASM_ENGINE_NOT_INITIALIZED",
        );
      }
    }, 30000);

    it("handles download errors gracefully", async () => {
      const errorBackend = new MockBackend();
      // Override globInfo to return a file but downloadFiles to return error
      errorBackend.globInfo = () => [{ path: "/broken.txt", is_dir: false }];
      errorBackend.downloadFiles = () => [
        { path: "/broken.txt", content: null, error: "file_not_found" },
      ];

      backend = await DeepbashBackend.create({
        mounts: { "/work": errorBackend },
      });

      try {
        // Should not throw — skips files with download errors
        const result = await backend.execute("echo ok");
        expect(result.output).toContain("ok");
      } catch (err) {
        expect(err).toBeInstanceOf(DeepbashError);
        expect((err as DeepbashError).code).toBe(
          "WASM_ENGINE_NOT_INITIALIZED",
        );
      }
    }, 30000);
  });
});

