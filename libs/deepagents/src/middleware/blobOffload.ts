/**
 * Content-addressed offload of binary `read_file` blocks to the backend.
 *
 * Binary blocks are written to `/blobs/<sha256>` and replaced in state with a
 * `deepagents_blob` reference. Model requests are rehydrated from the backend
 * (or an in-process cache), so checkpoints never carry the base64 payload.
 */

import { createHash } from "node:crypto";
import { HumanMessage, ToolMessage } from "langchain";
import type {
  AnyBackendProtocol,
  FileDownloadResponse,
  FileUploadResponse,
} from "../backends/protocol.js";

/** Content block key holding the SHA-256 digest of an offloaded payload. */
export const BLOB_REF_KEY = "deepagents_blob";

const MISSING_BLOB_TEXT =
  "[Binary content from an earlier read_file call is no longer available. Re-read the file if you still need it.]";

const DEFAULT_BLOB_CACHE_BYTES = 256 * 1024 * 1024;

const DIGEST_RE = /^[0-9a-f]{64}$/;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

type Block = Record<string, unknown> & { type: string };

/** Whether `reference` is a well-formed digest string. */
function isDigest(reference: unknown): reference is string {
  return typeof reference === "string" && DIGEST_RE.test(reference);
}

function isValidBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64_RE.test(value);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Bounded, in-process cache of base64 payloads keyed by digest, LRU-evicted by total payload size. */
export class BlobCache {
  private readonly maxBytes: number;

  private size = 0;

  private readonly entries = new Map<string, string>();

  constructor(maxBytes: number = DEFAULT_BLOB_CACHE_BYTES) {
    this.maxBytes = maxBytes;
  }

  /** Return the cached payload for `digest`, marking it most recently used. */
  get(digest: string): string | undefined {
    const payload = this.entries.get(digest);
    if (payload === undefined) return undefined;
    this.entries.delete(digest);
    this.entries.set(digest, payload);
    return payload;
  }

  /** Cache `payload`, evicting least-recently-used entries past the size bound. */
  put(digest: string, payload: string): void {
    if (payload.length > this.maxBytes) return;
    const previous = this.entries.get(digest);
    if (previous !== undefined) {
      this.size -= previous.length;
      this.entries.delete(digest);
    }
    this.entries.set(digest, payload);
    this.size += payload.length;
    while (this.size > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.size -= oldest?.length ?? 0;
    }
  }
}

function blobPath(prefix: string, digest: string): string {
  return `${prefix}/${digest}`;
}

function contentBlocks(message: unknown): Block[] | null {
  const content = (message as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? (content as Block[]) : null;
}

/** Map each inline base64 payload found in `messages` to its digest and decoded bytes. */
function pendingBlobs(
  messages: readonly unknown[],
): Map<string, { digest: string; raw: Uint8Array }> {
  const pending = new Map<string, { digest: string; raw: Uint8Array }>();
  for (const message of messages) {
    const blocks = contentBlocks(message);
    if (!blocks) continue;
    for (const block of blocks) {
      if (block == null || typeof block !== "object") continue;
      const payload = block.data;
      if (
        typeof payload !== "string" ||
        pending.has(payload) ||
        !isValidBase64(payload)
      )
        continue;
      let raw: Uint8Array;
      try {
        raw = new Uint8Array(Buffer.from(payload, "base64"));
      } catch {
        continue;
      }
      pending.set(payload, { digest: sha256Hex(raw), raw });
    }
  }
  return pending;
}

/** Replace payloads found in `digests` with blob references; returns `messages` unchanged if nothing matched. */
function stubMessages(
  messages: readonly unknown[],
  digests: Map<string, string>,
): unknown[] {
  return messages.map((message) => {
    const blocks = contentBlocks(message);
    if (!blocks) return message;

    let changed = false;
    const newContent = blocks.map((block) => {
      const digest =
        typeof block.data === "string" ? digests.get(block.data) : undefined;
      if (digest === undefined) return block;
      changed = true;
      const { data: _data, ...rest } = block;
      return { ...rest, [BLOB_REF_KEY]: digest };
    });
    if (!changed) return message;

    return withContent(message, newContent);
  });
}

/**
 * Upload inline binary payloads found in `messages` and return messages carrying blob
 * references instead. Payloads that fail to upload stay inline — offload is best-effort.
 */
export async function offloadMessages(
  messages: readonly unknown[],
  backend: AnyBackendProtocol,
  prefix: string,
  cache: BlobCache,
): Promise<unknown[]> {
  const pending = pendingBlobs(messages);
  if (pending.size === 0) return [...messages];
  if (typeof backend.uploadFiles !== "function") {
    // oxlint-disable-next-line no-console
    console.warn(
      "Backend does not support uploadFiles; binary read_file content stays inline",
    );
    return [...messages];
  }

  const entries = [...pending.entries()];
  let responses: FileUploadResponse[];
  try {
    responses = await backend.uploadFiles(
      entries.map(([, { digest, raw }]) => [blobPath(prefix, digest), raw]),
    );
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.warn(
      "Failed to offload binary read_file content; keeping it inline",
      error,
    );
    return [...messages];
  }

  const digests = new Map<string, string>();
  entries.forEach(([payload, { digest }], index) => {
    if (responses[index]?.error == null) {
      digests.set(payload, digest);
      cache.put(digest, payload);
    }
  });
  return stubMessages(messages, digests);
}

/** Apply `offloadMessages` to a `read_file` tool result (a `ToolMessage`, or a `Command`-shaped update). */
export async function offloadToolResult(
  result: unknown,
  backend: AnyBackendProtocol,
  prefix: string,
  cache: BlobCache,
): Promise<unknown> {
  if (ToolMessage.isInstance(result)) {
    return (await offloadMessages([result], backend, prefix, cache))[0];
  }
  const update = (result as { update?: unknown } | null)?.update as
    | { messages?: unknown }
    | undefined;
  if (update && Array.isArray(update.messages)) {
    const messages = await offloadMessages(
      update.messages,
      backend,
      prefix,
      cache,
    );
    return {
      ...(result as Record<string, unknown>),
      update: { ...update, messages },
    };
  }
  return result;
}

/** Collect every well-formed `deepagents_blob` digest referenced in `messages`, deduplicated. */
function referencedDigests(messages: readonly unknown[]): string[] {
  const digests = new Set<string>();
  for (const message of messages) {
    const blocks = contentBlocks(message);
    if (!blocks) continue;
    for (const block of blocks) {
      const ref = block?.[BLOB_REF_KEY];
      if (isDigest(ref)) digests.add(ref);
    }
  }
  return [...digests];
}

function cachedPayloads(
  digests: readonly string[],
  cache: BlobCache,
): { payloads: Map<string, string>; missing: string[] } {
  const payloads = new Map<string, string>();
  const missing: string[] = [];
  for (const digest of digests) {
    const payload = cache.get(digest);
    if (payload !== undefined) {
      payloads.set(digest, payload);
    } else {
      missing.push(digest);
    }
  }
  return { payloads, missing };
}

/** Verify each downloaded blob's integrity before trusting it — blobs live on an agent-writable backend. */
function acceptDownloads(
  missing: readonly string[],
  responses: readonly FileDownloadResponse[],
  payloads: Map<string, string>,
  cache: BlobCache,
): void {
  missing.forEach((digest, index) => {
    const response = responses[index];
    if (!response || response.error != null || response.content == null) return;
    if (sha256Hex(response.content) !== digest) return;
    const payload = Buffer.from(response.content).toString("base64");
    cache.put(digest, payload);
    payloads.set(digest, payload);
  });
}

function messageHasRefs(message: unknown): boolean {
  const blocks = contentBlocks(message);
  return (
    blocks != null &&
    blocks.some(
      (block) =>
        block != null && typeof block === "object" && BLOB_REF_KEY in block,
    )
  );
}

/**
 * Return a copy of `message` with `content` substituted in, preserving the
 * fields each message type needs. Falls back to the message's own
 * constructor for a type this module doesn't special-case, so a reference on
 * an unexpected message type still gets resolved instead of silently kept.
 */
function withContent(message: unknown, content: unknown): unknown {
  if (ToolMessage.isInstance(message)) {
    return new ToolMessage({
      content: content as never,
      tool_call_id: message.tool_call_id,
      name: message.name,
      id: message.id,
      artifact: message.artifact,
      status: message.status,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
    });
  }
  if (HumanMessage.isInstance(message)) {
    return new HumanMessage({
      content: content as never,
      id: message.id,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
    });
  }
  const Ctor = (
    message as { constructor: new (fields: Record<string, unknown>) => unknown }
  )?.constructor;
  if (typeof Ctor !== "function") return message;
  // oxlint-disable-next-line no-console
  console.warn(
    `blobOffload: reconstructing an unrecognized message type (${Ctor.name}) to resolve a blob reference`,
  );
  return new Ctor({ ...(message as Record<string, unknown>), content });
}

/** Restore base64 payloads for blob references; a reference with no matching payload becomes a text notice. */
function restorePayloads(
  messages: readonly unknown[],
  payloads: Map<string, string>,
): unknown[] {
  const hydrate = (block: Block): unknown => {
    const ref = block[BLOB_REF_KEY];
    if (ref === undefined) return block;
    // Validate before use as a Map key — an unhashable shape degrades to the
    // missing-blob notice below rather than throwing.
    const payload = isDigest(ref) ? payloads.get(ref) : undefined;
    if (payload === undefined) {
      return { type: "text", text: MISSING_BLOB_TEXT };
    }
    const { [BLOB_REF_KEY]: _ref, ...rest } = block;
    return { ...rest, data: payload };
  };

  return messages.map((message) => {
    if (!messageHasRefs(message)) return message;
    const blocks = contentBlocks(message) ?? [];
    return withContent(message, blocks.map(hydrate));
  });
}

/**
 * Restore base64 payloads for blob references ahead of a model call.
 *
 * Only the returned array is used for the request — callers must not persist
 * the result back into state, or the checkpoint-size benefit of offloading is
 * lost the next time state is saved.
 */
export async function hydrateMessages(
  messages: readonly unknown[],
  backend: AnyBackendProtocol,
  prefix: string,
  cache: BlobCache,
): Promise<unknown[]> {
  if (!messages.some(messageHasRefs)) return [...messages];

  const { payloads, missing } = cachedPayloads(
    referencedDigests(messages),
    cache,
  );
  if (missing.length > 0) {
    if (typeof backend.downloadFiles !== "function") {
      // oxlint-disable-next-line no-console
      console.warn(
        "Backend does not support downloadFiles; offloaded read_file content is unavailable",
      );
    } else {
      let responses: FileDownloadResponse[] = [];
      try {
        responses = await backend.downloadFiles(
          missing.map((digest) => blobPath(prefix, digest)),
        );
      } catch (error) {
        // oxlint-disable-next-line no-console
        console.warn("Failed to load offloaded read_file content", error);
      }
      acceptDownloads(missing, responses, payloads, cache);
    }
  }
  return restorePayloads(messages, payloads);
}
