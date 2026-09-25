import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolMessage } from "langchain";

import { createFilesystemMiddleware } from "./fs.js";
import { BLOB_REF_KEY } from "./blobOffload.js";
import { StateBackend } from "../backends/state.js";
import { FilesystemBackend } from "../backends/filesystem.js";
import { CompositeBackend } from "../backends/composite.js";
import type { FileData } from "../backends/protocol.js";

const PNG_BASE64 = Buffer.from("not a real png, just some bytes").toString(
  "base64",
);

async function offloadReadFile(middleware: unknown, state: unknown) {
  return (middleware as any).wrapToolCall(
    {
      toolCall: { id: "call_1", name: "read_file", args: {} },
      state,
      runtime: {},
    },
    async () =>
      new ToolMessage({
        content: [
          { type: "image", mimeType: "image/png", data: PNG_BASE64 } as never,
        ],
        tool_call_id: "call_1",
        name: "read_file",
      }),
  );
}

describe("offloadBinaryReads + StateBackend routing", () => {
  let root: string;

  beforeEach(() => {
    root = fsSync.mkdtempSync(path.join(os.tmpdir(), "deepagents-blob-"));
  });

  afterEach(() => {
    fsSync.rmSync(root, { recursive: true, force: true });
  });

  it("is skipped when the backend is a plain StateBackend", async () => {
    const state: { messages: unknown[]; files: Record<string, FileData> } = {
      messages: [],
      files: {},
    };
    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend({ state, store: undefined }),
      offloadBinaryReads: true,
    });

    const result = (await offloadReadFile(middleware, state)) as ToolMessage;

    expect(result.content).toEqual([
      { type: "image", mimeType: "image/png", data: PNG_BASE64 },
    ]);
  });

  it("is skipped when /blobs routes to a StateBackend through CompositeBackend", async () => {
    const state: { messages: unknown[]; files: Record<string, FileData> } = {
      messages: [],
      files: {},
    };
    const middleware = createFilesystemMiddleware({
      backend: () =>
        new CompositeBackend(
          new FilesystemBackend({ rootDir: root, virtualMode: true }),
          { "/blobs": new StateBackend({ state, store: undefined }) },
        ),
      offloadBinaryReads: true,
    });

    const result = (await offloadReadFile(middleware, state)) as ToolMessage;

    expect(result.content).toEqual([
      { type: "image", mimeType: "image/png", data: PNG_BASE64 },
    ]);
  });

  it("still applies when a different route uses StateBackend but /blobs does not", async () => {
    const state: { messages: unknown[]; files: Record<string, FileData> } = {
      messages: [],
      files: {},
    };
    const middleware = createFilesystemMiddleware({
      backend: () =>
        new CompositeBackend(
          new FilesystemBackend({ rootDir: root, virtualMode: true }),
          { "/memories": new StateBackend({ state, store: undefined }) },
        ),
      offloadBinaryReads: true,
    });

    const result = (await offloadReadFile(middleware, state)) as ToolMessage;

    const [block] = result.content as Array<Record<string, unknown>>;
    expect(block.data).toBeUndefined();
    expect(typeof block[BLOB_REF_KEY]).toBe("string");
  });
});
