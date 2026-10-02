import { createMiddleware } from "langchain";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

const PDF_MIME_TYPE = "application/pdf";

/** Content block types `read_file` may emit that require multimodal model support. */
export const MULTIMODAL_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "image",
  "audio",
  "video",
  "file",
]);

const PROFILE_FIELD_BY_BLOCK_TYPE: Record<string, string> = {
  image: "imageInputs",
  audio: "audioInputs",
  video: "videoInputs",
};

const TOOL_MESSAGE_FIELD_BY_BLOCK_TYPE: Record<string, string> = {
  image: "imageToolMessage",
};

type Profile = Record<string, unknown>;
type Block = Record<string, unknown> & { type: string };

function hasInlineData(block: Block): boolean {
  return block.data != null || block.source_type === "base64";
}

function blockMimeType(block: Block): string | undefined {
  const mimeType = block.mimeType ?? block.mime_type;
  return typeof mimeType === "string" ? mimeType : undefined;
}

/**
 * Unlike the other block types, a missing `fileMimeTypes` defaults to
 * unsupported rather than supported: generic file support varies far more
 * across models than image/audio/video, so there's no safe assumption to
 * fall back on absent real profile data.
 */
function fileBlockSupported(
  block: Block,
  profile: Profile,
  inToolMessage: boolean,
): boolean {
  if (!hasInlineData(block)) {
    return true;
  }
  const mimeType = blockMimeType(block);
  if (mimeType === PDF_MIME_TYPE) {
    if (inToolMessage && profile.pdfToolMessage !== undefined) {
      return profile.pdfToolMessage !== false;
    }
    return profile.pdfInputs !== false;
  }
  if (mimeType == null) {
    return false;
  }
  const { fileMimeTypes } = profile;
  return Array.isArray(fileMimeTypes) && fileMimeTypes.includes(mimeType);
}

/**
 * Whether the model accepts a multimodal block.
 *
 * Missing profile fields default to supported, since profile coverage is
 * incomplete — except `file` blocks, where a missing `fileMimeTypes`
 * defaults to unsupported (see `fileBlockSupported`).
 */
export function multimodalBlockSupported(
  block: Block,
  profile: Profile,
  inToolMessage: boolean,
): boolean {
  if (block.type === "file") {
    return fileBlockSupported(block, profile, inToolMessage);
  }
  const field = PROFILE_FIELD_BY_BLOCK_TYPE[block.type];
  if (field == null) {
    return true;
  }
  if (inToolMessage) {
    const toolField = TOOL_MESSAGE_FIELD_BY_BLOCK_TYPE[block.type];
    if (toolField != null && profile[toolField] !== undefined) {
      return profile[toolField] !== false;
    }
  }
  return profile[field] !== false;
}

function placeholder(block: Block, path: string | undefined): Block {
  return {
    type: "text",
    text: `[read_file: ${path ?? "the requested file"} was not attached because this model does not support ${block.type} content (${blockMimeType(block) ?? "unknown"}).]`,
  };
}

function readFilePaths(messages: readonly BaseMessage[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const message of messages) {
    if (!AIMessage.isInstance(message)) {
      continue;
    }
    for (const toolCall of message.tool_calls ?? []) {
      const path = toolCall.args?.file_path;
      if (toolCall.id != null && typeof path === "string") {
        paths.set(toolCall.id, path);
      }
    }
  }
  return paths;
}

/**
 * Without this, a request carrying content the model can't accept (e.g. a
 * `.zip` file sent to a model without file support) fails with a
 * non-retryable 400, and since the content stays in history, every later
 * turn fails the same way. Only the request is changed; messages in state
 * are left untouched, so switching to a model that accepts the content
 * sends it again.
 */
export function scrubUnsupportedMultimodalContent(
  messages: readonly BaseMessage[],
  model: unknown,
): BaseMessage[] {
  const rawProfile = (model as { profile?: unknown } | undefined)?.profile;
  const profile: Profile =
    rawProfile != null && typeof rawProfile === "object"
      ? (rawProfile as Profile)
      : {};
  let paths: Map<string, string> | undefined;
  let changed = false;
  const result = messages.map((message) => {
    const isTool = ToolMessage.isInstance(message);
    if (!isTool && !HumanMessage.isInstance(message)) {
      return message;
    }
    let messageChanged = false;
    const content = (message.contentBlocks as Block[]).map((block) => {
      if (
        block == null ||
        typeof block !== "object" ||
        !MULTIMODAL_BLOCK_TYPES.has(block.type) ||
        multimodalBlockSupported(block, profile, isTool)
      ) {
        return block;
      }
      messageChanged = true;
      paths ??= readFilePaths(messages);
      return placeholder(
        block,
        isTool ? paths.get(message.tool_call_id) : undefined,
      );
    });
    if (!messageChanged) {
      return message;
    }
    changed = true;
    if (isTool) {
      return new ToolMessage({
        content,
        tool_call_id: message.tool_call_id,
        name: message.name,
        id: message.id,
        artifact: message.artifact,
        status: message.status,
        metadata: message.metadata,
        additional_kwargs: message.additional_kwargs,
        response_metadata: message.response_metadata,
      });
    }
    return new HumanMessage({
      content,
      name: message.name,
      id: message.id,
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
    });
  });
  return changed ? result : (messages as BaseMessage[]);
}

/**
 * Support is read from `model.profile` (see
 * https://docs.langchain.com/oss/javascript/langchain/models#model-profiles).
 *
 * Place this middleware last in the agent's `middleware` list, so that if
 * some other middleware changes `request.model`, this one sees the model
 * that will actually receive the request.
 */
export function createUnsupportedContentMiddleware() {
  return createMiddleware({
    name: "UnsupportedContentMiddleware",
    wrapModelCall: async (request, handler) => {
      const messages = scrubUnsupportedMultimodalContent(
        request.messages,
        request.model,
      );
      if (messages === request.messages) {
        return handler(request);
      }
      return handler({ ...request, messages });
    },
  });
}
