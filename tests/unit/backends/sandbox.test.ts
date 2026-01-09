import { describe, it, expect, vi } from "vitest";
import { BaseSandbox } from "../../../src/backends/sandbox.js";
import type {
  ExecuteResponse,
  FileDownloadResponse,
  FileUploadResponse,
} from "../../../src/backends/protocol.js";

/**
 * Mock implementation of BaseSandbox for testing.
 * Simulates command execution by parsing the command and returning appropriate responses.
 */
class MockSandbox extends BaseSandbox {
  readonly id = "mock-sandbox-1";
  
  // Store for simulating file operations
  private files: Map<string, string> = new Map();
  
  // Track executed commands for assertions
  public executedCommands: string[] = [];

  async execute(command: string): Promise<ExecuteResponse> {
    this.executedCommands.push(command);

    // Simulate ls command
    if (command.includes("fs.readdirSync")) {
      const files = Array.from(this.files.keys());
      const output = files.map(f => JSON.stringify({
        path: f,
        size: this.files.get(f)!.length,
        mtime: Date.now(),
        isDir: false,
      })).join("\n");
      return { output, exitCode: 0, truncated: false };
    }

    // Simulate read command
    if (command.includes("fs.readFileSync") && command.includes("split('\\\\n')")) {
      const pathMatch = command.match(/atob\('([^']+)'\)/);
      if (pathMatch) {
        const filePath = atob(pathMatch[1]);
        const content = this.files.get(filePath);
        if (!content) {
          return { output: "Error: File not found", exitCode: 1, truncated: false };
        }
        const lines = content.split("\n");
        const output = lines.map((line, i) => `     ${i + 1}\t${line}`).join("\n");
        return { output, exitCode: 0, truncated: false };
      }
    }

    // Simulate write command
    if (command.includes("fs.writeFileSync") && command.includes("fs.existsSync")) {
      const matches = command.match(/atob\('([^']+)'\)/g);
      if (matches && matches.length >= 2) {
        const filePath = atob(matches[0].match(/atob\('([^']+)'\)/)![1]);
        const content = atob(matches[1].match(/atob\('([^']+)'\)/)![1]);
        
        if (this.files.has(filePath)) {
          return { output: "Error: File already exists", exitCode: 1, truncated: false };
        }
        
        this.files.set(filePath, content);
        return { output: "OK", exitCode: 0, truncated: false };
      }
    }

    // Simulate edit command
    if (command.includes("fs.writeFileSync") && command.includes("replaceAll")) {
      const matches = command.match(/atob\('([^']+)'\)/g);
      if (matches && matches.length >= 3) {
        const filePath = atob(matches[0].match(/atob\('([^']+)'\)/)![1]);
        const oldStr = atob(matches[1].match(/atob\('([^']+)'\)/)![1]);
        const newStr = atob(matches[2].match(/atob\('([^']+)'\)/)![1]);
        
        const content = this.files.get(filePath);
        if (!content) {
          return { output: "", exitCode: 3, truncated: false };
        }
        
        const count = content.split(oldStr).length - 1;
        if (count === 0) {
          return { output: "", exitCode: 1, truncated: false };
        }
        
        const replaceAll = command.includes("replaceAll = true");
        if (count > 1 && !replaceAll) {
          return { output: "", exitCode: 2, truncated: false };
        }
        
        const newContent = content.split(oldStr).join(newStr);
        this.files.set(filePath, newContent);
        return { output: String(count), exitCode: 0, truncated: false };
      }
    }

    // Simulate glob command
    if (command.includes("globMatch") && command.includes("walkDir")) {
      const matches = command.match(/atob\('([^']+)'\)/g);
      if (matches && matches.length >= 2) {
        const pattern = atob(matches[1].match(/atob\('([^']+)'\)/)![1]);
        const regex = new RegExp(pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*"));
        
        const matchingFiles = Array.from(this.files.keys()).filter(f => regex.test(f));
        const output = matchingFiles.map(f => JSON.stringify({
          path: f,
          size: this.files.get(f)!.length,
          mtime: Date.now(),
          isDir: false,
        })).join("\n");
        return { output, exitCode: 0, truncated: false };
      }
    }

    // Simulate grep command
    if (command.includes("new RegExp(pattern)") && command.includes("walkDir")) {
      const matches = command.match(/atob\('([^']+)'\)/g);
      if (matches) {
        const pattern = atob(matches[0].match(/atob\('([^']+)'\)/)![1]);
        const regex = new RegExp(pattern);
        
        const results: string[] = [];
        for (const [filePath, content] of this.files) {
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push(JSON.stringify({
                path: filePath,
                line: i + 1,
                text: lines[i],
              }));
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
      if (!content) {
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
      const { isSandboxBackend } = await import("../../../src/backends/protocol.js");
      const sandbox = new MockSandbox();
      expect(isSandboxBackend(sandbox)).toBe(true);
    });

    it("should return false for non-sandbox backends", async () => {
      const { isSandboxBackend } = await import("../../../src/backends/protocol.js");
      const { StateBackend } = await import("../../../src/backends/state.js");
      
      const stateAndStore = { state: { files: {} }, store: undefined };
      const stateBackend = new StateBackend(stateAndStore);
      expect(isSandboxBackend(stateBackend)).toBe(false);
    });
  });

  describe("lsInfo", () => {
    it("should list files via execute", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "content");
      sandbox.addFile("/dir/nested.txt", "nested");

      const result = await sandbox.lsInfo("/");
      expect(sandbox.executedCommands.length).toBeGreaterThan(0);
      expect(sandbox.executedCommands[0]).toContain("node -e");
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
    it("should read file via execute", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "line1\nline2\nline3");

      // Override execute for this test
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "     1\tline1\n     2\tline2\n     3\tline3",
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.read("/test.txt");
      expect(result).toContain("line1");
      expect(result).toContain("line2");
    });

    it("should return error for non-existent file", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "",
        exitCode: 1,
        truncated: false,
      });

      const result = await sandbox.read("/nonexistent.txt");
      expect(result).toContain("Error");
      expect(result).toContain("not found");
    });
  });

  describe("write", () => {
    it("should write file via execute", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "OK",
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.write("/new.txt", "new content");
      expect(result.error).toBeUndefined();
      expect(result.path).toBe("/new.txt");
      expect(result.filesUpdate).toBeNull(); // External storage
    });

    it("should return error if file already exists", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "Error: File already exists",
        exitCode: 1,
        truncated: false,
      });

      const result = await sandbox.write("/existing.txt", "content");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("already exists");
    });
  });

  describe("edit", () => {
    it("should edit file via execute", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "1",
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.edit("/test.txt", "old", "new", false);
      expect(result.error).toBeUndefined();
      expect(result.occurrences).toBe(1);
      expect(result.filesUpdate).toBeNull();
    });

    it("should return error when string not found", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "",
        exitCode: 1,
        truncated: false,
      });

      const result = await sandbox.edit("/test.txt", "notfound", "new", false);
      expect(result.error).toContain("not found");
    });

    it("should return error for multiple occurrences without replaceAll", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "",
        exitCode: 2,
        truncated: false,
      });

      const result = await sandbox.edit("/test.txt", "multi", "new", false);
      expect(result.error).toContain("Multiple occurrences");
      expect(result.error).toContain("replaceAll");
    });

    it("should return error when file not found", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "",
        exitCode: 3,
        truncated: false,
      });

      const result = await sandbox.edit("/nonexistent.txt", "a", "b", false);
      expect(result.error).toContain("not found");
    });
  });

  describe("grepRaw", () => {
    it("should search files via execute", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: JSON.stringify({ path: "/test.txt", line: 1, text: "hello world" }),
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.grepRaw("hello", "/");
      expect(Array.isArray(result)).toBe(true);
      if (Array.isArray(result)) {
        expect(result.length).toBe(1);
        expect(result[0].path).toBe("/test.txt");
        expect(result[0].text).toBe("hello world");
      }
    });

    it("should return error string for invalid regex", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "Invalid regex: [",
        exitCode: 1,
        truncated: false,
      });

      const result = await sandbox.grepRaw("[", "/");
      expect(typeof result).toBe("string");
      expect(result).toContain("Invalid regex");
    });
  });

  describe("globInfo", () => {
    it("should find matching files via execute", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: [
          JSON.stringify({ path: "test.py", size: 100, mtime: Date.now(), isDir: false }),
          JSON.stringify({ path: "main.py", size: 200, mtime: Date.now(), isDir: false }),
        ].join("\n"),
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.globInfo("*.py", "/");
      expect(result.length).toBe(2);
      expect(result.some(f => f.path === "test.py")).toBe(true);
      expect(result.some(f => f.path === "main.py")).toBe(true);
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

  describe("readRaw", () => {
    it("should parse read output to FileData", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "     1\tline1\n     2\tline2\n     3\tline3",
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.readRaw("/test.txt");
      expect(result.content).toEqual(["line1", "line2", "line3"]);
      expect(result.created_at).toBeDefined();
      expect(result.modified_at).toBeDefined();
    });

    it("should throw for non-existent files", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "",
        exitCode: 1,
        truncated: false,
      });

      await expect(sandbox.readRaw("/nonexistent.txt")).rejects.toThrow("not found");
    });
  });
});

