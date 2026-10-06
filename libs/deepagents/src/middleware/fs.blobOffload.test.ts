import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "langchain";
import { Command } from "@langchain/langgraph";

import { createFilesystemMiddleware } from "./fs.js";
import { BLOB_REF_KEY } from "./blobOffload.js";
import { StateBackend } from "../backends/state.js";
import { FilesystemBackend } from "../backends/filesystem.js";
import { CompositeBackend } from "../backends/composite.js";
import type { FileData } from "../backends/protocol.js";

const PNG_BASE64 = Buffer.from("not a real png, just some bytes").toString(
  "base64",
);
const PNG_DIGEST = createHash("sha256")
  .update(Buffer.from(PNG_BASE64, "base64"))
  .digest("hex");

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

describe("offloadBinaryContent + StateBackend routing", () => {
  let root: string;

  beforeEach(() => {
    root = fsSync.mkdtempSync(path.join(os.tmpdir(), "deepagents-blob-"));
  });

  afterEach(() => {
    fsSync.rmSync(root, { recursive: true, force: true });
  });

  it("warns when the backend is a StateBackend instance (not a factory)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    createFilesystemMiddleware({
      backend: new StateBackend({
        state: { messages: [], files: {} },
        store: undefined,
      }),
      offloadBinaryContent: true,
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("offloadBinaryContent has no effect"),
    );
    warn.mockRestore();
  });

  it("is skipped when the backend is a plain StateBackend", async () => {
    const state: { messages: unknown[]; files: Record<string, FileData> } = {
      messages: [],
      files: {},
    };
    const middleware = createFilesystemMiddleware({
      backend: () => new StateBackend({ state, store: undefined }),
      offloadBinaryContent: true,
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
      offloadBinaryContent: true,
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
      offloadBinaryContent: true,
    });

    const result = (await offloadReadFile(middleware, state)) as ToolMessage;

    const [block] = result.content as Array<Record<string, unknown>>;
    expect(block.data).toBeUndefined();
    expect(typeof block[BLOB_REF_KEY]).toBe("string");
  });
});

describe("wrapModelCall + offloadBinaryContent", () => {
  let root: string;

  beforeEach(() => {
    root = fsSync.mkdtempSync(path.join(os.tmpdir(), "deepagents-blob-"));
  });

  afterEach(() => {
    fsSync.rmSync(root, { recursive: true, force: true });
  });

  it("offloads a new HumanMessage's media and persists it via a Command update", async () => {
    const humanImage = new HumanMessage({
      id: "h1",
      content: [
        { type: "image", mimeType: "image/png", data: PNG_BASE64 } as never,
      ],
    });
    const state = {
      messages: [new AIMessage({ content: "hi" }), humanImage],
      files: {},
    };
    const middleware = createFilesystemMiddleware({
      backend: () =>
        new FilesystemBackend({ rootDir: root, virtualMode: true }),
      offloadBinaryContent: true,
    });

    const modelResponse = new AIMessage({ content: "ok" });
    const result = await (middleware as any).wrapModelCall(
      {
        state,
        runtime: {},
        tools: [],
        messages: state.messages,
        systemMessage: new SystemMessage(""),
      },
      async () => modelResponse,
    );

    expect(result).toBeInstanceOf(Command);
    const update = (result as Command).update as {
      messages: HumanMessage[];
    };
    expect(update.messages).toHaveLength(1);
    expect(update.messages[0].content).toEqual([
      { type: "image", mimeType: "image/png", [BLOB_REF_KEY]: PNG_DIGEST },
    ]);
    // The original HumanMessage in state is untouched; only the returned
    // Command's replacement carries the stubbed content.
    expect(humanImage.content).toEqual([
      { type: "image", mimeType: "image/png", data: PNG_BASE64 },
    ]);
  });

  it("returns the plain response when there is nothing new to offload", async () => {
    const state = { messages: [new AIMessage({ content: "hi" })], files: {} };
    const middleware = createFilesystemMiddleware({
      backend: () =>
        new FilesystemBackend({ rootDir: root, virtualMode: true }),
      offloadBinaryContent: true,
    });

    const modelResponse = new AIMessage({ content: "ok" });
    const result = await (middleware as any).wrapModelCall(
      {
        state,
        runtime: {},
        tools: [],
        messages: state.messages,
        systemMessage: new SystemMessage(""),
      },
      async () => modelResponse,
    );

    expect(result).toBe(modelResponse);
  });

  it("preserves a structured response even when a HumanMessage also gets offloaded", async () => {
    const humanImage = new HumanMessage({
      id: "h1",
      content: [
        { type: "image", mimeType: "image/png", data: PNG_BASE64 } as never,
      ],
    });
    const state = {
      messages: [new AIMessage({ content: "hi" }), humanImage],
      files: {},
    };
    const middleware = createFilesystemMiddleware({
      backend: () =>
        new FilesystemBackend({ rootDir: root, virtualMode: true }),
      offloadBinaryContent: true,
    });

    // The provider-strategy structured-output shape: not a plain AIMessage.
    const structuredResult = {
      structuredResponse: { answer: "ok" },
      messages: [new AIMessage({ content: "ok" })],
    };
    const result = await (middleware as any).wrapModelCall(
      {
        state,
        runtime: {},
        tools: [],
        messages: state.messages,
        systemMessage: new SystemMessage(""),
      },
      async () => structuredResult,
    );

    // Both must survive: the structured response, and the offloaded
    // HumanMessage replacement folded into the same shape's `messages`.
    expect((result as typeof structuredResult).structuredResponse).toEqual({
      answer: "ok",
    });
    const resultMessages = (result as typeof structuredResult)
      .messages as unknown[];
    const replacement = resultMessages.find(
      (m) => (m as HumanMessage).id === "h1",
    ) as unknown as HumanMessage;
    expect(replacement.content).toEqual([
      { type: "image", mimeType: "image/png", [BLOB_REF_KEY]: PNG_DIGEST },
    ]);
  });
});
