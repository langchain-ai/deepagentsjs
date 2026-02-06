/**
 * Integration tests for VfsSandbox.
 *
 * These tests verify end-to-end functionality including:
 * - Standard sandbox tests (shared across all providers)
 * - Actual code execution (Node.js, shell scripts)
 * - File operations that persist across commands
 * - VFS to temp directory sync and back
 * - Complex workflows
 */

import { describe, it, expect, afterEach } from "vitest";
import { sandboxStandardTests } from "@langchain/standard-tests";
import { VfsSandbox, createVfsSandboxFactory } from "./sandbox.js";

const isWindows = process.platform === "win32";

sandboxStandardTests({
  name: "VfsSandbox",
  skip: isWindows,
  timeout: 30_000,
  createSandbox: async (options) => VfsSandbox.create(options),
  closeSandbox: (sandbox) => sandbox.stop(),
  resolvePath: (name) => name,
});

describe.skipIf(isWindows)("VfsSandbox Provider-Specific Tests", () => {
  let sandbox: VfsSandbox;

  afterEach(async () => {
    if (sandbox?.isRunning) {
      await sandbox.stop();
    }
  });

  describe("Node.js code execution", () => {
    it("should execute a simple Node.js script", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/hello.js": 'console.log("Hello from Node.js!");',
        },
      });

      const result = await sandbox.execute("node hello.js");

      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe("Hello from Node.js!");
    });

    it("should execute Node.js with command line arguments", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/args.js": "console.log(process.argv.slice(2).join(' '));",
        },
      });

      const result = await sandbox.execute("node args.js foo bar baz");

      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe("foo bar baz");
    });

    it("should execute Node.js with environment variables", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/env.js": 'console.log(process.env.MY_VAR || "not set");',
        },
      });

      const result = await sandbox.execute("MY_VAR=hello node env.js");

      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe("hello");
    });

    it("should handle Node.js errors gracefully", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/error.js": 'throw new Error("Test error");',
        },
      });

      const result = await sandbox.execute("node error.js");

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Error: Test error");
    });

    it("should execute ES module syntax with .mjs", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/module.mjs": `
const add = (a, b) => a + b;
console.log(add(2, 3));
          `,
        },
      });

      const result = await sandbox.execute("node module.mjs");

      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe("5");
    });
  });

  describe("Shell script execution", () => {
    it("should execute shell commands with pipes", async () => {
      sandbox = await VfsSandbox.create();

      const result = await sandbox.execute(
        "echo 'hello world' | tr 'a-z' 'A-Z'",
      );

      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe("HELLO WORLD");
    });

    it("should execute multi-line shell scripts", async () => {
      sandbox = await VfsSandbox.create();

      const result = await sandbox.execute(`
        count=0
        for i in 1 2 3 4 5; do
          count=$((count + i))
        done
        echo $count
      `);

      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe("15");
    });

    it("should handle command substitution", async () => {
      sandbox = await VfsSandbox.create();

      const result = await sandbox.execute('echo "Today is $(date +%A)"');

      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toMatch(/Today is \w+/);
    });

    it("should execute a shell script file", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/script.sh": `#!/bin/bash
echo "Script started"
for i in 1 2 3; do
  echo "Iteration $i"
done
echo "Script done"
`,
        },
      });

      const result = await sandbox.execute("bash script.sh");

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Script started");
      expect(result.output).toContain("Iteration 1");
      expect(result.output).toContain("Iteration 2");
      expect(result.output).toContain("Iteration 3");
      expect(result.output).toContain("Script done");
    });
  });

  describe("File operations during execution", () => {
    it("should create files during command execution and sync back to VFS", async () => {
      sandbox = await VfsSandbox.create();

      // Create a file via command
      const createResult = await sandbox.execute(
        'echo "Created by command" > output.txt',
      );
      expect(createResult.exitCode).toBe(0);

      // Verify file is now in VFS
      const downloaded = await sandbox.downloadFiles(["output.txt"]);
      expect(downloaded[0].error).toBeNull();
      expect(new TextDecoder().decode(downloaded[0].content!).trim()).toBe(
        "Created by command",
      );
    });

    it("should modify existing files and sync changes back", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/data.txt": "line1\nline2\nline3",
        },
      });

      // Append to file
      const result = await sandbox.execute('echo "line4" >> data.txt');
      expect(result.exitCode).toBe(0);

      // Verify modification is in VFS
      const downloaded = await sandbox.downloadFiles(["data.txt"]);
      const content = new TextDecoder().decode(downloaded[0].content!);
      expect(content).toContain("line1");
      expect(content).toContain("line4");
    });

    it("should create nested directories during execution", async () => {
      sandbox = await VfsSandbox.create();

      const result = await sandbox.execute(`
        mkdir -p deep/nested/dir
        echo "nested file" > deep/nested/dir/file.txt
      `);
      expect(result.exitCode).toBe(0);

      const downloaded = await sandbox.downloadFiles([
        "deep/nested/dir/file.txt",
      ]);
      expect(downloaded[0].error).toBeNull();
      expect(new TextDecoder().decode(downloaded[0].content!).trim()).toBe(
        "nested file",
      );
    });

    it("should handle file deletion during execution", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/to-delete.txt": "delete me",
        },
      });

      // Verify file exists
      let downloaded = await sandbox.downloadFiles(["/to-delete.txt"]);
      expect(downloaded[0].error).toBeNull();

      // Delete via command and verify it's gone in the execution context
      const result = await sandbox.execute("rm to-delete.txt && ls -la");
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("to-delete.txt");

      // Note: The current sync implementation adds/updates files but doesn't
      // propagate deletions back to VFS. This is a known limitation.
      // The file will still exist in VFS until the sandbox is stopped.
      downloaded = await sandbox.downloadFiles(["/to-delete.txt"]);
      // File still exists in VFS (deletion not synced back)
      expect(downloaded[0].error).toBeNull();
    });

    it("should handle binary files", async () => {
      sandbox = await VfsSandbox.create();

      // Create a simple binary file (PNG header)
      const pngHeader = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);

      await sandbox.uploadFiles([["image.png", pngHeader]]);

      // Verify via command
      const result = await sandbox.execute("xxd image.png | head -1");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("PNG");

      // Verify download
      const downloaded = await sandbox.downloadFiles(["image.png"]);
      expect(downloaded[0].error).toBeNull();
      expect(downloaded[0].content).toEqual(pngHeader);
    });
  });

  describe("Complex workflows", () => {
    it("should build and run a multi-file Node.js project", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/src/utils.js": `
module.exports = {
  add: (a, b) => a + b,
  multiply: (a, b) => a * b,
};
          `,
          "/src/index.js": `
const { add, multiply } = require('./utils');
console.log('Sum:', add(3, 4));
console.log('Product:', multiply(3, 4));
          `,
        },
      });

      const result = await sandbox.execute("node src/index.js");

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Sum: 7");
      expect(result.output).toContain("Product: 12");
    });

    it("should process JSON files", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/data.json": JSON.stringify({ name: "Test", count: 42 }),
          "/process.js": `
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
data.count += 8;
data.processed = true;
fs.writeFileSync('output.json', JSON.stringify(data, null, 2));
console.log('Processed successfully');
          `,
        },
      });

      const result = await sandbox.execute("node process.js");
      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe("Processed successfully");

      // Verify output file
      const downloaded = await sandbox.downloadFiles(["output.json"]);
      expect(downloaded[0].error).toBeNull();

      const output = JSON.parse(
        new TextDecoder().decode(downloaded[0].content!),
      );
      expect(output.name).toBe("Test");
      expect(output.count).toBe(50);
      expect(output.processed).toBe(true);
    });

    it("should run sequential commands that depend on each other", async () => {
      sandbox = await VfsSandbox.create();

      // Command 1: Create a file
      await sandbox.execute('echo "step1" > log.txt');

      // Command 2: Append to it
      await sandbox.execute('echo "step2" >> log.txt');

      // Command 3: Append again
      await sandbox.execute('echo "step3" >> log.txt');

      // Command 4: Read the file
      const result = await sandbox.execute("cat log.txt");

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("step1");
      expect(result.output).toContain("step2");
      expect(result.output).toContain("step3");
    });

    it("should handle large file content", async () => {
      sandbox = await VfsSandbox.create();

      // Create a large file (100KB)
      const largeContent = "x".repeat(100 * 1024);
      const encoder = new TextEncoder();

      await sandbox.uploadFiles([["large.txt", encoder.encode(largeContent)]]);

      // Verify size via command
      const result = await sandbox.execute("wc -c < large.txt");
      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe("102400");

      // Download and verify
      const downloaded = await sandbox.downloadFiles(["large.txt"]);
      expect(downloaded[0].error).toBeNull();
      expect(downloaded[0].content?.length).toBe(100 * 1024);
    });
  });

  describe("Error handling", () => {
    it("should handle command timeout", async () => {
      sandbox = await VfsSandbox.create({ timeout: 1000 });

      const result = await sandbox.execute("sleep 10");

      expect(result.output).toContain("timed out");
      expect(result.exitCode).toBeNull();
    });

    it("should handle permission errors in scripts", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/perm.js": `
const fs = require('fs');
try {
  fs.readFileSync('/etc/shadow');
} catch (e) {
  console.log('Permission error caught:', e.code);
  process.exit(0);
}
          `,
        },
      });

      const result = await sandbox.execute("node perm.js");
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Permission error caught");
    });
  });

  describe("Factory functions", () => {
    it("should create sandbox via factory", async () => {
      const factory = createVfsSandboxFactory({
        initialFiles: {
          "/factory.txt": "Created by factory",
        },
      });

      sandbox = await factory();
      expect(sandbox.isRunning).toBe(true);

      const downloaded = await sandbox.downloadFiles(["/factory.txt"]);
      expect(new TextDecoder().decode(downloaded[0].content!)).toBe(
        "Created by factory",
      );
    });

    it("should create independent sandboxes from factory", async () => {
      const factory = createVfsSandboxFactory();

      const sandbox1 = await factory();
      // Small delay to ensure different timestamps for IDs
      await new Promise((resolve) => setTimeout(resolve, 5));
      const sandbox2 = await factory();

      try {
        // Sandboxes should have different IDs (timestamps may be same if created too fast)
        // More importantly, they should be independent - files in one don't affect the other
        expect(sandbox1).not.toBe(sandbox2);

        // Create file in sandbox1
        await sandbox1.uploadFiles([
          ["test.txt", new TextEncoder().encode("sandbox1")],
        ]);

        // Should not exist in sandbox2
        const downloaded = await sandbox2.downloadFiles(["test.txt"]);
        expect(downloaded[0].error).toBe("file_not_found");
      } finally {
        await sandbox1.stop();
        await sandbox2.stop();
      }
    });
  });

  describe("VFS sync verification", () => {
    it("should sync files from VFS to temp dir before execution", async () => {
      sandbox = await VfsSandbox.create({
        initialFiles: {
          "/pre-existing.txt": "I was here before",
        },
      });

      // The file should be available during command execution
      const result = await sandbox.execute("cat pre-existing.txt");

      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe("I was here before");
    });

    it("should sync files from temp dir back to VFS after execution", async () => {
      sandbox = await VfsSandbox.create();

      // Create file during execution
      await sandbox.execute("echo 'created during exec' > new-file.txt");

      // Should be downloadable from VFS
      const downloaded = await sandbox.downloadFiles(["new-file.txt"]);
      expect(downloaded[0].error).toBeNull();
      expect(new TextDecoder().decode(downloaded[0].content!).trim()).toBe(
        "created during exec",
      );
    });

    it("should maintain file state across multiple executions", async () => {
      sandbox = await VfsSandbox.create();

      // First execution: create counter file
      await sandbox.execute("echo '0' > counter.txt");

      // Second execution: increment
      await sandbox.execute(`
        count=$(cat counter.txt)
        echo $((count + 1)) > counter.txt
      `);

      // Third execution: increment again
      await sandbox.execute(`
        count=$(cat counter.txt)
        echo $((count + 1)) > counter.txt
      `);

      // Fourth execution: read final value
      const result = await sandbox.execute("cat counter.txt");

      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe("2");
    });
  });
});
