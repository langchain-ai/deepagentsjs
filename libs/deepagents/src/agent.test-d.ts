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
import {
  createAgent,
  createMiddleware,
  InferAgentMiddleware,
  SystemMessage,
  toolStrategy,
  providerStrategy,
} from "langchain";
import { z } from "zod/v4";
import { createDeepAgent } from "./agent.js";
import type {
  MergedDeepAgentState,
  InferSubagentByName,
  InferDeepAgentSubagents,
  InferCompiledSubagents,
  InferRegularSubagents,
} from "./types.js";
import type { FilesRecordUpdate } from "./middleware/fs.js";

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

const MemoryStateSchema = z.object({
  memorySystem: z.string().default(""),
});

const MemoryMiddleware = createMiddleware({
  name: "MemoryMiddleware",
  stateSchema: MemoryStateSchema,
});

describe("createDeepAgent types", () => {
  it("should allow systemPrompt to be a string or SystemMessage", () => {
    createDeepAgent({
      systemPrompt: "Hello, world!",
    });
    createDeepAgent({
      systemPrompt: new SystemMessage({
        content: [
          {
            type: "text",
            text: "Hello, world!",
          },
        ],
      }),
    });
  });

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
      // should have built-in state
      expectTypeOf(result).toHaveProperty("files");
      expectTypeOf(result.files).toEqualTypeOf<FilesRecordUpdate | undefined>();
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

  describe("DeepAgent type", () => {
    it("should correctly infer the type of the agent", () => {
      const agent = createDeepAgent({});
      expectTypeOf(agent).toHaveProperty("~deepAgentTypes");
      expectTypeOf(agent["~deepAgentTypes"]).toHaveProperty("Subagents");
      expectTypeOf(agent["~deepAgentTypes"].Subagents).toEqualTypeOf<
        readonly []
      >();
    });

    it("can infer the type of the subagent", () => {
      const _agent = createDeepAgent({
        subagents: [
          {
            name: "Subagent1",
            description: "Subagent1 description",
            systemPrompt: "Subagent1 system prompt",
            middleware: [CounterMiddleware],
          },
        ],
      });
      const subagent1 = {} as InferSubagentByName<typeof _agent, "Subagent1">;
      expectTypeOf(subagent1).toHaveProperty("name");
      expectTypeOf(subagent1.name).toEqualTypeOf<"Subagent1">();
      expectTypeOf(subagent1).toHaveProperty("description");
      expectTypeOf(
        subagent1.description,
      ).toEqualTypeOf<"Subagent1 description">();
      expectTypeOf(
        subagent1.systemPrompt,
      ).toEqualTypeOf<"Subagent1 system prompt">();
    });

    it("can infer the type of a createAgent sub agent", () => {
      const _agent = createDeepAgent({
        subagents: [
          {
            name: "Subagent2",
            description: "Subagent2 description",
            systemPrompt: "Subagent2 system prompt",
          },
          {
            name: "Subagent1",
            description: "Subagent1 description",
            runnable: createAgent({
              name: "Subagent1",
              model: "claude-sonnet-4-20250514",
              description: "Subagent1 description",
              systemPrompt: "Subagent1 system prompt",
              middleware: [MemoryMiddleware],
            }),
          },
        ],
      });

      const subagent1 = {} as InferSubagentByName<typeof _agent, "Subagent1">;
      expectTypeOf(subagent1).toHaveProperty("name");
      expectTypeOf(subagent1.name).toEqualTypeOf<"Subagent1">();
      expectTypeOf(subagent1).toHaveProperty("description");
      expectTypeOf(
        subagent1.description,
      ).toEqualTypeOf<"Subagent1 description">();

      // InferDeepAgentSubagents returns the full subagents tuple
      type AllSubagents = InferDeepAgentSubagents<typeof _agent>;
      expectTypeOf<AllSubagents[0]>().toHaveProperty("systemPrompt");
      expectTypeOf<AllSubagents[1]>().toHaveProperty("runnable");

      // InferCompiledSubagents extracts only subagents with `runnable`
      type Compiled = InferCompiledSubagents<typeof _agent>;
      expectTypeOf<Compiled>().toHaveProperty("runnable");
      expectTypeOf<Compiled["name"]>().toEqualTypeOf<"Subagent1">();

      type CompiledMiddleware = InferAgentMiddleware<Compiled["runnable"]>;
      expectTypeOf<CompiledMiddleware[0]>().toHaveProperty("stateSchema");
      expectTypeOf<CompiledMiddleware[0]["stateSchema"]>().toExtend<
        typeof MemoryStateSchema | undefined
      >();

      // InferRegularSubagents extracts only subagents without `runnable`
      type Regular = InferRegularSubagents<typeof _agent>;
      expectTypeOf<Regular>().toHaveProperty("systemPrompt");
      expectTypeOf<Regular["name"]>().toEqualTypeOf<"Subagent2">();
    });
  });

  describe("responseFormat", () => {
    it("should infer the type of the response format", async () => {
      const schema = z.object({
        name: z.string(),
      });
      const agent = createDeepAgent({
        responseFormat: providerStrategy(schema),
      });
      const result = await agent.invoke({ messages: [] });
      expectTypeOf(result).toHaveProperty("structuredResponse");
      expectTypeOf(result.structuredResponse).toEqualTypeOf<
        z.infer<typeof schema>
      >();
    });

    it("should infer the type of the response format with tool strategy", async () => {
      const schema = z.object({
        name: z.string(),
      });
      const agent = createDeepAgent({
        responseFormat: toolStrategy(schema),
      });
      const result = await agent.invoke({ messages: [] });
      expectTypeOf(result).toHaveProperty("structuredResponse");
      expectTypeOf(result.structuredResponse).toEqualTypeOf<
        z.infer<typeof schema>
      >();
    });

    it("should infer multiple tool response formats as enum", async () => {
      const schema1 = z.object({
        foo: z.string(),
      });
      const schema2 = z.object({
        bar: z.string(),
      });
      const agent = createDeepAgent({
        responseFormat: toolStrategy([schema1, schema2]),
      });
      const result = await agent.invoke({ messages: [] });
      expectTypeOf(result).toHaveProperty("structuredResponse");
      expectTypeOf(result.structuredResponse).toEqualTypeOf<
        z.infer<typeof schema1> | z.infer<typeof schema2>
      >();
    });
  });
});
