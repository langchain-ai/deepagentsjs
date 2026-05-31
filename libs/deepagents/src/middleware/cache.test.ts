import { describe, it, expect, vi } from "vitest";
import { createCacheBreakpointMiddleware } from "./cache.js";
import { SystemMessage } from "@langchain/core/messages";

describe("createCacheBreakpointMiddleware", () => {
  describe("wrapModelCall", () => {
    it("adds cache_control to the last block of a string system message", () => {
      const middleware = createCacheBreakpointMiddleware();
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      middleware.wrapModelCall!(
        { systemMessage: new SystemMessage("Base prompt") } as any,
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

      middleware.wrapModelCall!({ systemMessage } as any, mockHandler);

      expect((originalContent[1] as any).cache_control).toBeUndefined();
    });

    it("passes through unchanged when system message has no blocks", () => {
      const middleware = createCacheBreakpointMiddleware();
      const mockHandler = vi.fn().mockReturnValue({ response: "ok" });

      const systemMessage = new SystemMessage({ content: [] });
      const request = { systemMessage } as any;

      middleware.wrapModelCall!(request, mockHandler);

      expect(mockHandler).toHaveBeenCalledWith(request);
    });
  });
});
