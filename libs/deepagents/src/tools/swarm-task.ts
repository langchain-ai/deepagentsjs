import { z } from "zod/v4";
import {
  createAgent,
  tool,
  SystemMessage,
  type ReactAgent,
  StructuredTool,
} from "langchain";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { HumanMessage } from "@langchain/core/messages";

/**
 * Default time-to-live for cached schema-constrained agent variants.
 *
 * Entries are evicted when they haven't been accessed for this duration.
 * Within a `run()`, rows keep hitting the cache so entries stay warm.
 * After the run finishes, nobody accesses the entry and it expires on
 * the next cache access.
 */
const VARIANT_TTL_MS = 60_000;

/**
 * Dispatch mode for swarm task invocations.
 *
 * - `"agent"` — Full agentic loop with tools and middleware. Use for tasks
 *   that need to read files, call APIs, or iterate on intermediate results.
 * - `"invoke"` — Direct model invocation with no tools or agentic loop.
 *   Use for simple classification, extraction, or labeling tasks where a
 *   single model call with structured output is sufficient.
 */
export type SwarmTaskMode = "agent" | "invoke";

/**
 * Subagent specification for swarm dispatch targets.
 *
 * These subagents are owned by the swarm task tool and are independent
 * of the main agent's subagent pool. They are only reachable via
 * `tools.swarmTask()` from QuickJS skill code.
 */
export interface SwarmSubAgent {
  /**
   * Identifier used to select this subagent in swarm dispatch calls.
   */
  name: string;

  /**
   * Human-readable description of what this subagent does.
   */
  description: string;

  /**
   * System prompt injected at the start of the subagent's conversation.
   */
  systemPrompt: string;

  /**
   * Tools available to this subagent. Defaults to an empty array.
   */
  tools?: StructuredTool[];

  /**
   * Model override for this subagent. Falls back to the tool's `defaultModel`.
   */
  model?: LanguageModelLike | string;
}

/**
 * Options for creating a swarm task tool.
 */
export interface SwarmTaskToolOptions {
  /**
   * Subagent specifications for swarm dispatch targets.
   *
   * Each entry becomes a dispatch target selectable via the `subagent_type`
   * parameter. These subagents are private to the swarm tool — they do not
   * appear in the main agent's `task` tool.
   */
  subagents: SwarmSubAgent[];

  /**
   * Default model used for subagents that don't specify their own,
   * and for `invoke` mode direct model calls.
   */
  defaultModel: LanguageModelLike | string;
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
 * schema. This interface captures the fields needed for that
 * recompilation.
 */
interface AgentSpec {
  /**
   * Language model used by this subagent.
   */
  model: LanguageModelLike | string;

  /**
   * System prompt injected at the start of the subagent's conversation.
   */
  systemPrompt: string;

  /**
   * Tools available to this subagent during execution.
   */
  tools: StructuredTool[];

  /**
   * Unique name identifying this subagent type.
   */
  name: string;
}

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
   *
   * @param key - Cache key (e.g. `"subagentName::normalizedSchemaJSON"`).
   * @param factory - Called exactly once on cache miss to produce the value.
   * @returns The cached or newly created value.
   */
  getOrCreate(key: string, factory: () => T): T {
    const now = Date.now();

    for (const [k, entry] of this.entries) {
      if (now - entry.lastAccessed > this.ttlMs) {
        this.entries.delete(k);
      }
    }

    const cached = this.entries.get(key);
    if (cached) {
      cached.lastAccessed = now;
      return cached.value;
    }

    const value = factory();
    this.entries.set(key, { value, lastAccessed: now });
    return value;
  }

  /**
   * Number of entries currently in the cache (including not-yet-swept expired ones).
   */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Recursively add `additionalProperties: false` to every object-typed node
 * in a JSON Schema.
 */
export function normalizeSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.type !== "object" && schema.type !== "array") {
    return schema;
  }

  if (schema.type === "array") {
    const result: Record<string, unknown> = { ...schema };
    const items = result.items;
    if (items != null && typeof items === "object" && !Array.isArray(items)) {
      result.items = normalizeSchema(items as Record<string, unknown>);
    }
    return result;
  }

  const result: Record<string, unknown> = {
    ...schema,
    additionalProperties: false,
  };

  const props = schema.properties;
  if (props != null && typeof props === "object" && !Array.isArray(props)) {
    const normalizedProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (v != null && typeof v === "object" && !Array.isArray(v)) {
        normalizedProps[k] = normalizeSchema(v as Record<string, unknown>);
      } else {
        normalizedProps[k] = v;
      }
    }
    result.properties = normalizedProps;
  }

  return result;
}

/**
 * Direct model invocation — single LLM call with optional structured output.
 *
 * Resolves the model from the agent spec, builds a minimal message array,
 * and calls `model.invoke()` directly. No tools, no agentic loop.
 *
 * @param spec - Agent spec providing the model and system prompt.
 * @param description - The user-facing task description.
 * @param responseSchema - Optional JSON Schema to constrain the response.
 * @returns The model's response as a string.
 */
async function invokeModel(
  spec: AgentSpec,
  description: string,
  responseSchema: Record<string, unknown> | undefined,
): Promise<string> {
  const messages = [
    new SystemMessage({ content: spec.systemPrompt }),
    new HumanMessage({ content: description }),
  ];

  const model = spec.model;

  if (typeof model === "string") {
    throw new Error(
      "invoke mode requires a model instance, not a string identifier. " +
        `Got "${model}" for subagent "${spec.name}".`,
    );
  }

  if (responseSchema) {
    const normalized = normalizeSchema(responseSchema);
    if (normalized.type !== "object") {
      throw new Error(
        `response_schema must have type: "object", got: ${JSON.stringify(normalized.type)}`,
      );
    }

    if (
      typeof (model as unknown as Record<string, unknown>)
        .withStructuredOutput === "function"
    ) {
      const boundModel = (model as any).withStructuredOutput(normalized);
      const result = await boundModel.invoke(messages);
      return JSON.stringify(result);
    }

    throw new Error(
      `invoke mode with response_schema requires a model that supports ` +
        `withStructuredOutput(). Subagent "${spec.name}" does not.`,
    );
  }

  const result = await model.invoke(messages);

  if (typeof result === "string") {
    return result;
  }

  if (result && typeof result === "object" && "content" in result) {
    const content = result.content;
    if (typeof content === "string") {
      return content;
    }
    return JSON.stringify(content);
  }

  return JSON.stringify(result);
}

/**
 * Full agentic invocation — compiles a schema-constrained variant and
 * runs the agent loop.
 *
 * When `response_schema` is provided, the agent is compiled with
 * `responseFormat` set to the normalized schema. Compiled variants are
 * stored in a TTL cache keyed by `subagentType::normalizedSchema`. Within
 * a `run()`, all rows hit the cache so the agent is compiled exactly
 * once. After the run completes, the entry expires after `VARIANT_TTL_MS`
 * of inactivity.
 *
 * @param entry - Compiled agent and its preserved spec.
 * @param description - The user-facing task description.
 * @param responseSchema - Optional JSON Schema to constrain the response.
 * @param variantCache - TTL cache shared across invocations of this tool.
 * @returns The agent's final response as a string.
 */
async function invokeAgent(
  entry: CompiledAgent,
  description: string,
  responseSchema: Record<string, unknown> | undefined,
  variantCache: VariantCache<ReactAgent | Runnable>,
): Promise<string> {
  let agent = entry.agent;

  if (responseSchema) {
    const normalized = normalizeSchema(responseSchema);
    if (normalized.type !== "object") {
      throw new Error(
        `response_schema must have type: "object", got: ${JSON.stringify(normalized.type)}`,
      );
    }

    const cacheKey = `${entry.spec.name}::${JSON.stringify(normalized)}`;
    agent = variantCache.getOrCreate(cacheKey, () =>
      createAgent({
        ...entry.spec,
        responseFormat: normalized as {
          type: "object";
          [key: string]: unknown;
        },
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

  const messages = result.messages as Array<{ content: string | unknown[] }>;
  const lastMessage = messages?.[messages.length - 1];
  if (!lastMessage) {
    return "Task completed";
  }

  const content = lastMessage.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" && block !== null && "text" in block
          ? (block as { text: string }).text
          : JSON.stringify(block),
      )
      .join("\n");
  }

  return JSON.stringify(content);
}

/**
 * Create a PTC-only tool for swarm subagent dispatch.
 *
 * The returned tool is designed to be passed directly into the REPL
 * middleware's `ptc` array. It is never exposed to the LLM — only
 * callable from QuickJS skill code via `tools.swarmTask()`.
 *
 * Supports two dispatch modes:
 * - `agent` (default): Full agentic loop with tools. Schema-constrained
 *   agents are cached with a TTL — 500 rows with the same schema
 *   compile the agent exactly once, and the entry expires after 60s
 *   of inactivity once the run completes.
 * - `invoke`: Direct model call with structured output. No tools, no
 *   iteration. Ideal for classification and extraction tasks.
 *
 * @param options - Subagent specs and default model configuration.
 * @returns A `StructuredToolInterface` suitable for the `ptc` config.
 *
 * @example
 * ```typescript
 * import { createSwarmTaskTool } from "@langchain/deepagents/tools/swarm-task";
 * import { createREPLMiddleware } from "@langchain/quickjs";
 *
 * const swarmTask = createSwarmTaskTool({
 *   subagents: [
 *     { name: "screener", description: "Classifier", systemPrompt: "..." },
 *   ],
 *   defaultModel: "anthropic:claude-haiku-4-5-20251001",
 * });
 *
 * const replMiddleware = createREPLMiddleware({
 *   ptc: [swarmTask],
 * });
 * ```
 */
export function createSwarmTaskTool(
  options: SwarmTaskToolOptions,
): StructuredToolInterface {
  const { subagents, defaultModel } = options;

  const compiled = new Map<string, CompiledAgent>();

  for (const sub of subagents) {
    const spec: AgentSpec = {
      model: sub.model ?? defaultModel,
      systemPrompt: sub.systemPrompt,
      tools: sub.tools ?? [],
      name: sub.name,
    };
    compiled.set(sub.name, {
      agent: createAgent({ ...spec }),
      spec,
    });
  }

  const subagentNames = subagents.map((s) => s.name);

  const variantCache = new VariantCache<ReactAgent | Runnable>();

  return tool(
    async (
      input: {
        description: string;
        subagent_type: string;
        response_schema?: Record<string, unknown>;
        mode?: SwarmTaskMode;
      },
      _config,
    ): Promise<string> => {
      const {
        description,
        subagent_type,
        response_schema,
        mode = "agent",
      } = input;

      const entry = compiled.get(subagent_type);
      if (!entry) {
        throw new Error(
          `Unknown swarm subagent type "${subagent_type}". ` +
            `Available: ${subagentNames.join(", ")}`,
        );
      }

      if (mode === "invoke") {
        return invokeModel(entry.spec, description, response_schema);
      }

      return invokeAgent(entry, description, response_schema, variantCache);
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
          .describe(
            `Name of the swarm subagent to use. Available: ${subagentNames.join(", ")}`,
          ),
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
