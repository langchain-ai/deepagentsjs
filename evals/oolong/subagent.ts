import { BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { Runnable, RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { getCurrentTaskInput } from "@langchain/langgraph";
import { createDeepAgent, type CreateDeepAgentParams } from "deepagents";
import { tool } from "langchain";
import { z } from "zod/v4";

/**
 * Configuration for the local `subagent` PTC tool.
 */
export interface SubagentToolOptions {
  /**
   * Base deep-agent configuration used to build delegated agents.
   *
   * `middleware`, `subagents`, and `responseFormat` are ignored by this tool.
   */
  agentConfig?: Omit<
    Partial<CreateDeepAgentParams>,
    "middleware" | "subagents" | "responseFormat"
  >;

  /**
   * TTL for compiled response-schema variants in milliseconds.
   * @default 60_000
   */
  variantTtlMs?: number;

  /**
   * Logical name used for tracing metadata.
   * @default "general-purpose"
   */
  agentName?: string;
}

const DEFAULT_VARIANT_TTL_MS = 60_000;
const DEFAULT_AGENT_NAME = "general-purpose";

const EXCLUDED_STATE_KEYS = [
  "messages",
  "todos",
  "structuredResponse",
  "skillsMetadata",
  "memoryContents",
];

/**
 * Filter parent state before handing off to delegated agents.
 */
function filterStateForSubagent(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!EXCLUDED_STATE_KEYS.includes(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Small TTL cache for compiled agent variants.
 */
class VariantCache<T> {
  private entries = new Map<string, { value: T; lastAccessed: number }>();

  constructor(private ttlMs: number) {}

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

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastAccessed > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }
}

function createDelegatedAgent(
  baseConfig: Omit<
    Partial<CreateDeepAgentParams>,
    "middleware" | "subagents" | "responseFormat"
  >,
  responseSchema?: Record<string, unknown>,
): Runnable {
  const params = {
    ...baseConfig,
    ...(responseSchema ? { responseFormat: responseSchema } : {}),
  } as unknown as CreateDeepAgentParams;
  return (createDeepAgent as any)(params) as Runnable;
}

async function invokeAgent(
  baseConfig: Omit<
    Partial<CreateDeepAgentParams>,
    "middleware" | "subagents" | "responseFormat"
  >,
  description: string,
  responseSchema: Record<string, unknown> | undefined,
  variantCache: VariantCache<Runnable>,
  config: RunnableConfig,
  agentName: string,
): Promise<string> {
  let schema = responseSchema;
  if (schema != null) {
    if (schema.type !== "object") {
      throw new Error(
        `response_schema must have type: "object", got: ${JSON.stringify(schema.type)}`,
      );
    }
    schema = { ...schema, type: "object" as const };
  }

  const cacheKey = schema ? JSON.stringify(schema) : "__base__";
  const agent = variantCache.getOrCreate(cacheKey, () =>
    createDelegatedAgent(baseConfig, schema),
  );

  let currentState: Record<string, unknown>;
  try {
    currentState = getCurrentTaskInput<Record<string, unknown>>() ?? {};
  } catch {
    currentState = {};
  }

  const subagentState = filterStateForSubagent(currentState);
  subagentState.messages = [new HumanMessage({ content: description })];

  const subagentConfig = {
    ...config,
    metadata: {
      ...(config.metadata ?? {}),
      lc_agent_name: agentName,
    },
    configurable: {
      ...(config.configurable ?? {}),
      ls_agent_type: "subagent",
    },
  };

  const result = (await agent.invoke(subagentState, subagentConfig)) as Record<
    string,
    unknown
  >;

  if (result.structuredResponse != null) {
    return JSON.stringify(result.structuredResponse);
  }

  const messages = result.messages as BaseMessage[];
  const lastMessage = messages?.[messages.length - 1];

  if (!lastMessage) {
    return "Task completed";
  }

  if (typeof lastMessage.text === "string") {
    return lastMessage.text;
  }

  if (lastMessage.text != null) {
    return String(lastMessage.text);
  }

  return "Task completed";
}

/**
 * Create a `subagent` tool for QuickJS PTC.
 *
 * This mirrors `swarm_task` behavior but delegates to a single deepagents
 * general-purpose agent instead of resolving from a subagent pool.
 */
export function createSubagentTool(
  options: SubagentToolOptions = {},
): StructuredToolInterface {
  const baseConfig = options.agentConfig ?? {};
  const variantCache = new VariantCache<Runnable>(
    options.variantTtlMs ?? DEFAULT_VARIANT_TTL_MS,
  );
  const agentName = options.agentName ?? DEFAULT_AGENT_NAME;

  return tool(
    async (
      input: {
        description: string;
        response_schema?: Record<string, unknown>;
        subagent_type?: string;
      },
      config: RunnableConfig,
    ): Promise<string> => {
      const { description, response_schema: responseSchema } = input;

      return invokeAgent(
        baseConfig,
        description,
        responseSchema,
        variantCache,
        config,
        agentName,
      );
    },
    {
      name: "subagent",
      description:
        "Dispatch a task to a delegated general-purpose deepagent with a full agentic loop.",
      schema: z.object({
        description: z
          .string()
          .describe("The task to execute with the delegated subagent."),
        response_schema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "JSON Schema (type: 'object') for structured output. " +
              "Properties become columns on the result row.",
          ),
        subagent_type: z.string().optional().describe("general-purpose"),
      }),
    },
  );
}
