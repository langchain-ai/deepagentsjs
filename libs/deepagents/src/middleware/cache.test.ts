import { describe, it, expect, vi } from "vitest";
import { createCacheBreakpointMiddleware } from "./cache.js";
import { SystemMessage } from "@langchain/core/messages";

describe("createCacheBreakpointMiddleware", () => {
  // Real wrapModelCall calls always receive a model. The middleware now
  // gates per-call on `isAnthropicModel(request.model)` (#550), so every
  // existing test gets a ChatAnthropic stub to keep the cache_control
  // writes on the path under test.
  const fakeAnthropicModel = { getName: () => "ChatAnthropic" };

  describe("wrapModelCall", () => {
    it("adds cache_control to the last block of a string system message", () => {
      const middleware = createCacheBreakpointMiddleware();
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      middleware.wrapModelCall!(
        {
          model: fakeAnthropicModel,
          systemMessage: new SystemMessage("Base prompt"),
        } as any,
        mockHandler,
      );

      const blocks = mockHandler.mock.calls[0][0].systemMessage.contentBlocks;
      expect(blocks).toHaveLength(1);
      expect(blocks[0].text).toBe("Base prompt");
      expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    });

    it("adds cache_control only to the last block of a multi-block system message", () => {
      const middleware = createCacheBreakpointMiddleware();
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      middleware.wrapModelCall!(
        {
          model: fakeAnthropicModel,
          systemMessage: new SystemMessage({
            content: [
              { type: "text", text: "Block 1" },
              { type: "text", text: "Block 2" },
              { type: "text", text: "Block 3" },
            ],
          }),
        } as any,
        mockHandler,
      );

      const blocks = mockHandler.mock.calls[0][0].systemMessage.contentBlocks;
      expect(blocks).toHaveLength(3);
      expect(blocks[0].cache_control).toBeUndefined();
      expect(blocks[1].cache_control).toBeUndefined();
      expect(blocks[2].cache_control).toEqual({ type: "ephemeral" });
    });

    it("does not mutate the original system message blocks", () => {
      const middleware = createCacheBreakpointMiddleware();
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      const originalContent = [
        { type: "text" as const, text: "Block 1" },
        { type: "text" as const, text: "Block 2" },
      ];
      const systemMessage = new SystemMessage({ content: originalContent });

      middleware.wrapModelCall!(
        { model: fakeAnthropicModel, systemMessage } as any,
        mockHandler,
      );

      expect((originalContent[1] as any).cache_control).toBeUndefined();
    });

    it("passes through unchanged when system message has no blocks", () => {
      const middleware = createCacheBreakpointMiddleware();
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      const systemMessage = new SystemMessage({ content: [] });
      const request = { model: fakeAnthropicModel, systemMessage } as any;

      middleware.wrapModelCall!(request, mockHandler);

      expect(mockHandler).toHaveBeenCalledWith(request);
    });

    describe("per-call provider gating", () => {
      // Regression for langchain-ai/deepagentsjs#550: when
      // modelFallbackMiddleware swaps request.model from Anthropic to
      // OpenAI/Vertex/etc., the cache_control marker must not leak through
      // — the fallback provider rejects the request with 400 Unknown
      // parameter. The middleware was previously installed conditionally
      // on the *primary* model at boot time; the per-call gate fixes the
      // fallback case where the middleware is installed but the model has
      // been swapped.
      const fakeAnthropic = {
        getName: () => "ChatAnthropic",
      };
      const fakeOpenAI = {
        getName: () => "ChatOpenAI",
      };
      const fakeConfigurableAnthropic = {
        getName: () => "ConfigurableModel",
        _defaultConfig: { modelProvider: "anthropic" },
      };

      it("writes cache_control when request.model is ChatAnthropic", () => {
        const middleware = createCacheBreakpointMiddleware();
        const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

        middleware.wrapModelCall!(
          {
            model: fakeAnthropic,
            systemMessage: new SystemMessage("Base prompt"),
          } as any,
          mockHandler,
        );

        const blocks = mockHandler.mock.calls[0][0].systemMessage.contentBlocks;
        expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
      });

      it("writes cache_control when request.model is ConfigurableModel with anthropic provider", () => {
        const middleware = createCacheBreakpointMiddleware();
        const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

        middleware.wrapModelCall!(
          {
            model: fakeConfigurableAnthropic,
            systemMessage: new SystemMessage("Base prompt"),
          } as any,
          mockHandler,
        );

        const blocks = mockHandler.mock.calls[0][0].systemMessage.contentBlocks;
        expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
      });

      it("writes cache_control when request.model is the string 'anthropic:claude-...'", () => {
        const middleware = createCacheBreakpointMiddleware();
        const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

        middleware.wrapModelCall!(
          {
            model: "anthropic:claude-sonnet-4-6",
            systemMessage: new SystemMessage("Base prompt"),
          } as any,
          mockHandler,
        );

        const blocks = mockHandler.mock.calls[0][0].systemMessage.contentBlocks;
        expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
      });

      it("does NOT write cache_control when request.model is ChatOpenAI (fallback swap)", () => {
        const middleware = createCacheBreakpointMiddleware();
        const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

        const systemMessage = new SystemMessage("Base prompt");
        const request = { model: fakeOpenAI, systemMessage } as any;

        middleware.wrapModelCall!(request, mockHandler);

        // Handler called with the original request — no clone, no marker.
        expect(mockHandler).toHaveBeenCalledWith(request);
        const passed = mockHandler.mock.calls[0][0];
        const blocks = passed.systemMessage.contentBlocks ?? [];
        for (const block of blocks) {
          expect((block as any).cache_control).toBeUndefined();
        }
      });

      it("does NOT write cache_control when request.model is the string 'openai:gpt-5'", () => {
        const middleware = createCacheBreakpointMiddleware();
        const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

        const systemMessage = new SystemMessage("Base prompt");
        const request = { model: "openai:gpt-5", systemMessage } as any;

        middleware.wrapModelCall!(request, mockHandler);

        expect(mockHandler).toHaveBeenCalledWith(request);
      });
    });
  });
});
