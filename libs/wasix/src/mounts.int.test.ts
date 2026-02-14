import { describe, it, expect, afterEach } from "vitest";
import type {
  BackendProtocol,
  FileInfo,
  FileDownloadResponse,
  FileUploadResponse,
} from "deepagents";
import { WasixBackend } from "./backend.js";

/**
 * Integration tests for composable filesystem mounts.
 *
 * These tests exercise the mount system with real WASIX bash execution
 * and in-memory mock BackendProtocol implementations. They verify that
 * files are downloaded from backends before execution, visible inside
 * the sandbox, and synced back after execution.
 *
 * Requires @wasmer/sdk; skipped automatically if SDK fails to initialize.
 */

/**
 * Minimal in-memory BackendProtocol for integration testing.
 */
class MockBackend implements BackendProtocol {
  readonly files = new Map<string, Uint8Array>();

  seed(path: string, content: string | Uint8Array): void {
    const data =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.files.set(path.startsWith("/") ? path : `/${path}`, data);
  }

  readString(path: string): string | undefined {
    const data = this.files.get(path.startsWith("/") ? path : `/${path}`);
    return data ? new TextDecoder().decode(data) : undefined;
  }

  globInfo(pattern: string, _path?: string): FileInfo[] {
    const results: FileInfo[] = [];
    for (const [filePath] of this.files) {
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

// Probe whether the SDK can initialize before running any tests.
let sdkAvailable = true;
try {
  const probe = await WasixBackend.create();
  await probe.execute("echo probe");
  probe.close();
} catch {
  sdkAvailable = false;
}

const describeIfSdk = sdkAvailable ? describe : describe.skip;

describeIfSdk("Composable mounts integration", { timeout: 120_000 }, () => {
  let backend: WasixBackend | undefined;

  afterEach(() => {
    backend?.close();
    backend = undefined;
  });

  it("reads files from a single mounted backend", async () => {
    const mock = new MockBackend();
    mock.seed("/file.txt", "hello from mount");

    backend = await WasixBackend.create({
      mounts: { "/data": mock },
    });

    const result = await backend.execute("cat /data/file.txt");
    expect(result.output).toContain("hello from mount");
  }, 30_000);

  it("writes files back to the mounted backend", async () => {
    const mock = new MockBackend();

    backend = await WasixBackend.create({
      mounts: { "/data": mock },
    });

    await backend.execute("echo hello > /data/out.txt");

    const content = mock.readString("/out.txt");
    expect(content).toBeDefined();
    expect(content!.trim()).toBe("hello");
  }, 30_000);

  it("reads files from multiple mounts simultaneously", async () => {
    const dataBackend = new MockBackend();
    const configBackend = new MockBackend();
    dataBackend.seed("/input.txt", "data content");
    configBackend.seed("/settings.json", '{"key":"value"}');

    backend = await WasixBackend.create({
      mounts: { "/data": dataBackend, "/config": configBackend },
    });

    const result = await backend.execute(
      "cat /data/input.txt && cat /config/settings.json",
    );
    expect(result.output).toContain("data content");
    expect(result.output).toContain('{"key":"value"}');
  }, 30_000);

  it("copies a file across mounts", async () => {
    const dataBackend = new MockBackend();
    const configBackend = new MockBackend();
    dataBackend.seed("/input.txt", "cross mount content");

    backend = await WasixBackend.create({
      mounts: { "/data": dataBackend, "/config": configBackend },
    });

    await backend.execute("cp /data/input.txt /config/output.txt");

    const content = configBackend.readString("/output.txt");
    expect(content).toBeDefined();
    expect(content).toContain("cross mount content");
  }, 30_000);

  it("preserves existing files and adds new ones after execution", async () => {
    const mock = new MockBackend();
    mock.seed("/existing.txt", "original content");

    backend = await WasixBackend.create({
      mounts: { "/data": mock },
    });

    await backend.execute("echo new content > /data/new.txt");

    // Existing file should still be in the backend (unchanged, so not re-uploaded,
    // but original content remains)
    const existing = mock.readString("/existing.txt");
    expect(existing).toBe("original content");

    // New file should have been uploaded
    const newFile = mock.readString("/new.txt");
    expect(newFile).toBeDefined();
    expect(newFile!.trim()).toBe("new content");
  }, 30_000);

  it("works without mounts (backward compatibility)", async () => {
    backend = await WasixBackend.create();

    const content = new TextEncoder().encode("compat test");
    await backend.uploadFiles([["/test.txt", content]]);

    const result = await backend.execute("cat /work/test.txt");
    expect(result.output).toContain("compat test");
  }, 30_000);

  it("syncs files after an interactive shell session", async () => {
    const mock = new MockBackend();
    mock.seed("/before.txt", "pre-existing");

    backend = await WasixBackend.create({
      mounts: { "/data": mock },
    });

    const session = await backend.shell();

    // Write a new file via the interactive shell
    await session.writeLine("echo shell-output > /data/after.txt");
    // Give bash a moment to process the command, then exit
    await session.writeLine("exit");
    await session.wait();

    // The new file should have been synced back to the mock backend
    const afterContent = mock.readString("/after.txt");
    expect(afterContent).toBeDefined();
    expect(afterContent!.trim()).toBe("shell-output");

    // Pre-existing file should remain in the backend
    const beforeContent = mock.readString("/before.txt");
    expect(beforeContent).toBe("pre-existing");
  }, 30_000);
});
