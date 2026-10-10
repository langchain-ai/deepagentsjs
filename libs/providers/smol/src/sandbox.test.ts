import { beforeEach, describe, expect, it, vi } from "vitest";
import { SmolSandbox, createSmolSandboxFactoryFromSandbox } from "./sandbox.js";

const mock = vi.hoisted(() => ({
  create: vi.fn(),
  exec: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("smolmachines", () => ({ Machine: { create: mock.create } }));

beforeEach(() => {
  vi.clearAllMocks();
  mock.exec.mockResolvedValue({
    output: "done\n",
    stdout: "done\n",
    stderr: "",
    exitCode: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  mock.readFile.mockResolvedValue(Buffer.from([0, 255, 1]));
  mock.writeFile.mockResolvedValue(undefined);
  mock.delete.mockResolvedValue(undefined);
  mock.create.mockResolvedValue({
    id: "machine-1",
    exec: mock.exec,
    readFile: mock.readFile,
    writeFile: mock.writeFile,
    delete: mock.delete,
  });
});

describe("SmolSandbox", () => {
  it("creates explicitly local even with ambient Cloud credentials and releases its machine", async () => {
    const sandbox = await SmolSandbox.create();
    expect(mock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "node:22-alpine",
        workdir: "/workspace",
      }),
      expect.objectContaining({ target: "local", handleSignals: false }),
    );
    expect(sandbox.id).toBe("machine-1");
    expect(sandbox.isRunning).toBe(true);
    expect(createSmolSandboxFactoryFromSandbox(sandbox)({} as never)).toBe(
      sandbox,
    );
    await sandbox.close();
    await sandbox.close();
    expect(mock.delete).toHaveBeenCalledTimes(1);
    expect(sandbox.isRunning).toBe(false);
    await expect(sandbox.execute("true")).rejects.toMatchObject({
      code: "NOT_INITIALIZED",
    });
  });

  it("preserves command exit status and reports truncated output", async () => {
    const sandbox = await SmolSandbox.create();
    mock.exec.mockResolvedValueOnce({
      output: "error",
      stdout: "",
      stderr: "error",
      exitCode: 12,
      stdoutTruncated: false,
      stderrTruncated: true,
    });
    expect(await sandbox.execute("exit 12")).toEqual({
      output: "error",
      exitCode: 12,
      truncated: true,
    });
    expect(mock.exec).toHaveBeenCalledWith(["sh", "-lc", "exit 12"], {
      workdir: "/workspace",
    });
    await sandbox.close();
  });

  it("writes exact bytes, resolves relative paths, and returns per-file errors", async () => {
    const sandbox = await SmolSandbox.create();
    mock.writeFile.mockRejectedValueOnce(new Error("permission denied"));
    expect(
      await sandbox.uploadFiles([
        ["nested/first.bin", new Uint8Array([1])],
        ["second.bin", new Uint8Array([0, 255])],
      ]),
    ).toEqual([
      { path: "nested/first.bin", error: "permission_denied" },
      { path: "second.bin", error: null },
    ]);
    expect(mock.exec).toHaveBeenCalledWith([
      "mkdir",
      "-p",
      "--",
      "/workspace/nested",
    ]);
    expect(mock.writeFile).toHaveBeenCalledWith(
      "/workspace/second.bin",
      new Uint8Array([0, 255]),
    );
    mock.readFile.mockRejectedValueOnce(new Error("No such file or directory"));
    expect(await sandbox.downloadFiles(["missing", "second.bin"])).toEqual([
      { path: "missing", content: null, error: "file_not_found" },
      { path: "second.bin", content: new Uint8Array([0, 255, 1]), error: null },
    ]);
    await sandbox.close();
  });

  it("rejects ambiguous Cloud file paths without sending a request", async () => {
    const sandbox = await SmolSandbox.create({ target: "cloud" });
    expect(mock.create).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 1800 }),
      expect.objectContaining({ target: "cloud" }),
    );
    expect(
      await sandbox.uploadFiles([["odd\nname", new Uint8Array([1])]]),
    ).toEqual([{ path: "odd\nname", error: "invalid_path" }]);
    expect(await sandbox.downloadFiles(["odd\nname"])).toEqual([
      { path: "odd\nname", content: null, error: "invalid_path" },
    ]);
    expect(mock.writeFile).not.toHaveBeenCalled();
    expect(mock.readFile).not.toHaveBeenCalled();
    await sandbox.close();
  });

  it("deletes a created VM if initial file setup fails", async () => {
    mock.writeFile.mockRejectedValueOnce(new Error("permission denied"));
    const sandbox = new SmolSandbox({ initialFiles: { "src/a.js": "code" } });
    await expect(sandbox.initialize()).rejects.toMatchObject({
      code: "FILE_UPLOAD_FAILED",
    });
    expect(mock.delete).toHaveBeenCalledTimes(1);
    expect(sandbox.isRunning).toBe(false);
  });

  it("propagates transport failures so callers can retry", async () => {
    const sandbox = await SmolSandbox.create();
    mock.readFile.mockRejectedValueOnce(new Error("gateway timeout"));
    await expect(sandbox.downloadFiles(["a"])).rejects.toThrow(
      "gateway timeout",
    );
    await sandbox.close();
  });
});
