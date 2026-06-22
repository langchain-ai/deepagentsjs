import { describe, it, expect, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { isBedrockConverseModel } from "./utils.js";

describe("isBedrockConverseModel", () => {
  describe("string inputs", () => {
    it("should detect bedrock: prefixed model strings", () => {
      expect(
        isBedrockConverseModel(
          "bedrock:anthropic.claude-3-5-sonnet-20240620-v1:0",
        ),
      ).toBe(true);

      expect(
        isBedrockConverseModel(
          "bedrock:us.anthropic.claude-3-7-sonnet-20250219-v1:0",
        ),
      ).toBe(true);

      expect(
        isBedrockConverseModel("bedrock:meta.llama3-70b-instruct-v1:0"),
      ).toBe(true);
    });

    it("should detect aws: prefixed model strings", () => {
      expect(
        isBedrockConverseModel("aws:anthropic.claude-3-5-sonnet-20240620-v1:0"),
      ).toBe(true);
      expect(isBedrockConverseModel("aws:amazon.nova-pro-v1:0")).toBe(true);
    });

    it("should reject non-Bedrock provider-prefixed model strings", () => {
      expect(isBedrockConverseModel("amazon.nova-pro-v1:0")).toBe(false);
      expect(isBedrockConverseModel("anthropic:claude-3-opus")).toBe(false);
      expect(isBedrockConverseModel("openai:gpt-4")).toBe(false);
    });
  });

  describe("model object inputs", () => {
    it("should detect ChatBedrockConverse model objects", () => {
      const model = new FakeListChatModel({ responses: [] });
      vi.spyOn(model, "getName").mockReturnValue("ChatBedrockConverse");
      expect(isBedrockConverseModel(model)).toBe(true);
    });

    it("should reject non-Bedrock model objects", () => {
      const anthropic = new FakeListChatModel({ responses: [] });
      vi.spyOn(anthropic, "getName").mockReturnValue("ChatAnthropic");
      expect(isBedrockConverseModel(anthropic)).toBe(false);
    });

    it("should detect ConfigurableModel wrapping the bedrock provider", () => {
      const model = new FakeListChatModel({ responses: [] });
      vi.spyOn(model, "getName").mockReturnValue("ConfigurableModel");
      (model as any)._defaultConfig = { modelProvider: "bedrock" };
      expect(isBedrockConverseModel(model)).toBe(true);
    });

    it("should detect ConfigurableModel wrapping the aws provider alias", () => {
      const model = new FakeListChatModel({ responses: [] });
      vi.spyOn(model, "getName").mockReturnValue("ConfigurableModel");
      (model as any)._defaultConfig = { modelProvider: "aws" };
      expect(isBedrockConverseModel(model)).toBe(true);
    });

    it("should reject ConfigurableModel with no _defaultConfig", () => {
      const model = new FakeListChatModel({ responses: [] });
      vi.spyOn(model, "getName").mockReturnValue("ConfigurableModel");
      expect(isBedrockConverseModel(model)).toBe(false);
    });
  });
});
