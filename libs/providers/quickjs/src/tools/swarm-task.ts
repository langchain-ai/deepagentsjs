import { z } from "zod/v4";
import {
  createAgent,
  tool,
  anthropicPromptCachingMiddleware,
  type ReactAgent,
  type AgentMiddleware,
  StructuredTool,
} from "langchain";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import { initChatModel } from "langchain/chat_models/universal";
import {
  isAnthropicModel,
  createSummarizationMiddleware,
  createPatchToolCallsMiddleware,
  createCacheBreakpointMiddleware,
  type AnyBackendProtocol,
  type BackendFactory,
} from "deepagents";

/**
 * Dispatch mode for swarm task invocations.
 *
 * - `"agent"` — Full agentic loop with tools and middleware.
 * - `"invoke"` — Direct model invocation with no tools or agentic loop.
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

  /**
   * Additional middleware appended after the default middleware stack.
   */
  middleware?: AgentMiddleware[];
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
  subagents?: SwarmSubAgent[];

  /**
   * Default model used for subagents that don't specify their own,
   * and for `invoke` mode direct model calls.
   */
  defaultModel: LanguageModelLike | string;

  /**
   * Backend for the summarization middleware. When provided, subagents
   * receive summarization middleware that auto-compresses conversation
   * history as token limits are approached. When omitted, summarization
   * is skipped.
   */
  backend?: AnyBackendProtocol | BackendFactory;
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

  /**
   * Middleware stack applied to this subagent.
   */
  middleware: AgentMiddleware[];
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
 * stored in a TTL cache keyed by `subagentType::normalizedSchema`.
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
 * Build the default middleware stack for a swarm subagent.
 *
 * Always includes patch-tool-calls. Conditionally includes summarization
 * (when a backend is provided) and Anthropic prompt caching (when the
 * resolved model is an Anthropic model).
 */
function buildMiddleware(opts: {
  model: LanguageModelLike | string;
  backend?: AnyBackendProtocol | BackendFactory;
  subagentMiddleware?: AgentMiddleware[];
}): AgentMiddleware[] {
  const { model, backend, subagentMiddleware = [] } = opts;

  // Cast needed because the quickjs and deepagents packages may resolve
  // different @langchain/core versions in the monorepo, making their
  // LanguageModelLike / BaseLanguageModel types nominally incompatible.
  const anthropic = isAnthropicModel(
    model as Parameters<typeof isAnthropicModel>[0],
  );

  const cacheMiddleware: AgentMiddleware[] = anthropic
    ? [
        anthropicPromptCachingMiddleware({
          unsupportedModelBehavior: "ignore",
          minMessagesToCache: 1,
        }),
        createCacheBreakpointMiddleware() as AgentMiddleware,
      ]
    : [];

  return [
    ...(backend
      ? [createSummarizationMiddleware({ backend }) as AgentMiddleware]
      : []),
    createPatchToolCallsMiddleware() as AgentMiddleware,
    ...subagentMiddleware,
    ...cacheMiddleware,
  ];
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
 * import { createSwarmTaskTool, createREPLMiddleware } from "@langchain/quickjs";
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
  const { subagents = [], defaultModel, backend } = options;

  const compiled = new Map<string, CompiledAgent>();

  for (const sub of subagents) {
    const effectiveModel = sub.model ?? defaultModel;

    const middleware = buildMiddleware({
      model: effectiveModel,
      backend,
      subagentMiddleware: sub.middleware,
    });

    const spec: AgentSpec = {
      model: effectiveModel,
      systemPrompt: sub.systemPrompt,
      tools: sub.tools ?? [],
      name: sub.name,
      middleware,
    };

    compiled.set(sub.name, {
      agent: createAgent({ ...spec }),
      spec,
    });
  }

  const subagentNames = subagents.map((s) => s.name);
  const variantCache = new VariantCache<ReactAgent | Runnable>();

  return tool(
    async (input: {
      description: string;
      subagent_type?: string;
      response_schema?: Record<string, unknown>;
      mode?: SwarmTaskMode;
    }): Promise<string> => {
      const {
        description,
        subagent_type: subagentType,
        response_schema: responseSchema,
        mode = "agent",
      } = input;

      if (mode === "invoke") {
        return invokeModel(defaultModel, description, responseSchema);
      }

      if (!subagentType) {
        throw new Error(
          "agent mode requires subagent_type. " +
            `Available: ${subagentNames.join(", ")}`,
        );
      }

      const entry = compiled.get(subagentType);

      if (!entry) {
        throw new Error(
          `Unknown swarm subagent type "${subagentType}". ` +
            `Available: ${subagentNames.join(", ")}`,
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
