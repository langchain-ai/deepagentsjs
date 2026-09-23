import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

/**
 * File MIME types OpenAI accepts as `input_file` on the Responses API.
 *
 * Source: https://developers.openai.com/api/docs/guides/file-inputs
 */
export const OPENAI_FILE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/msword",
  "application/vnd.apple.iwork",
  "application/vnd.apple.keynote",
  "application/vnd.apple.pages",
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  // Allows non-UTF-8 text files to be mapped to OpenAI as `"type": "file"` binaries.
  "application/csv",
  "application/graphql",
  "application/javascript",
  "application/json",
  "application/json5",
  "application/rtf",
  "application/toml",
  "application/typescript",
  "application/x-awk",
  "application/x-bash",
  "application/x-graphql",
  "application/x-httpd-php",
  "application/x-httpd-php-source",
  "application/x-iif",
  "application/x-json5",
  "application/x-ndjson",
  "application/x-patch",
  "application/x-php",
  "application/x-powershell",
  "application/x-protobuf",
  "application/x-rust",
  "application/x-scala",
  "application/x-sql",
  "application/x-subrip",
  "application/x-terraform",
  "application/x-toml",
  "application/x-yaml",
  "application/yaml",
  "message/rfc822",
  "text/calendar",
  "text/css",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/jsx",
  "text/markdown",
  "text/plain",
  "text/rtf",
  "text/srt",
  "text/tsv",
  "text/tsx",
  "text/vbscript",
  "text/vtt",
  "text/x-R",
  "text/x-asm",
  "text/x-astro",
  "text/x-awk",
  "text/x-bash",
  "text/x-c",
  "text/x-c++",
  "text/x-clojure",
  "text/x-cmake",
  "text/x-csharp",
  "text/x-dart",
  "text/x-diff",
  "text/x-dockerfile",
  "text/x-ejs",
  "text/x-elixir",
  "text/x-erb",
  "text/x-erlang",
  "text/x-go",
  "text/x-golang",
  "text/x-gradle",
  "text/x-graphql",
  "text/x-groovy",
  "text/x-handlebars",
  "text/x-haskell",
  "text/x-hcl",
  "text/x-iif",
  "text/x-ini",
  "text/x-jade",
  "text/x-java",
  "text/x-jinja2",
  "text/x-julia",
  "text/x-kotlin",
  "text/x-less",
  "text/x-liquid",
  "text/x-lisp",
  "text/x-lua",
  "text/x-makefile",
  "text/x-mustache",
  "text/x-objectivec",
  "text/x-objectivec++",
  "text/x-patch",
  "text/x-perl",
  "text/x-php",
  "text/x-properties",
  "text/x-protobuf",
  "text/x-pug",
  "text/x-python",
  "text/x-r",
  "text/x-rst",
  "text/x-ruby",
  "text/x-rust",
  "text/x-sass",
  "text/x-scala",
  "text/x-script.python",
  "text/x-scss",
  "text/x-sh",
  "text/x-shellscript",
  "text/x-sql",
  "text/x-subrip",
  "text/x-swift",
  "text/x-terraform",
  "text/x-tex",
  "text/x-tmpl",
  "text/x-toml",
  "text/x-twig",
  "text/x-typescript",
  "text/x-vcard",
  "text/x-yaml",
  "text/x-zsh",
  "text/xml",
]);

const PDF_MIME_TYPE = "application/pdf";

const MULTIMODAL_BLOCK_TYPES = new Set(["image", "audio", "video", "file"]);

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

/** Whether `model` is an OpenAI or Azure OpenAI chat model using the Responses API. */
function isOpenAIResponsesModel(model: unknown): boolean {
  if (model == null || typeof model !== "object") {
    return false;
  }
  const m = model as {
    _llmType?: () => string;
    useResponsesApi?: boolean;
    _defaultConfig?: Record<string, unknown>;
  };
  const config = m._defaultConfig;
  if (config != null) {
    return (
      (config.modelProvider === "openai" ||
        config.modelProvider === "azure_openai") &&
      config.useResponsesApi === true
    );
  }
  const llmType = typeof m._llmType === "function" ? m._llmType() : undefined;
  return (
    (llmType === "openai" || llmType === "azure_openai") &&
    m.useResponsesApi === true
  );
}

function hasInlineData(block: Block): boolean {
  return block.data != null || block.source_type === "base64";
}

function blockMimeType(block: Block): string | undefined {
  const mimeType = block.mimeType ?? block.mime_type;
  return typeof mimeType === "string" ? mimeType : undefined;
}

function fileBlockSupported(
  block: Block,
  model: unknown,
  profile: Profile,
  inToolMessage: boolean,
): boolean {
  if (!hasInlineData(block)) {
    return true;
  }
  const mimeType = blockMimeType(block);
  if (mimeType === PDF_MIME_TYPE) {
    if (inToolMessage && profile.pdfToolMessage === false) {
      return false;
    }
    return profile.pdfInputs !== false;
  }
  return (
    mimeType != null &&
    OPENAI_FILE_MIME_TYPES.has(mimeType) &&
    isOpenAIResponsesModel(model)
  );
}

/**
 * Whether the model accepts a multimodal block.
 *
 * Missing profile fields default to supported, since profile coverage is
 * incomplete. Only an explicit `false` rejects a block type.
 */
export function multimodalBlockSupported(
  block: Block,
  model: unknown,
  profile: Profile,
  inToolMessage: boolean,
): boolean {
  if (block.type === "file") {
    return fileBlockSupported(block, model, profile, inToolMessage);
  }
  const field = PROFILE_FIELD_BY_BLOCK_TYPE[block.type];
  if (field == null) {
    return true;
  }
  if (inToolMessage) {
    const toolField = TOOL_MESSAGE_FIELD_BY_BLOCK_TYPE[block.type];
    if (toolField != null && profile[toolField] === false) {
      return false;
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

function readFilePaths(messages: BaseMessage[]): Map<string, string> {
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
 * Providers return a non-retryable 400 for unsupported blocks (e.g. a `.zip`
 * file block), and because the block stays in history every later turn fails
 * too. Only the request is changed; messages in state are left untouched.
 */
export function scrubUnsupportedMultimodalContent(
  messages: BaseMessage[],
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
        multimodalBlockSupported(block, model, profile, isTool)
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
  return changed ? result : messages;
}
