/**
 * Reproduction case for: "If connection breaks agent does not recover #167"
 *
 * ## Context: LangChain's Built-in Retry Mechanism
 *
 * LangChain chat models (ChatAnthropic, ChatOpenAI, etc.) already have HTTP-level
 * retry capabilities via `AsyncCaller` + `p-retry`:
 *
 * - Default `maxRetries: 6` with exponential backoff and jitter
 * - Retries on: network errors (ETIMEDOUT, ECONNRESET), rate limits (429), server errors (5xx)
 * - No retry on: 400, 401, 403, 404, AbortError, insufficient_quota
 * - SDK-level retries are disabled (`maxRetries: 0` on Anthropic/OpenAI SDK clients)
 *   in favor of LangChain's own retry via `this.caller.call()`
 *
 * ## What This Test Demonstrates
 *
 * Even with LangChain's HTTP-level retries, the agent can still crash when:
 *
 * 1. **All retries are exhausted**: After 6 failed attempts, the error propagates up
 *    and crashes the agent. There is no agent-level recovery or graceful degradation.
 *
 * 2. **Mid-stream failures**: `createStreamWithRetry` only retries the initial stream
 *    creation. If a connection drops mid-stream (during chunk iteration), no retry occurs.
 *
 * 3. **No agent-level retry**: When a model call fails after tool execution (e.g., the
 *    agent wrote a file, then the next model call fails), the entire agent crashes.
 *    Progress made during the session (files, todos) is lost without a checkpointer.
 *
 * 4. **No checkpointer-aware recovery**: Even with a checkpointer, the framework provides
 *    no mechanism to automatically resume from a checkpoint after a transient failure.
 *
 * ## The Fix
 *
 * Users can configure `maxRetries` on their model instance. However, the agent itself
 * should also handle the case where all retries are exhausted, potentially by:
 * - Implementing a retry middleware in `wrapModelCall`
 * - Using LangGraph's built-in `retryPolicy` (which exists but is not configured by `createDeepAgent`)
 * - Providing graceful degradation (save state, notify user, allow resume)
 *
 * NOTE: Tests use `FakeListChatModel` which bypasses `AsyncCaller` (no real HTTP calls).
 * We spy on `FakeListChatModel.prototype._generate` because `bindTools()` creates a
 * new model instance internally.
 *
 * @see https://github.com/langchain-ai/deepagentsjs/issues/167
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createDeepAgent } from "./agent.js";

/**
 * Simulates errors that would occur AFTER LangChain's built-in retries
 * are exhausted. In production, these represent the final error after
 * 6 retry attempts with exponential backoff have all failed.
 */
class APITimeoutError extends Error {
  constructor() {
    super(
      "Request timed out after 6 retries: ETIMEDOUT (all retry attempts exhausted)",
    );
    this.name = "APITimeoutError";
  }
}

class RateLimitError extends Error {
  status = 429;
  constructor() {
    super(
      "429 Too Many Requests - Rate limit exceeded after 6 retries (all retry attempts exhausted)",
    );
    this.name = "RateLimitError";
  }
}

class ServerError extends Error {
  status = 502;
  constructor() {
    super(
      "502 Bad Gateway - Server unavailable after 6 retries (all retry attempts exhausted)",
    );
    this.name = "ServerError";
  }
}

class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

describe("Connection Recovery - Issue #167", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Scenario 1: All retries exhausted on first call", () => {
    it("agent crashes when LLM is unreachable after all retries", async () => {
      /**
       * Reproduction: LLM provider is down for an extended period.
       * LangChain's AsyncCaller retries 6 times with exponential backoff,
       * but all attempts fail. The error propagates to the agent which
       * crashes immediately with no higher-level recovery.
       *
       * In CLI usage: user starts a task, sees nothing for ~2 minutes
       * (retries happening), then the CLI exits with an error.
       */
      const model = new FakeListChatModel({
        responses: ["unreachable"],
      });

      vi.spyOn(FakeListChatModel.prototype, "_generate").mockRejectedValue(
        new ServerError(),
      );

      const agent = createDeepAgent({ model });

      await expect(
        agent.invoke({
          messages: [new HumanMessage("Hello, help me with a task")],
        }),
      ).rejects.toThrow();
    });
  });

  describe("Scenario 2: Retries exhausted after successful tool call - progress lost", () => {
    it("agent crashes after writing a file - all progress is lost", async () => {
      /**
       * CORE REPRODUCTION for #167:
       *
       * 1. Agent makes first model call → succeeds → returns write_file tool call
       * 2. Tool executes → file is written successfully
       * 3. Agent makes second model call → LLM is now unreachable
       * 4. LangChain retries 6 times (all fail)
       * 5. Error propagates → agent crashes
       * 6. Written file and all progress is LOST (no checkpointer)
       *
       * This is the exact scenario from the issue: "heavy tasks" where the
       * agent has been working for a while and then the connection drops.
       * All work is lost and the user must start over.
       */
      const toolCallId = `call_${Date.now()}`;

      let callCount = 0;
      vi.spyOn(FakeListChatModel.prototype, "_generate").mockImplementation(
        async function () {
          callCount++;
          if (callCount >= 2) {
            // After tool execution, all retry attempts fail
            throw new ConnectionError(
              "ECONNRESET after 6 retries: Connection reset by peer (all retry attempts exhausted)",
            );
          }
          // First call succeeds
          return {
            generations: [
              {
                text: "",
                message: new AIMessage({
                  content: "",
                  tool_calls: [
                    {
                      id: toolCallId,
                      name: "write_file",
                      args: {
                        file_path: "/research/notes.md",
                        content: "# Research Notes\n\nImportant findings...",
                      },
                    },
                  ],
                }),
              },
            ],
          };
        },
      );

      const model = new FakeListChatModel({ responses: ["Done"] });
      const agent = createDeepAgent({ model });

      // Agent crashes. The file was written but the result is never returned.
      await expect(
        agent.invoke({
          messages: [
            new HumanMessage(
              "Research and write notes about quantum computing",
            ),
          ],
        }),
      ).rejects.toThrow("ECONNRESET");

      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Scenario 3: Rate limit persists beyond retry window", () => {
    it("agent crashes after creating todos - no extended backoff for rate limits", async () => {
      /**
       * Reproduction: Agent creates todos, then hits a persistent rate limit.
       * LangChain retries 6 times but the rate limit window is longer than
       * the retry backoff. The agent crashes and todos are lost.
       *
       * A proper fix would respect Retry-After headers and wait accordingly,
       * or implement agent-level backoff that's longer than HTTP-level retries.
       */
      const todoCallId = `call_todo_${Date.now()}`;

      let callCount = 0;
      vi.spyOn(FakeListChatModel.prototype, "_generate").mockImplementation(
        async function () {
          callCount++;
          if (callCount >= 2) {
            throw new RateLimitError();
          }
          return {
            generations: [
              {
                text: "",
                message: new AIMessage({
                  content: "",
                  tool_calls: [
                    {
                      id: todoCallId,
                      name: "write_todos",
                      args: {
                        todos: [
                          {
                            id: "1",
                            content: "Research topic",
                            status: "in_progress",
                          },
                          {
                            id: "2",
                            content: "Write report",
                            status: "pending",
                          },
                        ],
                      },
                    },
                  ],
                }),
              },
            ],
          };
        },
      );

      const model = new FakeListChatModel({ responses: ["Done"] });
      const agent = createDeepAgent({ model });

      await expect(
        agent.invoke({
          messages: [new HumanMessage("Research quantum computing")],
        }),
      ).rejects.toThrow("429");

      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Scenario 4: Multi-step progress lost on crash", () => {
    it("agent crashes after todos + file write - all progress gone", async () => {
      /**
       * Reproduction: Agent completes two steps (todos + file), then crashes.
       * This is the most painful scenario for CLI "heavy tasks":
       * - Multiple model calls succeeded
       * - Real work was done (files written, state updated)
       * - Connection drop wipes everything
       */
      const todoCallId = `call_todo_${Date.now()}`;
      const writeCallId = `call_write_${Date.now()}`;

      let callCount = 0;
      vi.spyOn(FakeListChatModel.prototype, "_generate").mockImplementation(
        async function () {
          callCount++;
          if (callCount === 1) {
            return {
              generations: [
                {
                  text: "",
                  message: new AIMessage({
                    content: "",
                    tool_calls: [
                      {
                        id: todoCallId,
                        name: "write_todos",
                        args: {
                          todos: [
                            {
                              id: "1",
                              content: "Research",
                              status: "completed",
                            },
                            {
                              id: "2",
                              content: "Write report",
                              status: "in_progress",
                            },
                            {
                              id: "3",
                              content: "Review",
                              status: "pending",
                            },
                          ],
                        },
                      },
                    ],
                  }),
                },
              ],
            };
          }
          if (callCount === 2) {
            return {
              generations: [
                {
                  text: "",
                  message: new AIMessage({
                    content: "",
                    tool_calls: [
                      {
                        id: writeCallId,
                        name: "write_file",
                        args: {
                          file_path: "/report.md",
                          content: "# Report\n\nResearch completed...",
                        },
                      },
                    ],
                  }),
                },
              ],
            };
          }
          throw new ConnectionError(
            "ECONNRESET after 6 retries (all retry attempts exhausted)",
          );
        },
      );

      const model = new FakeListChatModel({ responses: ["Done"] });
      const agent = createDeepAgent({ model });

      await expect(
        agent.invoke({
          messages: [new HumanMessage("Write a report on AI safety")],
        }),
      ).rejects.toThrow("ECONNRESET");

      // 3 model calls: 2 succeeded + 1 failed (after retries exhausted)
      expect(callCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe("Scenario 5: Checkpointer alone is not sufficient", () => {
    it("checkpointer saves state but no auto-resume after failure", async () => {
      /**
       * Reproduction: Even with MemorySaver:
       * - State IS checkpointed after each successful step
       * - But when the error propagates, no auto-recovery occurs
       * - The user must catch the error, wait, and re-invoke manually
       *
       * LangGraph has `retryPolicy` support in its runner, but
       * `createDeepAgent` does not configure it. Adding a retryPolicy
       * could solve this at the graph execution level.
       */
      const writeCallId = `call_write_${Date.now()}`;
      const checkpointer = new MemorySaver();
      const threadId = `recovery-test-${Date.now()}`;

      let callCount = 0;
      vi.spyOn(FakeListChatModel.prototype, "_generate").mockImplementation(
        async function () {
          callCount++;
          if (callCount === 1) {
            return {
              generations: [
                {
                  text: "",
                  message: new AIMessage({
                    content: "",
                    tool_calls: [
                      {
                        id: writeCallId,
                        name: "write_file",
                        args: {
                          file_path: "/progress.md",
                          content: "# Progress\n\nStep 1 complete.",
                        },
                      },
                    ],
                  }),
                },
              ],
            };
          }
          throw new ConnectionError(
            "ECONNREFUSED after 6 retries (all retry attempts exhausted)",
          );
        },
      );

      const model = new FakeListChatModel({ responses: ["Done"] });
      const agent = createDeepAgent({ model, checkpointer });

      // Agent crashes despite checkpointer
      await expect(
        agent.invoke(
          { messages: [new HumanMessage("Write a report")] },
          { configurable: { thread_id: threadId }, recursionLimit: 50 },
        ),
      ).rejects.toThrow("ECONNREFUSED");

      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Scenario 6: Streaming crash after tool call", () => {
    it("stream throws when connection drops after tool execution", async () => {
      /**
       * Reproduction: In CLI streaming mode, the stream creation for the
       * second model call fails after retries. The stream throws mid-iteration.
       *
       * Note: LangChain's `createStreamWithRetry` retries stream creation,
       * but if a stream fails MID-STREAM (during chunk iteration), no retry
       * occurs at all. This test simulates stream creation failure.
       */
      const todoCallId = `call_${Date.now()}`;

      let callCount = 0;
      vi.spyOn(FakeListChatModel.prototype, "_generate").mockImplementation(
        async function () {
          callCount++;
          if (callCount === 1) {
            return {
              generations: [
                {
                  text: "",
                  message: new AIMessage({
                    content: "",
                    tool_calls: [
                      {
                        id: todoCallId,
                        name: "write_todos",
                        args: {
                          todos: [
                            {
                              id: "1",
                              content: "Step 1",
                              status: "in_progress",
                            },
                          ],
                        },
                      },
                    ],
                  }),
                },
              ],
            };
          }
          throw new ConnectionError(
            "ENOTFOUND after 6 retries (all retry attempts exhausted)",
          );
        },
      );

      const model = new FakeListChatModel({ responses: ["Done"] });
      const agent = createDeepAgent({ model });

      const streamPromise = async () => {
        const stream = await agent.graph.stream(
          { messages: [new HumanMessage("Help me write code")] },
          { streamMode: ["updates"] },
        );
        for await (const _chunk of stream) {
          // Will throw when second model call fails
        }
      };

      await expect(streamPromise()).rejects.toThrow("ENOTFOUND");
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Scenario 7: User-level retry workaround", () => {
    it("users must build their own retry wrapper around agent.invoke()", async () => {
      /**
       * This demonstrates the workaround users need today.
       *
       * The proper fix could be any of:
       * 1. Configure LangGraph's `retryPolicy` in `createDeepAgent`
       * 2. Add a retry middleware via `wrapModelCall`
       * 3. Document the `maxRetries` model parameter prominently
       * 4. Provide an `invokeWithRetry` helper
       */
      let attempt = 0;

      async function invokeWithRetry(
        maxRetries: number,
        backoffMs: number,
      ): Promise<any> {
        for (let i = 0; i <= maxRetries; i++) {
          vi.restoreAllMocks();

          const spy = vi.spyOn(FakeListChatModel.prototype, "_generate");

          if (attempt === 0) {
            spy.mockRejectedValue(new APITimeoutError());
          } else {
            spy.mockResolvedValue({
              generations: [
                {
                  text: "Task completed successfully",
                  message: new AIMessage({
                    content: "Task completed successfully",
                  }),
                },
              ],
            });
          }

          const model = new FakeListChatModel({ responses: ["Done"] });
          const agent = createDeepAgent({ model });

          try {
            return await agent.invoke({
              messages: [new HumanMessage("Do a task")],
            });
          } catch {
            attempt++;
            if (i === maxRetries) throw new Error("Max retries exceeded");
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }
        }
      }

      const result = await invokeWithRetry(3, 10);
      expect(result).toBeDefined();
      expect(attempt).toBe(1);
    });
  });
});
