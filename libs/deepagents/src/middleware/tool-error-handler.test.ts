import { describe, it, expect } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { NodeInterrupt } from "@langchain/langgraph";
import { createToolErrorHandlerMiddleware } from "./tool-error-handler.js";

function makeRequest(toolCallId = "call_1", toolName = "my_tool") {
  return {
    toolCall: { id: toolCallId, name: toolName, args: {} },
    tool: undefined,
    state: { messages: [] },
    runtime: {},
  } as any;
}

describe("createToolErrorHandlerMiddleware", () => {
  describe("wrapToolCall", () => {
    it("passes through successful result unchanged", async () => {
      // given
      const middleware = createToolErrorHandlerMiddleware();
      const expected = new ToolMessage({
        content: "ok",
        tool_call_id: "call_1",
        name: "my_tool",
      });
      const handler = async () => expected;

      // when
      const result = await middleware.wrapToolCall!(makeRequest(), handler);

      // then
      expect(result).toBe(expected);
    });

    it("converts a thrown Error to a ToolMessage with status error", async () => {
      // given
      const middleware = createToolErrorHandlerMiddleware();
      const handler = async () => {
        throw new Error("Timeout: browser did not respond");
      };

      // when
      const result = await middleware.wrapToolCall!(
        makeRequest("call_2", "wam_load_chain"),
        handler,
      );

      // then
      expect(ToolMessage.isInstance(result)).toBe(true);
      const msg = result as ToolMessage;
      expect(msg.tool_call_id).toBe("call_2");
      expect(msg.name).toBe("wam_load_chain");
      expect(msg.status).toBe("error");
      expect(msg.content).toBe("Error: Timeout: browser did not respond");
    });

    it("re-throws NodeInterrupt without converting", async () => {
      // given
      const middleware = createToolErrorHandlerMiddleware();
      const interrupt = new NodeInterrupt("human approval needed");
      const handler = async () => {
        throw interrupt;
      };

      // when, then
      await expect(
        middleware.wrapToolCall!(makeRequest(), handler),
      ).rejects.toThrow(interrupt);
    });

    it("re-throws when AbortSignal is aborted", async () => {
      // given
      const middleware = createToolErrorHandlerMiddleware();
      const controller = new AbortController();
      controller.abort();
      const error = new Error("aborted");
      const requestWithSignal = {
        ...makeRequest(),
        runtime: { signal: controller.signal },
      } as any;
      const handler = async () => {
        throw error;
      };

      // when, then
      await expect(
        middleware.wrapToolCall!(requestWithSignal, handler),
      ).rejects.toThrow(error);
    });

    it("converts error to ToolMessage when signal is present but not aborted", async () => {
      // given
      const middleware = createToolErrorHandlerMiddleware();
      const controller = new AbortController();
      const requestWithSignal = {
        ...makeRequest("call_3", "my_tool"),
        runtime: { signal: controller.signal },
      } as any;
      const handler = async () => {
        throw new Error("transient failure");
      };

      // when
      const result = await middleware.wrapToolCall!(requestWithSignal, handler);

      // then
      expect(ToolMessage.isInstance(result)).toBe(true);
      expect((result as ToolMessage).status).toBe("error");
      expect((result as ToolMessage).content).toBe("Error: transient failure");
    });
  });
});
