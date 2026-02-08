import { describe, it, expect, vi } from "vitest";
import { BaseSandbox } from "./sandbox.js";
import type {
  ExecuteResponse,
  FileDownloadResponse,
  FileUploadResponse,
} from "./protocol.js";

/**
 * Mock implementation of BaseSandbox for testing.
 * Simulates command execution and file operations using an in-memory file store.
 */
class MockSandbox extends BaseSandbox {
  readonly id = "mock-sandbox-1";

  // Store for simulating file operations
  private files: Map<string, string> = new Map();

  // Track executed commands for assertions
  public executedCommands: string[] = [];

  async execute(command: string): Promise<ExecuteResponse> {
    this.executedCommands.push(command);

    // Simulate ls command (find + stat with -maxdepth 1)
    if (command.includes("-maxdepth 1") && command.includes("stat -c")) {
      const files = Array.from(this.files.keys());
      const now = Math.floor(Date.now() / 1000);
      const output = files
        .map((f) => `${this.files.get(f)!.length}\t${now}\tregular file\t${f}`)
        .join("\n");
      return { output, exitCode: 0, truncated: false };
    }

    // Simulate find command for glob (find + stat, recursive — no -maxdepth 1)
    if (command.includes("stat -c") && !command.includes("-maxdepth 1")) {
      const files = Array.from(this.files.keys());
      const now = Math.floor(Date.now() / 1000);
      const output = files
        .map((f) => `${this.files.get(f)!.length}\t${now}\tregular file\t${f}`)
        .join("\n");
      return { output, exitCode: 0, truncated: false };
    }

    // Simulate read command (awk-based)
    if (command.includes("awk") && command.includes("printf")) {
      // Extract file path from the shell-quoted path at end of command
      const pathMatch = command.match(/'([^']+)'\s*$/);
      if (pathMatch) {
        const filePath = pathMatch[1];
        const content = this.files.get(filePath);
        if (!content) {
          return {
            output: "Error: File not found",
            exitCode: 1,
            truncated: false,
          };
        }
        if (content.length === 0) {
          return {
            output: "System reminder: File exists but has empty contents",
            exitCode: 0,
            truncated: false,
          };
        }
        const lines = content.split("\n");
        const output = lines
          .map((line, i) => `     ${i + 1}\t${line}`)
          .join("\n");
        return { output, exitCode: 0, truncated: false };
      }
    }

    // Simulate grep command (grep -rHnF or find + grep -HnF)
    if (command.includes("grep") && command.includes("-e ")) {
      // Extract pattern from -e 'pattern'
      const patternMatch = command.match(/-e '([^']+)'/);
      if (patternMatch) {
        const pattern = patternMatch[1];

        const results: string[] = [];
        for (const [filePath, content] of this.files) {
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(pattern)) {
              results.push(`${filePath}:${i + 1}:${lines[i]}`);
            }
          }
        }
        return { output: results.join("\n"), exitCode: 0, truncated: false };
      }
    }

    // Default response for unknown commands
    return { output: "", exitCode: 0, truncated: false };
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const responses: FileUploadResponse[] = [];
    for (const [path, content] of files) {
      try {
        const contentStr = new TextDecoder().decode(content);
        this.files.set(path, contentStr);
        responses.push({ path, error: null });
      } catch {
        responses.push({ path, error: "invalid_path" });
      }
    }
    return responses;
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const responses: FileDownloadResponse[] = [];
    for (const path of paths) {
      const content = this.files.get(path);
      if (content === undefined) {
        responses.push({ path, content: null, error: "file_not_found" });
      } else {
        const bytes = new TextEncoder().encode(content);
        responses.push({ path, content: bytes, error: null });
      }
    }
    return responses;
  }

  // Helper to add files for testing
  addFile(path: string, content: string) {
    this.files.set(path, content);
  }

  // Helper to get file content
  getFile(path: string): string | undefined {
    return this.files.get(path);
  }
}

describe("BaseSandbox", () => {
  describe("isSandboxBackend type guard", () => {
    it("should return true for sandbox backends", async () => {
      const { isSandboxBackend } = await import("./protocol.js");
      const sandbox = new MockSandbox();
      expect(isSandboxBackend(sandbox)).toBe(true);
    });

    it("should return false for non-sandbox backends", async () => {
      const { isSandboxBackend } = await import("./protocol.js");
      const { StateBackend } = await import("./state.js");

      const stateAndStore = { state: { files: {} }, store: undefined };
      const stateBackend = new StateBackend(stateAndStore);
      expect(isSandboxBackend(stateBackend)).toBe(false);
    });
  });

  describe("lsInfo", () => {
    it("should list files via execute using find + stat", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "content");
      sandbox.addFile("/dir/nested.txt", "nested");

      await sandbox.lsInfo("/");
      expect(sandbox.executedCommands.length).toBeGreaterThan(0);
      expect(sandbox.executedCommands[0]).toContain("find");
      expect(sandbox.executedCommands[0]).toContain("stat");
      expect(sandbox.executedCommands[0]).toContain("-maxdepth 1");
    });

    it("should return empty array for non-existent directory", async () => {
      const sandbox = new MockSandbox();
      // Mock execute to return error
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "Error",
        exitCode: 1,
        truncated: false,
      });

      const result = await sandbox.lsInfo("/nonexistent");
      expect(result).toEqual([]);
    });
  });

  describe("read", () => {
    it("should read file via execute with awk", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "line1\nline2\nline3");

      const result = await sandbox.read("/test.txt");
      expect(result).toContain("line1");
      expect(result).toContain("line2");
    });

    it("should return error for non-existent file", async () => {
      const sandbox = new MockSandbox();

      const result = await sandbox.read("/nonexistent.txt");
      expect(result).toContain("Error");
      expect(result).toContain("not found");
    });

    it("should use execute (not downloadFiles) for efficiency", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "content");

      await sandbox.read("/test.txt");
      // read should go through execute, not downloadFiles
      expect(sandbox.executedCommands.length).toBe(1);
      expect(sandbox.executedCommands[0]).toContain("awk");
    });
  });

  describe("readRaw", () => {
    it("should read file via downloadFiles", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "line1\nline2\nline3");

      const result = await sandbox.readRaw("/test.txt");
      expect(result.content).toContain("line1");
      expect(result.content).toContain("line2");
      // Should NOT go through execute
      expect(sandbox.executedCommands.length).toBe(0);
    });

    it("should throw for non-existent file", async () => {
      const sandbox = new MockSandbox();

      await expect(sandbox.readRaw("/nonexistent.txt")).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("write", () => {
    it("should write file via uploadFiles", async () => {
      const sandbox = new MockSandbox();

      const result = await sandbox.write("/new.txt", "new content");
      expect(result.error).toBeUndefined();
      expect(result.path).toBe("/new.txt");
      expect(result.filesUpdate).toBeNull();

      // Verify the file was written
      expect(sandbox.getFile("/new.txt")).toBe("new content");
      // Should NOT go through execute
      expect(sandbox.executedCommands.length).toBe(0);
    });

    it("should return error if file already exists", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/existing.txt", "old content");

      const result = await sandbox.write("/existing.txt", "content");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("already exists");
    });
  });

  describe("edit", () => {
    it("should edit file via downloadFiles + uploadFiles", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "Hello World");

      const result = await sandbox.edit(
        "/test.txt",
        "World",
        "Universe",
        false,
      );
      expect(result.error).toBeUndefined();
      expect(result.occurrences).toBe(1);
      expect(result.filesUpdate).toBeNull();

      // Verify the edit
      expect(sandbox.getFile("/test.txt")).toBe("Hello Universe");
      // Should NOT go through execute
      expect(sandbox.executedCommands.length).toBe(0);
    });

    it("should return error when string not found", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "Hello World");

      const result = await sandbox.edit("/test.txt", "notfound", "new", false);
      expect(result.error).toContain("not found");
    });

    it("should return error for multiple occurrences without replaceAll", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "foo bar foo baz foo");

      const result = await sandbox.edit("/test.txt", "foo", "qux", false);
      expect(result.error).toContain("Multiple occurrences");
      expect(result.error).toContain("replaceAll");
    });

    it("should replace all occurrences with replaceAll=true", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "foo bar foo baz foo");

      const result = await sandbox.edit("/test.txt", "foo", "qux", true);
      expect(result.error).toBeUndefined();
      expect(result.occurrences).toBe(3);
      expect(sandbox.getFile("/test.txt")).toBe("qux bar qux baz qux");
    });

    it("should return error when file not found", async () => {
      const sandbox = new MockSandbox();

      const result = await sandbox.edit("/nonexistent.txt", "a", "b", false);
      expect(result.error).toContain("not found");
    });
  });

  describe("grepRaw", () => {
    it("should search files via grep command", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "hello world\ngoodbye world");

      const result = await sandbox.grepRaw("hello", "/");
      expect(Array.isArray(result)).toBe(true);
      if (Array.isArray(result)) {
        expect(result.length).toBe(1);
        expect(result[0].path).toBe("/test.txt");
        expect(result[0].text).toBe("hello world");
      }
      // Should use execute with grep
      expect(sandbox.executedCommands[0]).toContain("grep");
    });

    it("should return empty array for no matches", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "",
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.grepRaw("nonexistent", "/");
      expect(Array.isArray(result)).toBe(true);
      if (Array.isArray(result)) {
        expect(result.length).toBe(0);
      }
    });
  });

  describe("globInfo", () => {
    it("should find matching files via execute with find + stat", async () => {
      const sandbox = new MockSandbox();
      const now = Math.floor(Date.now() / 1000);
      sandbox.execute = vi.fn().mockResolvedValue({
        output: [
          `100\t${now}\tregular file\t/test.py`,
          `200\t${now}\tregular file\t/main.py`,
          `50\t${now}\tregular file\t/readme.md`,
        ].join("\n"),
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.globInfo("*.py", "/");
      // Only .py files should match, readme.md should be filtered out
      expect(result.length).toBe(2);
      expect(result.some((f) => f.path === "test.py")).toBe(true);
      expect(result.some((f) => f.path === "main.py")).toBe(true);
      expect(result.some((f) => f.path === "readme.md")).toBe(false);
    });

    it("should support recursive ** glob patterns", async () => {
      const sandbox = new MockSandbox();
      const now = Math.floor(Date.now() / 1000);
      sandbox.execute = vi.fn().mockResolvedValue({
        output: [
          `100\t${now}\tregular file\t/workspace/src/main.ts`,
          `200\t${now}\tregular file\t/workspace/src/utils/helper.ts`,
          `50\t${now}\tregular file\t/workspace/README.md`,
          `80\t${now}\tdirectory\t/workspace/src`,
        ].join("\n"),
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.globInfo("**/*.ts", "/workspace");
      expect(result.length).toBe(2);
      expect(result.some((f) => f.path === "src/main.ts")).toBe(true);
      expect(result.some((f) => f.path === "src/utils/helper.ts")).toBe(true);
    });

    it("should return empty array for no matches", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "",
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.globInfo("*.nonexistent", "/");
      expect(result).toEqual([]);
    });
  });

  describe("uploadFiles", () => {
    it("should upload files successfully", async () => {
      const sandbox = new MockSandbox();
      const files: Array<[string, Uint8Array]> = [
        ["/file1.txt", new TextEncoder().encode("content1")],
        ["/file2.txt", new TextEncoder().encode("content2")],
      ];

      const result = await sandbox.uploadFiles(files);
      expect(result).toHaveLength(2);
      expect(result[0].path).toBe("/file1.txt");
      expect(result[0].error).toBeNull();
      expect(result[1].path).toBe("/file2.txt");
      expect(result[1].error).toBeNull();
    });
  });

  describe("downloadFiles", () => {
    it("should download existing files", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "test content");

      const result = await sandbox.downloadFiles(["/test.txt"]);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("/test.txt");
      expect(result[0].error).toBeNull();
      expect(result[0].content).not.toBeNull();

      const content = new TextDecoder().decode(result[0].content!);
      expect(content).toBe("test content");
    });

    it("should return error for missing files", async () => {
      const sandbox = new MockSandbox();

      const result = await sandbox.downloadFiles(["/nonexistent.txt"]);
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe("/nonexistent.txt");
      expect(result[0].content).toBeNull();
      expect(result[0].error).toBe("file_not_found");
    });
  });
});
