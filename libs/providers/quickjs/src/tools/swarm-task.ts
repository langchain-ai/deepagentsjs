import { z } from "zod/v4";
import { createAgent, tool, type ReactAgent, StructuredTool } from "langchain";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { initChatModel } from "langchain/chat_models/universal";
import type { SubagentPoolRef } from "deepagents";

/**
 * Dispatch mode for swarm task invocations.
 *
 * - `"agent"` — Full agentic loop with tools and middleware.
 * - `"invoke"` — Direct model invocation with no tools or agentic loop.
 */
export type SwarmTaskMode = "agent" | "invoke";

/**
 * Options for creating a swarm task tool.
 */
export interface SwarmTaskToolOptions {
  /**
   * Mutable reference to the main agent's subagent pool.
   *
   * Starts as `{ current: null }` and is populated by `createDeepAgent`
   * during agent construction. The tool lazily compiles agents from
   * these specs on first invocation.
   */
  subagentPool: SubagentPoolRef;
}

/**
 * Compiled agent alongside its creation spec, so schema-constrained
 * variants can be rebuilt per-run.
 */
interface CompiledAgent {
  /**
   * The compiled agent graph for `agent` mode without a response schema.
   */
  agent: ReactAgent | Runnable;

  /**
   * Preserved creation params for recompilation with `responseFormat`.
   */
  spec: AgentSpec;
}

/**
 * Minimal agent creation parameters preserved for recompilation.
 *
 * When a `response_schema` is provided at dispatch time, the tool
 * recompiles the agent with `responseFormat` set to the normalized
 * schema.
 */
interface AgentSpec {
  model: LanguageModelLike | string;
  systemPrompt: string;
  tools: StructuredTool[];
  name: string;
  middleware: unknown[];
}

const VARIANT_TTL_MS = 60_000;

/**
 * TTL cache for compiled agent variants.
 *
 * Stores values keyed by string with a last-accessed timestamp. On every
 * `getOrCreate` call, entries that haven't been accessed within `ttlMs`
 * are swept first. Cache hits refresh the timestamp, so entries stay
 * warm as long as they're actively used.
 *
 * Exported for direct unit testing — not part of the public API.
 *
 * @internal
 */
export class VariantCache<T> {
  private entries = new Map<string, { value: T; lastAccessed: number }>();
  private ttlMs: number;

  constructor(ttlMs: number = VARIANT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Return a cached value or create one via `factory` on cache miss.
   *
   * Sweeps expired entries before lookup. Cache hits refresh the
   * last-accessed timestamp.
   */
  getOrCreate(key: string, factory: () => T): T {
    this.sweep();

    const cached = this.entries.get(key);

    if (cached) {
      cached.lastAccessed = Date.now();
      return cached.value;
    }

    const value = factory();
    this.entries.set(key, { value, lastAccessed: Date.now() });

    return value;
  }

  /**
   * Number of entries currently in the cache (including not-yet-swept expired ones).
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Remove entries that haven't been accessed within the TTL window.
   */
  private sweep(): void {
    const now = Date.now();

    for (const [key, entry] of this.entries) {
      if (now - entry.lastAccessed > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }
}

async function invokeModel(
  model: LanguageModelLike | string,
  description: string,
  responseSchema: Record<string, unknown> | undefined,
): Promise<string> {
  const resolved =
    typeof model === "string" ? await initChatModel(model) : model;

  const messages = [new HumanMessage({ content: description })];

  if (responseSchema) {
    return invokeWithStructuredOutput(resolved, messages, responseSchema);
  }

  const result = await resolved.invoke(messages);

  if (typeof result === "string") {
    return result;
  }

  if (result != null && typeof result === "object" && "text" in result) {
    return String(result.text);
  }

  return JSON.stringify(result);
}

async function invokeWithStructuredOutput(
  model: LanguageModelLike,
  messages: HumanMessage[],
  responseSchema: Record<string, unknown>,
): Promise<string> {
  if (
    !("withStructuredOutput" in model) ||
    typeof model.withStructuredOutput !== "function"
  ) {
    throw new Error(
      "invoke mode with response_schema requires a model that supports withStructuredOutput().",
    );
  }

  const structuredModel = model.withStructuredOutput(responseSchema);
  const result = await structuredModel.invoke(messages);
  return JSON.stringify(result);
}

/**
 * Full agentic invocation — compiles a schema-constrained variant and
 * runs the agent loop.
 *
 * When `response_schema` is provided, the agent is compiled with
 * `responseFormat` set to the normalized schema. Compiled variants are
 * stored in a TTL cache keyed by `name::schemaJSON`.
 * Within a `run()`, all rows hit the cache so the agent is compiled
 * exactly once. After the run completes, the entry expires after
 * `VARIANT_TTL_MS` of inactivity.
 */
async function invokeAgent(
  entry: CompiledAgent,
  description: string,
  responseSchema: Record<string, unknown> | undefined,
  variantCache: VariantCache<ReactAgent | Runnable>,
): Promise<string> {
  let agent = entry.agent;

  if (responseSchema) {
    if (responseSchema.type !== "object") {
      throw new Error(
        `response_schema must have type: "object", got: ${JSON.stringify(responseSchema.type)}`,
      );
    }
    const schema = { ...responseSchema, type: "object" as const };
    const cacheKey = `${entry.spec.name}::${JSON.stringify(schema)}`;

    agent = variantCache.getOrCreate(cacheKey, () =>
      createAgent({
        ...entry.spec,
        responseFormat: schema,
      }),
    );
  }

  const state = {
    messages: [new HumanMessage({ content: description })],
  };

  const result = (await agent.invoke(state)) as Record<string, unknown>;

  if (result.structuredResponse != null) {
    return JSON.stringify(result.structuredResponse);
  }

  const messages = result.messages as BaseMessage[];
  const lastMessage = messages?.[messages.length - 1];

  if (!lastMessage) {
    return "Task completed";
  }

  return lastMessage.text;
}

/**
 * Compile pool specs into agent entries on first invocation.
 *
 * Called lazily because the pool is populated by `createDeepAgent`
 * after the swarm task tool is created.
 */
function compilePoolSpecs(
  pool: NonNullable<SubagentPoolRef["current"]>,
): Map<string, CompiledAgent> {
  const compiled = new Map<string, CompiledAgent>();

  for (const spec of pool.specs) {
    const agentSpec: AgentSpec = {
      model: spec.model,
      systemPrompt: spec.systemPrompt,
      tools: spec.tools as StructuredTool[],
      name: spec.name,
      middleware: spec.middleware,
    };

    compiled.set(spec.name, {
      agent: createAgent({ ...agentSpec }),
      spec: agentSpec,
    });
  }

  return compiled;
}

/**
 * Create a PTC-only tool for swarm subagent dispatch.
 *
 * The returned tool is designed to be passed directly into the REPL
 * middleware's `ptc` array. It is never exposed to the LLM — only
 * callable from QuickJS skill code via `tools.swarmTask()`.
 *
 * Subagent specs are provided via a {@link SubagentPoolRef} that is
 * populated by `createDeepAgent` during agent construction. The tool
 * lazily compiles agents from these specs on first invocation.
 *
 * Supports two dispatch modes:
 * - `agent` (default): Full agentic loop with tools. Schema-constrained
 *   agents are cached with a TTL — 500 rows with the same schema
 *   compile the agent exactly once, and the entry expires after 60s
 *   of inactivity once the run completes.
 * - `invoke`: Direct model call with structured output. No tools, no
 *   iteration. Ideal for classification and extraction tasks.
 *
 * @param options - Pool ref for subagent specs.
 * @returns A `StructuredToolInterface` suitable for the `ptc` config.
 */
export function createSwarmTaskTool(
  options: SwarmTaskToolOptions,
): StructuredToolInterface {
  const { subagentPool } = options;

  let compiled: Map<string, CompiledAgent> | null = null;
  const variantCache = new VariantCache<ReactAgent | Runnable>();

  return tool(
    async (input: {
      description: string;
      subagent_type?: string;
      response_schema?: Record<string, unknown>;
      mode?: SwarmTaskMode;
    }): Promise<string> => {
      const pool = subagentPool.current;
      if (!pool) {
        throw new Error(
          "Swarm subagent pool not initialized. " +
            "Ensure subagents are configured on createDeepAgent.",
        );
      }

      const {
        description,
        subagent_type: subagentType,
        response_schema: responseSchema,
        mode = "agent",
      } = input;

      if (mode === "invoke") {
        return invokeModel(pool.model, description, responseSchema);
      }

      // Lazy-compile pool specs on first agent-mode dispatch
      if (!compiled) {
        compiled = compilePoolSpecs(pool);
      }

      if (!subagentType) {
        throw new Error(
          "agent mode requires subagent_type. " +
            `Available: ${[...compiled.keys()].join(", ")}`,
        );
      }

      const entry = compiled.get(subagentType);

      if (!entry) {
        throw new Error(
          `Unknown swarm subagent type "${subagentType}". ` +
            `Available: ${[...compiled.keys()].join(", ")}`,
        );
      }

      return invokeAgent(entry, description, responseSchema, variantCache);
    },
    {
      name: "swarm_task",
      description:
        "Dispatch a task to a swarm subagent. Supports agent mode " +
        "(full agentic loop) and invoke mode (direct model call).",
      schema: z.object({
        description: z
          .string()
          .describe("The task to execute with the selected subagent."),
        subagent_type: z
          .string()
          .optional()
          .describe("Name of the subagent to dispatch to."),
        response_schema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "JSON Schema (type: 'object') for structured output. " +
              "Properties become columns on the swarm table row.",
          ),
        mode: z
          .enum(["agent", "invoke"])
          .optional()
          .describe(
            'Dispatch mode. "agent" (default) runs a full agentic loop ' +
              'with tools. "invoke" makes a single model call with no tools — ' +
              "use for classification, extraction, and labeling.",
          ),
      }),
    },
  );
}
