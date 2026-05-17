/**
 * Unit tests for WasmshFilesystemBackend.
 *
 * Uses a recording sandbox stub to verify namespace prefix/unscope semantics
 * on every protocol method without booting Pyodide.
 */
import { describe, it, expect } from "vitest";
import { WasmshFilesystemBackend } from "./filesystem-backend.js";
import type { WasmshSandbox } from "./sandbox.js";

interface Call {
  method: string;
  args: unknown[];
}

class RecordingSandbox {
  id = "wasmsh-fs-test";
  calls: Call[] = [];

  // Result shapes are constructed per-test to make assertions explicit.
  nextLs: { files?: Array<{ path: string }>; error?: string } = { files: [] };
  nextGlob: { files?: Array<{ path: string }>; error?: string } = { files: [] };
  nextGrep: {
    matches?: Array<{ path: string; line: number; text: string }>;
    error?: string;
  } = { matches: [] };
  nextRead: unknown = { content: "", encoding: "utf-8" };
  nextReadRaw: unknown = { content: new Uint8Array(0) };
  nextWrite: unknown = { path: "" };
  nextEdit: unknown = { path: "" };
  nextUpload: Array<{ path: string; error: null | string }> = [];
  nextDownload: Array<{
    path: string;
    content: Uint8Array | null;
    error: null | string;
  }> = [];

  async ls(path: string) {
    this.calls.push({ method: "ls", args: [path] });
    return this.nextLs;
  }
  async read(filePath: string, offset?: number, limit?: number) {
    this.calls.push({ method: "read", args: [filePath, offset, limit] });
    return this.nextRead;
  }
  async readRaw(filePath: string) {
    this.calls.push({ method: "readRaw", args: [filePath] });
    return this.nextReadRaw;
  }
  async grep(pattern: string, path?: string | null, glob?: string | null) {
    this.calls.push({ method: "grep", args: [pattern, path, glob] });
    return this.nextGrep;
  }
  async glob(pattern: string, path?: string) {
    this.calls.push({ method: "glob", args: [pattern, path] });
    return this.nextGlob;
  }
  async write(filePath: string, content: string) {
    this.calls.push({ method: "write", args: [filePath, content] });
    return this.nextWrite;
  }
  async edit(
    filePath: string,
    oldStr: string,
    newStr: string,
    replaceAll?: boolean,
  ) {
    this.calls.push({
      method: "edit",
      args: [filePath, oldStr, newStr, replaceAll],
    });
    return this.nextEdit;
  }
  async uploadFiles(files: Array<[string, Uint8Array]>) {
    this.calls.push({ method: "uploadFiles", args: [files.map(([p]) => p)] });
    return this.nextUpload.length
      ? this.nextUpload
      : files.map(([p]) => ({ path: p, error: null }));
  }
  async downloadFiles(paths: string[]) {
    this.calls.push({ method: "downloadFiles", args: [paths] });
    return this.nextDownload.length
      ? this.nextDownload
      : paths.map((p) => ({
          path: p,
          content: new Uint8Array(0),
          error: null,
        }));
  }
}

function makeBackend(namespace?: string) {
  const sandbox = new RecordingSandbox();
  const backend = new WasmshFilesystemBackend(
    sandbox as unknown as WasmshSandbox,
    namespace ? { namespace } : {},
  );
  return { sandbox, backend };
}

describe("WasmshFilesystemBackend with no namespace", () => {
  it("passes paths through unchanged", async () => {
    const { sandbox, backend } = makeBackend();
    await backend.ls("/notes");
    expect(sandbox.calls[0]).toEqual({ method: "ls", args: ["/notes"] });
  });

  it("does not rewrite ls result paths", async () => {
    const { sandbox, backend } = makeBackend();
    sandbox.nextLs = { files: [{ path: "/a.txt" }, { path: "/b.txt" }] };
    const r = await backend.ls("/");
    expect(r.files?.map((f) => f.path)).toEqual(["/a.txt", "/b.txt"]);
  });
});

describe("WasmshFilesystemBackend with namespace prefix", () => {
  it("rewrites every method's input path", async () => {
    const { sandbox, backend } = makeBackend("/mem");
    await backend.ls("/notes");
    await backend.read("/x.txt", 0, 100);
    await backend.readRaw("/x.txt");
    await backend.glob("*.md", "/");
    await backend.write("/draft.md", "hi");
    await backend.edit("/draft.md", "a", "b", true);
    await backend.grep("TODO", "/work", "*.md");
    await backend.uploadFiles([["/upload.bin", new Uint8Array([1])]]);
    await backend.downloadFiles(["/dl.bin"]);

    const paths = sandbox.calls.map(
      (c) => `${c.method}:${JSON.stringify(c.args[0])}`,
    );
    expect(paths).toEqual([
      'ls:"/mem/notes"',
      'read:"/mem/x.txt"',
      'readRaw:"/mem/x.txt"',
      'glob:"*.md"',
      'write:"/mem/draft.md"',
      'edit:"/mem/draft.md"',
      'grep:"TODO"',
      'uploadFiles:["/mem/upload.bin"]',
      'downloadFiles:["/mem/dl.bin"]',
    ]);

    // For glob, the namespace shows up in arg[1] (path), not arg[0] (pattern).
    // `/` scopes to the bare namespace root (no trailing slash).
    const globCall = sandbox.calls.find((c) => c.method === "glob");
    expect(globCall?.args[1]).toBe("/mem");
    // Same shape for grep: pattern then path.
    const grepCall = sandbox.calls.find((c) => c.method === "grep");
    expect(grepCall?.args[1]).toBe("/mem/work");
  });

  it("normalises trailing slashes in the namespace", () => {
    const { sandbox, backend } = makeBackend("/mem///");
    return backend.ls("/notes").then(() => {
      expect(sandbox.calls[0].args[0]).toBe("/mem/notes");
    });
  });

  it("normalises a namespace without a leading slash", () => {
    const { sandbox, backend } = makeBackend("mem");
    return backend.ls("/notes").then(() => {
      expect(sandbox.calls[0].args[0]).toBe("/mem/notes");
    });
  });

  it("scopes / to the namespace root", () => {
    const { sandbox, backend } = makeBackend("/mem");
    return backend.ls("/").then(() => {
      expect(sandbox.calls[0].args[0]).toBe("/mem");
    });
  });

  it("unscopes ls result paths back to the caller's namespace", async () => {
    const { sandbox, backend } = makeBackend("/mem");
    sandbox.nextLs = {
      files: [{ path: "/mem/a.txt" }, { path: "/mem/sub/b.txt" }],
    };
    const r = await backend.ls("/");
    expect(r.files?.map((f) => f.path)).toEqual(["/a.txt", "/sub/b.txt"]);
  });

  it("unscopes glob result paths", async () => {
    const { sandbox, backend } = makeBackend("/mem");
    sandbox.nextGlob = { files: [{ path: "/mem/x.py" }] };
    const r = await backend.glob("*.py");
    expect(r.files?.map((f) => f.path)).toEqual(["/x.py"]);
  });

  it("unscopes grep match paths", async () => {
    const { sandbox, backend } = makeBackend("/mem");
    sandbox.nextGrep = {
      matches: [{ path: "/mem/work/a.md", line: 1, text: "TODO: x" }],
    };
    const r = await backend.grep("TODO", "/work");
    expect(r.matches?.[0].path).toBe("/work/a.md");
  });

  it("unscopes upload + download response paths", async () => {
    const { sandbox, backend } = makeBackend("/mem");
    sandbox.nextUpload = [{ path: "/mem/x.bin", error: null }];
    sandbox.nextDownload = [
      { path: "/mem/y.bin", content: new Uint8Array([1, 2, 3]), error: null },
    ];
    const ur = await backend.uploadFiles([["/x.bin", new Uint8Array([1])]]);
    const dr = await backend.downloadFiles(["/y.bin"]);
    expect(ur[0].path).toBe("/x.bin");
    expect(dr[0].path).toBe("/y.bin");
    expect(dr[0].content).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("passes through results carrying errors without rewriting paths", async () => {
    const { backend, sandbox } = makeBackend("/mem");
    sandbox.nextLs = { error: "permission_denied" };
    const r = await backend.ls("/notes");
    expect(r.error).toBe("permission_denied");
    expect(r.files).toBeUndefined();
  });

  it("includes the namespace in id", () => {
    const { backend } = makeBackend("/mem");
    expect(backend.id).toBe("wasmsh-fs:wasmsh-fs-test/mem");
  });
});
