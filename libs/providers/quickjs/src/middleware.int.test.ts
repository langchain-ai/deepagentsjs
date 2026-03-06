import { describe, it, expect, beforeEach } from "vitest";
import { createAgent } from "langchain";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
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

      const session = ReplSession.get(threadId);
      expect(session).not.toBeNull();
    },
  );
});
