import { describe, it, expect } from "vitest";
import {
  applyGrepMaxCount,
  isSandboxBackend,
  type BackendProtocol,
  type BackendProtocolV2,
  type SandboxBackendProtocol,
  type SandboxBackendProtocolV2,
  type ExecuteResponse,
  type FileOperationError,
  type FileDownloadResponse,
  type FileUploadResponse,
} from "./protocol.js";

describe("Protocol Types", () => {
  describe("ExecuteResponse", () => {
    it("should have correct shape", () => {
      const response: ExecuteResponse = {
        output: "hello world",
        exitCode: 0,
        truncated: false,
      };

      expect(response.output).toBe("hello world");
      expect(response.exitCode).toBe(0);
      expect(response.truncated).toBe(false);
    });

    it("should allow null exitCode", () => {
      const response: ExecuteResponse = {
        output: "still running",
        exitCode: null,
        truncated: false,
      };

      expect(response.exitCode).toBeNull();
    });
  });

  describe("FileOperationError", () => {
    it("should allow valid error codes", () => {
      const errors: FileOperationError[] = [
        "file_not_found",
        "permission_denied",
        "is_directory",
        "invalid_path",
      ];

      expect(errors).toHaveLength(4);
    });
  });

  describe("FileDownloadResponse", () => {
    it("should have correct shape for success", () => {
      const response: FileDownloadResponse = {
        path: "/test.txt",
        content: new Uint8Array([1, 2, 3]),
        error: null,
      };

      expect(response.path).toBe("/test.txt");
      expect(response.content).not.toBeNull();
      expect(response.error).toBeNull();
    });

    it("should have correct shape for error", () => {
      const response: FileDownloadResponse = {
        path: "/missing.txt",
        content: null,
        error: "file_not_found",
      };

      expect(response.path).toBe("/missing.txt");
      expect(response.content).toBeNull();
      expect(response.error).toBe("file_not_found");
    });
  });

  describe("FileUploadResponse", () => {
    it("should have correct shape for success", () => {
      const response: FileUploadResponse = {
        path: "/uploaded.txt",
        error: null,
      };

      expect(response.path).toBe("/uploaded.txt");
      expect(response.error).toBeNull();
    });

    it("should have correct shape for error", () => {
      const response: FileUploadResponse = {
        path: "/readonly.txt",
        error: "permission_denied",
      };

      expect(response.path).toBe("/readonly.txt");
      expect(response.error).toBe("permission_denied");
    });
  });
});

describe("isSandboxBackend", () => {
  it("should return true for backends with execute function and id string", () => {
    const sandboxBackend = {
      id: "test-sandbox",
      execute: async () => ({ output: "", exitCode: 0, truncated: false }),
      ls: async () => [],
      read: async () => "",
      grep: async () => [],
      glob: async () => [],
      write: async () => ({ path: "" }),
      edit: async () => ({ path: "" }),
      uploadFiles: async () => [],
      downloadFiles: async () => [],
    } as unknown as SandboxBackendProtocol;

    expect(isSandboxBackend(sandboxBackend)).toBe(true);
  });

  it("should return true for V2 sandbox backends", () => {
    const sandboxBackend: SandboxBackendProtocolV2 = {
      id: "test-sandbox-v2",
      execute: async () => ({ output: "", exitCode: 0, truncated: false }),
      ls: async () => ({ files: [] }),
      read: async () => ({ content: "hello" }),
      readRaw: async () => ({
        data: {
          content: "hello",
          mimeType: "text/plain",
          created_at: "2024-01-01T00:00:00.000Z",
          modified_at: "2024-01-01T00:00:00.000Z",
        },
      }),
      grep: async () => ({ matches: [] }),
      glob: async () => ({ files: [] }),
      write: async () => ({ path: "" }),
      edit: async () => ({ path: "" }),
    };

    expect(isSandboxBackend(sandboxBackend)).toBe(true);
  });

  it("should return false for backends without execute", () => {
    const nonSandboxBackend = {
      ls: async () => [],
      read: async () => "",
      grep: async () => [],
      glob: async () => [],
      write: async () => ({ path: "" }),
      edit: async () => ({ path: "" }),
      uploadFiles: async () => [],
      downloadFiles: async () => [],
    } as unknown as BackendProtocol;

    expect(isSandboxBackend(nonSandboxBackend)).toBe(false);
  });

  it("should return false for V2 backends without execute", () => {
    const nonSandboxBackend: BackendProtocolV2 = {
      ls: async () => ({ files: [] }),
      read: async () => ({ content: "hello" }),
      readRaw: async () => ({
        data: {
          content: "hello",
          mimeType: "text/plain",
          created_at: "2024-01-01T00:00:00.000Z",
          modified_at: "2024-01-01T00:00:00.000Z",
        },
      }),
      grep: async () => ({ matches: [] }),
      glob: async () => ({ files: [] }),
      write: async () => ({ path: "" }),
      edit: async () => ({ path: "" }),
    };

    expect(isSandboxBackend(nonSandboxBackend)).toBe(false);
  });

  it("should return false for backends with execute but no id", () => {
    const backendWithExecute = {
      execute: async () => ({ output: "", exitCode: 0, truncated: false }),
      // Missing id
      ls: async () => [],
      read: async () => "",
      grep: async () => [],
      glob: async () => [],
      write: async () => ({ path: "" }),
      edit: async () => ({ path: "" }),
      uploadFiles: async () => [],
      downloadFiles: async () => [],
    };

    expect(isSandboxBackend(backendWithExecute as any)).toBe(false);
  });

  it("should return false for backends with id but no execute", () => {
    const backendWithId = {
      id: "test-backend",
      // Missing execute
      ls: async () => [],
      read: async () => "",
      grep: async () => [],
      glob: async () => [],
      write: async () => ({ path: "" }),
      edit: async () => ({ path: "" }),
      uploadFiles: async () => [],
      downloadFiles: async () => [],
    };

    expect(isSandboxBackend(backendWithId as any)).toBe(false);
  });

  it("should handle execute as non-function", () => {
    const backendWithBadExecute = {
      id: "test-backend",
      execute: "not a function",
      ls: async () => [],
      read: async () => "",
      grep: async () => [],
      glob: async () => [],
      write: async () => ({ path: "" }),
      edit: async () => ({ path: "" }),
      uploadFiles: async () => [],
      downloadFiles: async () => [],
    };

    expect(isSandboxBackend(backendWithBadExecute as any)).toBe(false);
  });

  it("should handle id as non-string", () => {
    const backendWithBadId = {
      id: 123,
      execute: async () => ({ output: "", exitCode: 0, truncated: false }),
      ls: async () => [],
      read: async () => "",
      grep: async () => [],
      glob: async () => [],
      write: async () => ({ path: "" }),
      edit: async () => ({ path: "" }),
      uploadFiles: async () => [],
      downloadFiles: async () => [],
    };

    expect(isSandboxBackend(backendWithBadId as any)).toBe(false);
  });

  it("should return false for backends with execute and empty string id (#325)", () => {
    const backendWithEmptyId = {
      id: "",
      execute: async () => ({ output: "", exitCode: 0, truncated: false }),
      ls: async () => ({ files: [] }),
      read: async () => ({ content: "" }),
      readRaw: async () => ({
        data: {
          content: "",
          mimeType: "text/plain",
          created_at: "",
          modified_at: "",
        },
      }),
      grep: async () => ({ matches: [] }),
      glob: async () => ({ files: [] }),
      write: async () => ({ path: "" }),
      edit: async () => ({ path: "" }),
    };

    expect(isSandboxBackend(backendWithEmptyId as any)).toBe(false);
  });
});

describe("applyGrepMaxCount", () => {
  const matches = [1, 2, 3, 4, 5].map((line) => ({
    path: "/a.txt",
    line,
    text: "x",
  }));

  it("returns the result untouched when maxCount is null or undefined", () => {
    const result = { matches };
    expect(applyGrepMaxCount({ result, maxCount: null })).toBe(result);
    expect(applyGrepMaxCount({ result, maxCount: undefined })).toBe(result);
  });

  it("truncates at a positive maxCount and flags truncation", () => {
    const patched = applyGrepMaxCount({ result: { matches }, maxCount: 2 });
    expect(patched.matches).toHaveLength(2);
    expect(patched.matches?.map((m) => m.line)).toEqual([1, 2]);
    expect(patched.truncated).toBe(true);
  });

  it("clamps a negative maxCount instead of dropping trailing matches", () => {
    // Regression: `slice(0, -1)` returned 4 of 5 matches with truncated=true.
    const patched = applyGrepMaxCount({ result: { matches }, maxCount: -1 });
    expect(patched.matches).toEqual([]);
    expect(patched.truncated).toBe(true);
  });

  it("floors a fractional maxCount", () => {
    const patched = applyGrepMaxCount({ result: { matches }, maxCount: 2.7 });
    expect(patched.matches).toHaveLength(2);
  });

  it("treats a non-finite maxCount as no limit", () => {
    const result = { matches };
    expect(
      applyGrepMaxCount({ result, maxCount: Number.POSITIVE_INFINITY }),
    ).toBe(result);
    expect(applyGrepMaxCount({ result, maxCount: Number.NaN })).toBe(result);
  });

  it("preserves an existing error while truncating", () => {
    const patched = applyGrepMaxCount({
      result: { matches, error: "partial" },
      maxCount: 1,
    });
    expect(patched.error).toBe("partial");
    expect(patched.matches).toHaveLength(1);
  });

  it("does not flag truncation when nothing is dropped", () => {
    const patched = applyGrepMaxCount({ result: { matches }, maxCount: 10 });
    expect(patched.matches).toHaveLength(5);
    expect(patched.truncated).toBeUndefined();
  });
});
