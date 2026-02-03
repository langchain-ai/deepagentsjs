import { describe, it, expect } from "vitest";
import {
  isSandboxBackend,
  type BackendProtocol,
  type SandboxBackendProtocol,
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
      lsInfo: async () => [],
      read: async () => "",
      grepRaw: async () => [],
      globInfo: async () => [],
      write: async () => ({ path: "" }),
      edit: async () => ({ path: "" }),
      uploadFiles: async () => [],
      downloadFiles: async () => [],
    } as unknown as SandboxBackendProtocol;

    expect(isSandboxBackend(sandboxBackend)).toBe(true);
  });

  it("should return false for backends without execute", () => {
    const nonSandboxBackend = {
      lsInfo: async () => [],
      read: async () => "",
      grepRaw: async () => [],
      globInfo: async () => [],
      write: async () => ({ path: "" }),
      edit: async () => ({ path: "" }),
      uploadFiles: async () => [],
      downloadFiles: async () => [],
    } as unknown as BackendProtocol;

    expect(isSandboxBackend(nonSandboxBackend)).toBe(false);
  });

  it("should return false for backends with execute but no id", () => {
    const backendWithExecute = {
      execute: async () => ({ output: "", exitCode: 0, truncated: false }),
      // Missing id
      lsInfo: async () => [],
      read: async () => "",
      grepRaw: async () => [],
      globInfo: async () => [],
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
      lsInfo: async () => [],
      read: async () => "",
      grepRaw: async () => [],
      globInfo: async () => [],
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
      lsInfo: async () => [],
      read: async () => "",
      grepRaw: async () => [],
      globInfo: async () => [],
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
      lsInfo: async () => [],
      read: async () => "",
      grepRaw: async () => [],
      globInfo: async () => [],
      write: async () => ({ path: "" }),
      edit: async () => ({ path: "" }),
      uploadFiles: async () => [],
      downloadFiles: async () => [],
    };

    expect(isSandboxBackend(backendWithBadId as any)).toBe(false);
  });
});
