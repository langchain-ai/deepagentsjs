import { describe, it, expect, vi } from "vitest";
import { HumanMessage, ToolMessage } from "langchain";
import { createHash } from "node:crypto";

import {
  BLOB_REF_KEY,
  BlobCache,
  hydrateMessages,
  offloadMessages,
  offloadToolResult,
} from "./blobOffload.js";
import type {
  AnyBackendProtocol,
  FileDownloadResponse,
  FileUploadResponse,
} from "../backends/protocol.js";

const PNG_BASE64 = Buffer.from("not a real png, just some bytes").toString(
  "base64",
);
const PNG_DIGEST = createHash("sha256")
  .update(Buffer.from(PNG_BASE64, "base64"))
  .digest("hex");

const toolResult = (block: Record<string, unknown>, toolCallId = "call_1") =>
  new ToolMessage({
    tool_call_id: toolCallId,
    name: "read_file",
    content: [block as never],
  });

function fakeBackend(
  overrides: Partial<AnyBackendProtocol> = {},
): AnyBackendProtocol {
  return {
    async uploadFiles(files): Promise<FileUploadResponse[]> {
      return files.map(([path]) => ({ path, error: null }));
    },
    async downloadFiles(paths): Promise<FileDownloadResponse[]> {
      return paths.map((path) => ({
        path,
        content: null,
        error: "file_not_found",
      }));
    },
    ...overrides,
  } as AnyBackendProtocol;
}

describe("BlobCache", () => {
  it("returns undefined for an unknown digest", () => {
    expect(new BlobCache().get("nope")).toBeUndefined();
  });

  it("round-trips a stored payload", () => {
    const cache = new BlobCache();
    cache.put("abc", "payload");
    expect(cache.get("abc")).toBe("payload");
  });

  it("evicts least-recently-used entries once the size bound is exceeded", () => {
    const cache = new BlobCache(10);
    cache.put("a", "12345");
    cache.put("b", "12345");
    // "a" is now oldest; this put pushes total size over the bound and should evict it.
    cache.put("c", "12345");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("12345");
    expect(cache.get("c")).toBe("12345");
  });
});

describe("offloadMessages", () => {
  it("replaces an inline base64 block with a blob reference", async () => {
    const backend = fakeBackend();
    const cache = new BlobCache();
    const message = toolResult({
      type: "image",
      mimeType: "image/png",
      data: PNG_BASE64,
    });

    const [result] = await offloadMessages([message], backend, "/blobs", cache);

    expect((result as ToolMessage).content).toEqual([
      { type: "image", mimeType: "image/png", [BLOB_REF_KEY]: PNG_DIGEST },
    ]);
  });

  it("uploads identical content only once", async () => {
    const uploadFiles = vi.fn(async (files: Array<[string, Uint8Array]>) =>
      files.map(([path]) => ({ path, error: null })),
    );
    const backend = fakeBackend({ uploadFiles });
    const cache = new BlobCache();
    const messages = [
      toolResult(
        { type: "image", mimeType: "image/png", data: PNG_BASE64 },
        "call_1",
      ),
      toolResult(
        { type: "image", mimeType: "image/png", data: PNG_BASE64 },
        "call_2",
      ),
    ];

    await offloadMessages(messages, backend, "/blobs", cache);

    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(uploadFiles.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it("keeps content inline when the upload fails", async () => {
    const backend = fakeBackend({
      uploadFiles: vi.fn(async () => {
        throw new Error("network error");
      }),
    });
    const message = toolResult({
      type: "image",
      mimeType: "image/png",
      data: PNG_BASE64,
    });

    const [result] = await offloadMessages(
      [message],
      backend,
      "/blobs",
      new BlobCache(),
    );

    expect(result).toBe(message);
  });

  it("leaves messages untouched when the backend has no uploadFiles", async () => {
    const backend = fakeBackend({ uploadFiles: undefined });
    const message = toolResult({
      type: "image",
      mimeType: "image/png",
      data: PNG_BASE64,
    });

    const [result] = await offloadMessages(
      [message],
      backend,
      "/blobs",
      new BlobCache(),
    );

    expect(result).toBe(message);
  });

  it("does not modify the original message", async () => {
    const backend = fakeBackend();
    const message = toolResult({
      type: "image",
      mimeType: "image/png",
      data: PNG_BASE64,
    });

    const [result] = await offloadMessages(
      [message],
      backend,
      "/blobs",
      new BlobCache(),
    );

    expect(result).not.toBe(message);
    expect(message.content).toEqual([
      { type: "image", mimeType: "image/png", data: PNG_BASE64 },
    ]);
  });

  it("offloads a non-ToolMessage the same way as a ToolMessage", async () => {
    const backend = fakeBackend();
    const message = new HumanMessage({
      content: [
        { type: "image", mimeType: "image/png", data: PNG_BASE64 } as never,
      ],
    });

    const [result] = await offloadMessages(
      [message],
      backend,
      "/blobs",
      new BlobCache(),
    );

    expect(result).toBeInstanceOf(HumanMessage);
    expect((result as HumanMessage).content).toEqual([
      { type: "image", mimeType: "image/png", [BLOB_REF_KEY]: PNG_DIGEST },
    ]);
  });
});

describe("offloadToolResult", () => {
  it("preserves ToolMessage identity fields", async () => {
    const backend = fakeBackend();
    const message = toolResult(
      { type: "image", mimeType: "image/png", data: PNG_BASE64 },
      "call_42",
    );

    const result = (await offloadToolResult(
      message,
      backend,
      "/blobs",
      new BlobCache(),
    )) as ToolMessage;

    expect(result.tool_call_id).toBe("call_42");
    expect(result.name).toBe("read_file");
  });

  it("offloads messages inside a Command update", async () => {
    const backend = fakeBackend();
    const message = toolResult({
      type: "image",
      mimeType: "image/png",
      data: PNG_BASE64,
    });
    const command = { update: { messages: [message], files: { foo: "bar" } } };

    const result = (await offloadToolResult(
      command,
      backend,
      "/blobs",
      new BlobCache(),
    )) as typeof command;

    expect((result.update.messages[0] as ToolMessage).content).toEqual([
      { type: "image", mimeType: "image/png", [BLOB_REF_KEY]: PNG_DIGEST },
    ]);
    expect(result.update.files).toEqual({ foo: "bar" });
  });
});

describe("hydrateMessages", () => {
  const referenceMessage = () =>
    toolResult({
      type: "image",
      mimeType: "image/png",
      [BLOB_REF_KEY]: PNG_DIGEST,
    });

  it("resolves a reference from the cache without calling the backend", async () => {
    const downloadFiles = vi.fn();
    const backend = fakeBackend({ downloadFiles });
    const cache = new BlobCache();
    cache.put(PNG_DIGEST, PNG_BASE64);

    const [result] = await hydrateMessages(
      [referenceMessage()],
      backend,
      "/blobs",
      cache,
    );

    expect((result as ToolMessage).content).toEqual([
      { type: "image", mimeType: "image/png", data: PNG_BASE64 },
    ]);
    expect(downloadFiles).not.toHaveBeenCalled();
  });

  it("falls back to the backend on a cache miss, then caches the result", async () => {
    const raw = Buffer.from(PNG_BASE64, "base64");
    const downloadFiles = vi.fn(async (paths: string[]) =>
      paths.map((path) => ({ path, content: raw, error: null })),
    );
    const backend = fakeBackend({ downloadFiles });
    const cache = new BlobCache();

    const [first] = await hydrateMessages(
      [referenceMessage()],
      backend,
      "/blobs",
      cache,
    );
    expect((first as ToolMessage).content).toEqual([
      { type: "image", mimeType: "image/png", data: PNG_BASE64 },
    ]);
    expect(downloadFiles).toHaveBeenCalledTimes(1);

    await hydrateMessages([referenceMessage()], backend, "/blobs", cache);
    expect(downloadFiles).toHaveBeenCalledTimes(1);
  });

  it("treats content that fails the integrity check as missing", async () => {
    const wrongBytes = Buffer.from("this is not the right content");
    const backend = fakeBackend({
      downloadFiles: async (paths) =>
        paths.map((path) => ({ path, content: wrongBytes, error: null })),
    });

    const [result] = await hydrateMessages(
      [referenceMessage()],
      backend,
      "/blobs",
      new BlobCache(),
    );

    expect((result as ToolMessage).content).toEqual([
      { type: "text", text: expect.stringContaining("no longer available") },
    ]);
  });

  it("degrades to a placeholder when the blob is missing", async () => {
    const backend = fakeBackend();

    const [result] = await hydrateMessages(
      [referenceMessage()],
      backend,
      "/blobs",
      new BlobCache(),
    );

    expect((result as ToolMessage).content).toEqual([
      { type: "text", text: expect.stringContaining("no longer available") },
    ]);
  });

  it("degrades to a placeholder instead of throwing on a malformed reference", async () => {
    const backend = fakeBackend();
    const message = toolResult({
      type: "image",
      mimeType: "image/png",
      [BLOB_REF_KEY]: [],
    });

    const run = async () =>
      hydrateMessages([message], backend, "/blobs", new BlobCache());

    await expect(run()).resolves.not.toThrow();
    const [result] = await run();
    expect((result as ToolMessage).content).toEqual([
      { type: "text", text: expect.stringContaining("no longer available") },
    ]);
  });

  it("does not modify the original message", async () => {
    const backend = fakeBackend();
    const cache = new BlobCache();
    cache.put(PNG_DIGEST, PNG_BASE64);
    const message = referenceMessage();

    const [result] = await hydrateMessages([message], backend, "/blobs", cache);

    expect(result).not.toBe(message);
    expect(message.content).toEqual([
      { type: "image", mimeType: "image/png", [BLOB_REF_KEY]: PNG_DIGEST },
    ]);
  });

  it("returns the same array when nothing references a blob", async () => {
    const backend = fakeBackend();
    const messages = [toolResult({ type: "text", text: "hello" })];

    const result = await hydrateMessages(
      messages,
      backend,
      "/blobs",
      new BlobCache(),
    );

    expect(result).not.toBe(messages);
    expect(result[0]).toBe(messages[0]);
  });

  it("hydrates a reference on a non-ToolMessage instead of dropping it", async () => {
    const backend = fakeBackend();
    const cache = new BlobCache();
    cache.put(PNG_DIGEST, PNG_BASE64);
    const message = new HumanMessage({
      content: [
        {
          type: "image",
          mimeType: "image/png",
          [BLOB_REF_KEY]: PNG_DIGEST,
        } as never,
      ],
    });

    const [result] = await hydrateMessages([message], backend, "/blobs", cache);

    expect(result).toBeInstanceOf(HumanMessage);
    expect((result as HumanMessage).content).toEqual([
      { type: "image", mimeType: "image/png", data: PNG_BASE64 },
    ]);
  });
});
