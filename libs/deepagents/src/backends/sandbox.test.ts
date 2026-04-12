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

  // Store for simulating file operations (stores raw bytes)
  private files: Map<string, Uint8Array> = new Map();

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
        const bytes = this.files.get(filePath);
        if (!bytes) {
          return {
            output: "Error: File not found",
            exitCode: 1,
            truncated: false,
          };
        }
        const content = new TextDecoder().decode(bytes);
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
        for (const [filePath, bytes] of this.files) {
          const content = new TextDecoder().decode(bytes);
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
        this.files.set(path, content);
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
        responses.push({ path, content, error: null });
      }
    }
    return responses;
  }

  // Helper to add text files for testing
  addFile(path: string, content: string) {
    this.files.set(path, new TextEncoder().encode(content));
  }

  // Helper to add binary files for testing
  addBinaryFile(path: string, content: Uint8Array) {
    this.files.set(path, content);
  }

  // Helper to get file content as string
  getFile(path: string): string | undefined {
    const bytes = this.files.get(path);
    if (!bytes) return undefined;
    return new TextDecoder().decode(bytes);
  }

  // Helper to get file content as bytes
  getBinaryFile(path: string): Uint8Array | undefined {
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

      const runtime = { state: { files: {} }, store: undefined };
      const stateBackend = new StateBackend(runtime);
      expect(isSandboxBackend(stateBackend)).toBe(false);
    });
  });

  describe("ls", () => {
    it("should list files via execute using find + stat", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "content");
      sandbox.addFile("/dir/nested.txt", "nested");

      await sandbox.ls("/");
      expect(sandbox.executedCommands.length).toBeGreaterThan(0);
      expect(sandbox.executedCommands[0]).toContain("find");
      expect(sandbox.executedCommands[0]).toContain("stat");
      expect(sandbox.executedCommands[0]).toContain("-maxdepth 1");
    });

    it("should include -L flag to follow symlinks", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "content");

      await sandbox.ls("/");
      expect(sandbox.executedCommands[0]).toMatch(/find\s+-L\s+/);
    });

    it("should return empty array for non-existent directory", async () => {
      const sandbox = new MockSandbox();
      // Mock execute to return error
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "Error",
        exitCode: 1,
        truncated: false,
      });

      const result = await sandbox.ls("/nonexistent");
      expect(result.error).toBeUndefined();
      expect(result.files).toEqual([]);
    });
  });

  describe("read", () => {
    it("should read file via execute with awk", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "line1\nline2\nline3");

      const result = await sandbox.read("/test.txt");
      expect(result.error).toBeUndefined();
      expect(result.content).toContain("line1");
      expect(result.content).toContain("line2");
    });

    it("should return error for non-existent file", async () => {
      const sandbox = new MockSandbox();

      const result = await sandbox.read("/nonexistent.txt");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("not found");
    });

    it("should use execute (not downloadFiles) for text files", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "content");

      await sandbox.read("/test.txt");
      // text files should go through execute with awk
      expect(sandbox.executedCommands.length).toBe(1);
      expect(sandbox.executedCommands[0]).toContain("awk");
    });

    describe("binary files", () => {
      it("should return Uint8Array content for image files", async () => {
        const sandbox = new MockSandbox();
        const binaryContent = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        sandbox.addBinaryFile("/image.png", binaryContent);

        const result = await sandbox.read("/image.png");
        expect(result.error).toBeUndefined();
        expect(result.content).toBeInstanceOf(Uint8Array);
        expect(result.content).toEqual(binaryContent);
      });

      it("should use downloadFiles for binary files, not execute", async () => {
        const sandbox = new MockSandbox();
        sandbox.addBinaryFile("/image.png", new Uint8Array([1, 2, 3]));

        await sandbox.read("/image.png");
        // binary files should NOT use awk command
        expect(sandbox.executedCommands.length).toBe(0);
      });

      it("should return error for non-existent binary file", async () => {
        const sandbox = new MockSandbox();

        const result = await sandbox.read("/nonexistent.png");
        expect(result.error).toBeDefined();
        expect(result.error).toContain("not found");
      });
    });
  });

  describe("readRaw", () => {
    it("should read text file via downloadFiles and return v2 format", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "line1\nline2\nline3");

      const result = await sandbox.readRaw("/test.txt");
      expect(result.error).toBeUndefined();
      // v2 format: content is a string, not an array
      expect(result.data!.content).toBe("line1\nline2\nline3");
      expect(typeof result.data!.content).toBe("string");
      // Should NOT go through execute
      expect(sandbox.executedCommands.length).toBe(0);
    });

    it("should return error for non-existent file", async () => {
      const sandbox = new MockSandbox();

      const result = await sandbox.readRaw("/nonexistent.txt");
      expect(result.error).toBeDefined();
      expect(result.error).toContain("not found");
    });

    describe("binary files", () => {
      it("should return Uint8Array content for binary files", async () => {
        const sandbox = new MockSandbox();
        const binaryContent = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        sandbox.addBinaryFile("/image.png", binaryContent);

        const result = await sandbox.readRaw("/image.png");
        expect(result.error).toBeUndefined();
        expect(result.data!.content).toBeInstanceOf(Uint8Array);
        expect(result.data!.content).toEqual(binaryContent);
      });
    });
  });

  describe("write", () => {
    it("should write text file via uploadFiles", async () => {
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

    describe("binary files", () => {
      it("should decode base64 and write binary content", async () => {
        const sandbox = new MockSandbox();
        const binaryContent = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        const base64Content = Buffer.from(binaryContent).toString("base64");

        const result = await sandbox.write("/image.png", base64Content);
        expect(result.error).toBeUndefined();
        expect(result.path).toBe("/image.png");

        // Verify binary was written correctly
        const written = sandbox.getBinaryFile("/image.png");
        expect(Buffer.from(written!).toString("base64")).toBe(base64Content);
      });
    });
  });

  describe("edit", () => {
    it("should return error when file not found", async () => {
      const sandbox = new MockSandbox();
      const result = await sandbox.edit("/nonexistent.txt", "a", "b", false);
      expect(result.error).toContain("not found");
      expect(result.path).toBeUndefined();
    });

    describe("empty oldString (editing empty files)", () => {
      it("should write content to an empty file", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/empty.txt", "");

        const result = await sandbox.edit("/empty.txt", "", "hello", false);
        expect(result.error).toBeUndefined();
        expect(result.path).toBe("/empty.txt");
        expect(result.occurrences).toBe(1);
        expect(sandbox.getFile("/empty.txt")).toBe("hello");
      });

      it("should write multi-line content to an empty file", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/empty.txt", "");

        const result = await sandbox.edit(
          "/empty.txt",
          "",
          "line1\nline2\nline3",
          false,
        );
        expect(result.error).toBeUndefined();
        expect(sandbox.getFile("/empty.txt")).toBe("line1\nline2\nline3");
      });

      it("should no-op when both oldString and newString are empty", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/empty.txt", "");

        const result = await sandbox.edit("/empty.txt", "", "", false);
        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(0);
        expect(sandbox.getFile("/empty.txt")).toBe("");
      });

      it("should reject empty oldString when file has content", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "existing content");

        const result = await sandbox.edit("/test.txt", "", "new", false);
        expect(result.error).toBe(
          "oldString must not be empty unless the file is empty",
        );
      });
    });

    describe("single replacement (replaceAll=false)", () => {
      it("should replace a unique occurrence", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "Hello World");

        const result = await sandbox.edit(
          "/test.txt",
          "World",
          "Universe",
          false,
        );
        expect(result.error).toBeUndefined();
        expect(result.path).toBe("/test.txt");
        expect(result.occurrences).toBe(1);
        expect(result.filesUpdate).toBeNull();
        expect(sandbox.getFile("/test.txt")).toBe("Hello Universe");
      });

      it("should not use execute (goes through download/upload)", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "Hello World");

        await sandbox.edit("/test.txt", "World", "Universe", false);
        expect(sandbox.executedCommands.length).toBe(0);
      });

      it("should replace at the start of the file", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "Hello World");

        const result = await sandbox.edit(
          "/test.txt",
          "Hello",
          "Goodbye",
          false,
        );
        expect(result.error).toBeUndefined();
        expect(sandbox.getFile("/test.txt")).toBe("Goodbye World");
      });

      it("should replace at the end of the file", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "Hello World");

        const result = await sandbox.edit("/test.txt", "World", "Earth", false);
        expect(result.error).toBeUndefined();
        expect(sandbox.getFile("/test.txt")).toBe("Hello Earth");
      });

      it("should replace the entire file content", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "old content");

        const result = await sandbox.edit(
          "/test.txt",
          "old content",
          "new content",
          false,
        );
        expect(result.error).toBeUndefined();
        expect(sandbox.getFile("/test.txt")).toBe("new content");
      });

      it("should handle multi-line replacements", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "line1\nline2\nline3");

        const result = await sandbox.edit(
          "/test.txt",
          "line1\nline2",
          "replaced",
          false,
        );
        expect(result.error).toBeUndefined();
        expect(sandbox.getFile("/test.txt")).toBe("replaced\nline3");
      });

      it("should replace with a longer string", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "ab");

        const result = await sandbox.edit("/test.txt", "ab", "abcdef", false);
        expect(result.error).toBeUndefined();
        expect(sandbox.getFile("/test.txt")).toBe("abcdef");
      });

      it("should replace with a shorter string", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "abcdef");

        const result = await sandbox.edit("/test.txt", "abcdef", "ab", false);
        expect(result.error).toBeUndefined();
        expect(sandbox.getFile("/test.txt")).toBe("ab");
      });

      it("should delete content when newString is empty", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "keep delete keep");

        const result = await sandbox.edit("/test.txt", " delete", "", false);
        expect(result.error).toBeUndefined();
        expect(sandbox.getFile("/test.txt")).toBe("keep keep");
      });

      it("should return error when oldString not found", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "Hello World");

        const result = await sandbox.edit(
          "/test.txt",
          "notfound",
          "new",
          false,
        );
        expect(result.error).toContain("String not found");
        expect(result.error).toContain("/test.txt");
      });

      it("should return error for multiple occurrences", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "foo bar foo baz foo");

        const result = await sandbox.edit("/test.txt", "foo", "qux", false);
        expect(result.error).toContain("Multiple occurrences");
        expect(result.error).toContain("replaceAll");
      });

      it("should no-op when oldString equals newString", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "Hello World");

        const result = await sandbox.edit("/test.txt", "World", "World", false);
        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(1);
        expect(sandbox.getFile("/test.txt")).toBe("Hello World");
      });
    });

    describe("replaceAll=true", () => {
      it("should replace all occurrences", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "foo bar foo baz foo");

        const result = await sandbox.edit("/test.txt", "foo", "qux", true);
        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(3);
        expect(sandbox.getFile("/test.txt")).toBe("qux bar qux baz qux");
      });

      it("should work with a single occurrence", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "foo bar baz");

        const result = await sandbox.edit("/test.txt", "bar", "qux", true);
        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(1);
        expect(sandbox.getFile("/test.txt")).toBe("foo qux baz");
      });

      it("should count correctly with different-length replacements", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "aa bb aa cc aa");

        const result = await sandbox.edit("/test.txt", "aa", "xyz", true);
        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(3);
        expect(sandbox.getFile("/test.txt")).toBe("xyz bb xyz cc xyz");
      });

      it("should count correctly with same-length replacements", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "ab cd ab ef ab");

        const result = await sandbox.edit("/test.txt", "ab", "zz", true);
        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(3);
        expect(sandbox.getFile("/test.txt")).toBe("zz cd zz ef zz");
      });

      it("should delete all occurrences when newString is empty", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "keep remove keep remove keep");

        const result = await sandbox.edit("/test.txt", " remove", "", true);
        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(2);
        expect(sandbox.getFile("/test.txt")).toBe("keep keep keep");
      });

      it("should handle adjacent occurrences", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "aaaa");

        const result = await sandbox.edit("/test.txt", "aa", "b", true);
        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(2);
        expect(sandbox.getFile("/test.txt")).toBe("bb");
      });

      it("should no-op when oldString equals newString", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "foo bar foo");

        const result = await sandbox.edit("/test.txt", "foo", "foo", true);
        expect(result.error).toBeUndefined();
        expect(result.occurrences).toBe(1);
        expect(sandbox.getFile("/test.txt")).toBe("foo bar foo");
      });

      it("should return error when oldString not found", async () => {
        const sandbox = new MockSandbox();
        sandbox.addFile("/test.txt", "Hello World");

        const result = await sandbox.edit("/test.txt", "notfound", "new", true);
        expect(result.error).toContain("String not found");
      });
    });
  });

  describe("grep", () => {
    it("should search files via grep command and return GrepResult", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "hello world\ngoodbye world");

      const result = await sandbox.grep("hello", "/");
      expect(result.error).toBeUndefined();
      expect(result.matches).toBeDefined();
      expect(result.matches!.length).toBe(1);
      expect(result.matches![0].path).toBe("/test.txt");
      expect(result.matches![0].text).toBe("hello world");
      // Should use execute with grep
      expect(sandbox.executedCommands[0]).toContain("grep");
    });

    it("should return empty matches array for no matches", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "",
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.grep("nonexistent", "/");
      expect(result.error).toBeUndefined();
      expect(result.matches).toBeDefined();
      expect(result.matches!.length).toBe(0);
    });

    it("should include -L flag to follow symlinks when glob pattern is provided", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.txt", "hello world");

      await sandbox.grep("hello", "/", "*.txt");
      expect(sandbox.executedCommands[0]).toMatch(/find\s+-L\s+/);
    });

    it("should skip binary files in grep results", async () => {
      const sandbox = new MockSandbox();
      // Mock grep returning matches from both text and binary files
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "/test.txt:1:hello world\n/image.png:1:hello binary",
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.grep("hello", "/");
      expect(result.matches!.length).toBe(1);
      expect(result.matches![0].path).toBe("/test.txt");
      // image.png should be filtered out based on extension
    });
  });

  describe("glob", () => {
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

      const result = await sandbox.glob("*.py", "/");
      expect(result.error).toBeUndefined();
      // Only .py files should match, readme.md should be filtered out
      expect(result.files!.length).toBe(2);
      expect(result.files!.some((f) => f.path === "test.py")).toBe(true);
      expect(result.files!.some((f) => f.path === "main.py")).toBe(true);
      expect(result.files!.some((f) => f.path === "readme.md")).toBe(false);
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

      const result = await sandbox.glob("**/*.ts", "/workspace");
      expect(result.error).toBeUndefined();
      expect(result.files!.length).toBe(2);
      expect(result.files!.some((f) => f.path === "src/main.ts")).toBe(true);
      expect(result.files!.some((f) => f.path === "src/utils/helper.ts")).toBe(
        true,
      );
    });

    it("should include -L flag to follow symlinks", async () => {
      const sandbox = new MockSandbox();
      sandbox.addFile("/test.py", "print('hello')");

      await sandbox.glob("*.py", "/");
      expect(sandbox.executedCommands[0]).toMatch(/find\s+-L\s+/);
    });

    it("should return empty array for no matches", async () => {
      const sandbox = new MockSandbox();
      sandbox.execute = vi.fn().mockResolvedValue({
        output: "",
        exitCode: 0,
        truncated: false,
      });

      const result = await sandbox.glob("*.nonexistent", "/");
      expect(result.error).toBeUndefined();
      expect(result.files).toEqual([]);
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
