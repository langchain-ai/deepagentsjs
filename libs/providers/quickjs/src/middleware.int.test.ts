import { describe, it, expect, beforeEach } from "vitest";
import { createAgent } from "langchain";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createQuickJSMiddleware } from "./middleware.js";
import { ReplSession } from "./session.js";

import type * as _zodTypes from "@langchain/core/utils/types";
import type * as _zodMeta from "@langchain/langgraph/zod";
import type * as _messages from "@langchain/core/messages";

const MODEL = "claude-sonnet-4-5-20250929";

describe("QuickJS REPL integration", () => {
  beforeEach(() => {
    ReplSession.clearCache();
  });

  it(
    "should persist REPL state across multiple js_eval calls within the same thread",
    { timeout: 90_000 },
    async () => {
      const quickjsMiddleware = createQuickJSMiddleware();
      const checkpointer = new MemorySaver();
      const threadId = `int-repl-persist-${Date.now()}`;

      const agent = createAgent({
        model: MODEL,
        middleware: [quickjsMiddleware],
        checkpointer,
      });

      const config = {
        configurable: { thread_id: threadId },
        recursionLimit: 50,
      };

      const result = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Use js_eval twice: first call `var x = 99`, then in a separate second call log `x` with console.log. Report the value you see.",
            ),
          ],
        },
        config,
      );

      const toolMessages = result.messages.filter(ToolMessage.isInstance);
      expect(toolMessages.length).toBeGreaterThanOrEqual(2);

      const secondToolContent = toolMessages[1].content as string;
      expect(secondToolContent).toContain("99");

      expect(ReplSession.hasAnyForThread(threadId)).toBe(true);
    },
  );

  it(
    "should reference variables from prior cells instead of re-embedding data",
    { timeout: 90_000 },
    async () => {
      const quickjsMiddleware = createQuickJSMiddleware();
      const checkpointer = new MemorySaver();
      const threadId = `int-repl-reuse-${Date.now()}`;

      const agent = createAgent({
        model: MODEL,
        middleware: [quickjsMiddleware],
        checkpointer,
      });

      const config = {
        configurable: { thread_id: threadId },
        recursionLimit: 50,
      };

      // Natural prompt — doesn't tell the LLM HOW to structure its cells.
      // The system prompt + state hint should guide it to reuse variables.
      const result = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              "Using js_eval, first store this data: " +
                '[{name: "a", value: 10}, {name: "b", value: 20}, {name: "c", value: 30}]. ' +
                "Then in a separate js_eval call, compute the sum of all the values.",
            ),
          ],
        },
        config,
      );

      const toolMessages = result.messages.filter(ToolMessage.isInstance);
      expect(toolMessages.length).toBeGreaterThanOrEqual(2);

      // Verify the second js_eval call does not re-embed the array literal
      const aiMessages = result.messages.filter(AIMessage.isInstance);
      const jsEvalCalls = aiMessages.flatMap((msg) =>
        (msg.tool_calls || []).filter((tc) => tc.name === "js_eval"),
      );
      expect(jsEvalCalls.length).toBeGreaterThanOrEqual(2);

      const secondCallCode = jsEvalCalls[1].args?.code as string;
      expect(secondCallCode).not.toContain('"name": "a"');
      expect(secondCallCode).not.toContain('"name": "b"');

      // Verify the computation succeeded (10 + 20 + 30 = 60)
      const lastToolContent = toolMessages[toolMessages.length - 1]
        .content as string;
      expect(lastToolContent).toContain("60");
    },
  );
});
