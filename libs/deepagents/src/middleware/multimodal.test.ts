import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { scrubUnsupportedMultimodalContent } from "./multimodal.js";

const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const openAIModel = (useResponsesApi: boolean, profile = {}) => ({
  _llmType: () => "openai",
  useResponsesApi,
  profile,
});

const otherModel = (profile = {}) => ({
  _llmType: () => "anthropic",
  profile,
});

const readFileCall = new AIMessage({
  content: "",
  tool_calls: [
    { id: "call_1", name: "read_file", args: { file_path: "/data.bin" } },
  ],
});

const toolResult = (block: Record<string, unknown>) =>
  new ToolMessage({
    tool_call_id: "call_1",
    name: "read_file",
    content: [block as never],
  });

const scrubbedContent = (
  block: Record<string, unknown>,
  model: unknown,
): unknown => {
  const result = scrubUnsupportedMultimodalContent(
    [readFileCall, toolResult(block)],
    model,
  );
  return result[1].content;
};

const placeholder = (type: string, mimeType: string) => [
  {
    type: "text",
    text: `[read_file: /data.bin was not attached because this model does not support ${type} content (${mimeType}).]`,
  },
];

describe("scrubUnsupportedMultimodalContent", () => {
  it("replaces an unsupported file block with a placeholder", () => {
    const block = { type: "file", mimeType: "application/zip", data: "AAA" };

    expect(scrubbedContent(block, openAIModel(true))).toEqual(
      placeholder("file", "application/zip"),
    );
  });

  it("replaces octet-stream file blocks for non-OpenAI models", () => {
    const block = {
      type: "file",
      mimeType: "application/octet-stream",
      data: "AAA",
    };

    expect(scrubbedContent(block, otherModel())).toEqual(
      placeholder("file", "application/octet-stream"),
    );
  });

  it("keeps allowlisted files only for OpenAI on the Responses API", () => {
    const block = { type: "file", mimeType: PPTX, data: "AAA" };

    expect(scrubbedContent(block, openAIModel(true))).toEqual([block]);
    expect(scrubbedContent(block, openAIModel(false))).toEqual(
      placeholder("file", PPTX),
    );
    expect(scrubbedContent(block, otherModel())).toEqual(
      placeholder("file", PPTX),
    );
  });

  it("detects OpenAI Responses models built from a model string", () => {
    const block = { type: "file", mimeType: PPTX, data: "AAA" };
    const configurable = {
      _defaultConfig: { modelProvider: "openai", useResponsesApi: true },
      profile: {},
    };

    expect(scrubbedContent(block, configurable)).toEqual([block]);
  });

  it("gates PDFs on the model profile", () => {
    const block = { type: "file", mimeType: "application/pdf", data: "AAA" };

    expect(scrubbedContent(block, otherModel())).toEqual([block]);
    expect(scrubbedContent(block, otherModel({ pdfInputs: false }))).toEqual(
      placeholder("file", "application/pdf"),
    );
    expect(
      scrubbedContent(block, otherModel({ pdfToolMessage: false })),
    ).toEqual(placeholder("file", "application/pdf"));
  });

  it("handles source_type base64 file blocks", () => {
    const block = {
      type: "file",
      source_type: "base64",
      mime_type: "application/zip",
      data: "AAA",
    };

    expect(scrubbedContent(block, otherModel())).toEqual(
      placeholder("file", "application/zip"),
    );
  });

  it("normalizes a raw OpenAI Chat Completions file block before checking support", () => {
    // Not a shape read_file ever emits, but a message's raw content can
    // carry it (round-tripped state, a hand-built HumanMessage). The base64
    // payload lives nested at `file.data`, not top-level `data`/`mimeType`,
    // so `hasInlineData` can't see it on the raw block; only `contentBlocks`
    // lifts it to `{ type: "file", data, mimeType }` first.
    const block = {
      type: "file",
      file: { data: "data:application/zip;base64,QUFB" },
    };

    expect(scrubbedContent(block, otherModel())).toEqual(
      placeholder("file", "application/zip"),
    );
  });

  it("keeps URL and file ID references", () => {
    const urlBlock = {
      type: "file",
      mimeType: "application/zip",
      url: "https://example.com/a.zip",
    };
    const idBlock = { type: "file", mimeType: "application/zip", fileId: "f1" };

    expect(scrubbedContent(urlBlock, otherModel())).toEqual([urlBlock]);
    expect(scrubbedContent(idBlock, otherModel())).toEqual([idBlock]);
  });

  it("gates images in tool messages on imageToolMessage", () => {
    const block = { type: "image", mimeType: "image/heic", data: "AAA" };
    const model = otherModel({ imageToolMessage: false });

    expect(scrubbedContent(block, model)).toEqual(
      placeholder("image", "image/heic"),
    );

    const human = new HumanMessage({ content: [block as never] });
    expect(scrubUnsupportedMultimodalContent([human], model)[0]).toBe(human);
  });

  it("gates media types on the model profile", () => {
    const block = { type: "audio", mimeType: "audio/wav", data: "AAA" };

    expect(scrubbedContent(block, otherModel())).toEqual([block]);
    expect(scrubbedContent(block, otherModel({ audioInputs: false }))).toEqual(
      placeholder("audio", "audio/wav"),
    );
  });

  it("does not modify messages in place", () => {
    const block = { type: "file", mimeType: "application/zip", data: "AAA" };
    const message = toolResult(block);
    const messages = [readFileCall, message];

    const result = scrubUnsupportedMultimodalContent(messages, otherModel());

    expect(result).not.toBe(messages);
    expect(result[1]).not.toBe(message);
    expect(message.content).toEqual([block]);
  });

  it("returns the same array when nothing is unsupported", () => {
    const messages = [
      readFileCall,
      toolResult({ type: "text", text: "hello" }),
    ];

    expect(scrubUnsupportedMultimodalContent(messages, otherModel())).toBe(
      messages,
    );
  });
});
