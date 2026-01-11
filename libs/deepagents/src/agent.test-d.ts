/**
 * Type tests for createDeepAgent
 *
 * These tests verify that the type inference works correctly for:
 * - Custom middleware state schemas
 * - Combined state from multiple middleware
 *
 * NOTE: These tests use actual invoke() calls to verify the runtime type inference
 * is correct, not just ReturnType<typeof agent.invoke>.
 */

import { describe, it, expectTypeOf } from "vitest";
import { createMiddleware } from "langchain";
import { z } from "zod/v4";
import { createDeepAgent } from "./agent.js";
import type { MergedDeepAgentState } from "./types.js";
import type { FileData } from "./backends/protocol.js";

// Test middleware with research state
const ResearchStateSchema = z.object({
  research: z
    .string()
    .default("")
    .meta({
      reducer: {
        fn: (left: string, right: string | null) => right || left || "",
        schema: z.string().nullable(),
      },
    }),
});

const ResearchMiddleware = createMiddleware({
  name: "ResearchMiddleware",
  stateSchema: ResearchStateSchema,
});

// Test middleware with counter state
const CounterStateSchema = z.object({
  counter: z
    .number()
    .default(0)
    .meta({
      reducer: {
        fn: (left: number, right: number | null) =>
          right !== null ? right : left,
        schema: z.number().nullable(),
      },
    }),
});

const CounterMiddleware = createMiddleware({
  name: "CounterMiddleware",
  stateSchema: CounterStateSchema,
});

describe("createDeepAgent type inference", () => {
  describe("MergedDeepAgentState helper type", () => {
    it("should correctly merge middleware states", () => {
      type TestMiddleware = readonly [
        typeof ResearchMiddleware,
        typeof CounterMiddleware,
      ];
      type TestSubagents = readonly [];

      type MergedState = MergedDeepAgentState<TestMiddleware, TestSubagents>;

      // Should include research from ResearchMiddleware
      expectTypeOf<MergedState>().toHaveProperty("research");
      expectTypeOf<MergedState["research"]>().toEqualTypeOf<string>();

      // Should include counter from CounterMiddleware
      expectTypeOf<MergedState>().toHaveProperty("counter");
      expectTypeOf<MergedState["counter"]>().toEqualTypeOf<number>();
    });
  });

  describe("createDeepAgent return type using actual invoke", () => {
    it("should infer state from custom middleware and subagents middleware", async () => {
      const agent = createDeepAgent({
        middleware: [ResearchMiddleware],
        subagents: [
          {
            name: "Subagent1",
            description: "Subagent1 description",
            systemPrompt: "Subagent1 system prompt",
            middleware: [CounterMiddleware],
          },
        ],
      });

      // Use actual invoke call to check type inference
      const result = await agent.invoke({ messages: [] });

      // The result should include the research property typed as string
      expectTypeOf(result).toHaveProperty("research");
      expectTypeOf(result.research).toEqualTypeOf<string>();
      expectTypeOf(result).toHaveProperty("counter");
      expectTypeOf(result.counter).toEqualTypeOf<number>();
      expectTypeOf(result).toHaveProperty("files");
      expectTypeOf(result.files).toEqualTypeOf<Record<string, FileData>>();
      expectTypeOf(result).toHaveProperty("todos");
      expectTypeOf(result.todos).toEqualTypeOf<
        {
          content: string;
          status: "pending" | "in_progress" | "completed";
        }[]
      >();

      // Should also have messages
      expectTypeOf(result).toHaveProperty("messages");
    });

    it("should infer state from multiple middleware", async () => {
      const agent = createDeepAgent({
        middleware: [ResearchMiddleware, CounterMiddleware],
      });

      const result = await agent.invoke({ messages: [] });

      // Should have both research and counter with correct types
      expectTypeOf(result).toHaveProperty("research");
      expectTypeOf(result.research).toEqualTypeOf<string>();

      expectTypeOf(result).toHaveProperty("counter");
      expectTypeOf(result.counter).toEqualTypeOf<number>();
    });

    it("should work with no custom middleware", async () => {
      const agent = createDeepAgent({});

      const result = await agent.invoke({ messages: [] });

      // Should have messages
      expectTypeOf(result).toHaveProperty("messages");
    });

    it("should infer research as string not any", async () => {
      const agent = createDeepAgent({
        middleware: [ResearchMiddleware],
      });

      const result = await agent.invoke({ messages: [] });

      // Verify research is specifically string, not any
      expectTypeOf(result.research).not.toBeAny();
      expectTypeOf(result.research).toBeString();
    });
  });
});
