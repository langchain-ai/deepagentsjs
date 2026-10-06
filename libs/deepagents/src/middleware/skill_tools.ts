/**
 * Disclose the tools a skill names once its `SKILL.md` has been read.
 *
 * The skills middleware owns the behaviour; this module holds the pieces it is
 * built from: which reads of a `SKILL.md` count, how the include names a skill
 * lists resolve to tools and which of those are disclosed, where the
 * disclosure goes in the conversation, and the provider-native blocks that
 * carry each tool's definition.
 *
 * An include name is one entry in a skill's `metadata.include_tools`: a tool's
 * exact name, or a name a resolver maps to tools.
 *
 * @internal
 */

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Runnable, RunnableBinding } from "@langchain/core/runnables";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { isInteropZodSchema } from "@langchain/core/utils/types";
import type { ModelRequest, Runtime } from "langchain";

import { ConfigurationError } from "../errors.js";

/** `SKILL.md` frontmatter `metadata` key listing the skill's include names, space-separated. */
export const INCLUDE_TOOLS_KEY = "include_tools";

/** Tool `extras` key (and provider field) that withholds a tool's schema until searched for. */
const DEFER_LOADING = "defer_loading";

/**
 * Model ID prefixes that accept an inline `tool_definition` mid-conversation.
 *
 * `@langchain/anthropic` sends any mid-conversation system message in place,
 * without gating on the model, so this list is the only guard.
 */
const ANTHROPIC_INLINE_TOOL_MODELS = [
  "claude-opus-5",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-4-8",
];

/** Model ID prefixes whose Responses API accepts an `additional_tools` input item. */
const OPENAI_INLINE_TOOL_MODELS = ["gpt-6-", "gpt-5.6-"];

/** Root `input_schema` keys the Anthropic API rejects, failing the whole request. */
const ANTHROPIC_ROOT_COMBINATORS = ["oneOf", "anyOf", "allOf"] as const;

/** `extras` keys `ChatAnthropic` copies into a tool's definition, bar the ones a disclosure must never carry. */
const ANTHROPIC_DEFINITION_EXTRAS = [
  "input_examples",
  "allowed_callers",
  "strict",
] as const;

/**
 * Return the skill tools that one `metadata.include_tools` name stands for.
 *
 * A resolver lets a skill list tools whose real names are only known at
 * runtime, such as generated MCP tool names, and lets one name stand for a
 * family of tools. It's called with the name and the agent's `runtime`, on
 * every model call while a read of a skill listing that name stays in context,
 * and again before one of its tools runs. It may return the tools or a
 * promise of them.
 *
 * - Return the same tools for the same name within a thread, or the prompt
 *   cache breaks: a change moves bytes at a position that has already been
 *   sent.
 * - Keep it cheap, or cache, since it runs on every model call.
 * - One resolver serves every thread, so scope any cache by what the tools
 *   depend on, usually something in `runtime.context`.
 * - Names are resolved concurrently, so cache the pending promise, not only
 *   its result.
 * - Exceptions propagate out of the model call or tool call. To degrade
 *   gracefully, catch inside the resolver and return `[]`.
 *
 * A name that exactly matches a tool already in the request is claimed by that
 * tool and never passed to the resolver.
 *
 * @example
 * ```typescript
 * // e.g. every tool on a Linear MCP connection, whatever their generated names
 * const resolveSkillTools: SkillToolResolver<{ workspaceId: string }> = async (
 *   name,
 *   runtime,
 * ) => (await toolsForWorkspace(runtime.context.workspaceId))[name] ?? [];
 *
 * createSkillsMiddleware({ backend, sources: ["/skills/"], tools: resolveSkillTools });
 * ```
 */
export type SkillToolResolver<TContext = unknown> = (
  name: string,
  runtime: Runtime<TContext>,
) => readonly ClientTool[] | Promise<readonly ClientTool[]>;

/** A resolver whose output {@link callSkillToolResolver} has yet to check. */
type UncheckedResolver = (name: string, runtime: Runtime<unknown>) => unknown;

/**
 * Return the resolver the skills middleware's `tools` option stands for.
 *
 * A list is validated, then resolved by exact name.
 *
 * @throws {ConfigurationError} If `tools` is neither a list nor a function,
 *   or a list entry isn't a client tool or repeats a name.
 */
export function toSkillToolResolver(tools: unknown): UncheckedResolver {
  if (tools != null && !Array.isArray(tools)) {
    if (typeof tools !== "function") {
      throw new ConfigurationError(
        `tools must be an array of tools or a resolver function, got ${describeType(tools)}; wrap a single tool in an array`,
        "SKILL_TOOLS_UNSUPPORTED_TYPE",
      );
    }
    return tools as UncheckedResolver;
  }
  const entries: unknown[] = tools ?? [];
  if (!entries.every(isClientTool)) {
    throw new ConfigurationError(
      "tools entries must be client tools; provider-native tool objects are not supported",
      "SKILL_TOOLS_UNSUPPORTED_TYPE",
    );
  }
  const names = entries.map((t) => t.name);
  const duplicates = [
    ...new Set(names.filter((n, i) => names.indexOf(n) !== i)),
  ].sort();
  if (duplicates.length > 0) {
    throw new ConfigurationError(
      `tools contains duplicate tool name(s): ${duplicates.join(", ")}`,
      "SKILL_TOOLS_DUPLICATE_NAME",
    );
  }
  const byName = new Map(entries.map((t) => [t.name, t]));
  return (name) => (byName.has(name) ? [byName.get(name)] : []);
}

/** Whether `value` is a runnable client tool rather than a provider-native or plain object. */
function isClientTool(value: unknown): value is ClientTool {
  return Runnable.isRunnable(value) && typeof value.name === "string";
}

/**
 * Call `resolver` for one include name, keeping the first of each tool name.
 *
 * @throws {TypeError} If the resolver returns something other than an array
 *   of client tools.
 */
export async function callSkillToolResolver(
  resolver: UncheckedResolver,
  includeName: string,
  runtime: Runtime<unknown>,
): Promise<ClientTool[]> {
  const result = await resolver(includeName, runtime);
  if (!Array.isArray(result)) {
    throw new TypeError(
      `skill tool resolver must return an array of tools for '${includeName}', got ${describeType(result)}`,
    );
  }
  const tools = new Map<string, ClientTool>();
  for (const item of result) {
    if (!isClientTool(item)) {
      throw new TypeError(
        `skill tool resolver returned a ${describeType(item)} for '${includeName}'; expected tool instances`,
      );
    }
    if (!tools.has(item.name)) tools.set(item.name, item);
  }
  return [...tools.values()];
}

/** Describe `value`'s type for an error message: its class name, or `typeof` for anything plainer. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return typeof value;
  const ctor = (value as { constructor?: { name?: unknown } }).constructor
    ?.name;
  return typeof ctor === "string" && ctor !== "" && ctor !== "Object"
    ? ctor
    : "plain object";
}

/** A successful `read_file` of a `SKILL.md` that lists tools. */
export interface SkillRead {
  /** Index of the read's tool result in the request's messages. */
  index: number;
  /** The skill's name. */
  skillName: string;
  /** The entries of the skill's `metadata.include_tools`, in frontmatter order. */
  includeNames: string[];
}

/**
 * Return every successful `read_file` of a `SKILL.md` that lists tools, in
 * message order.
 *
 * Any `offset` or `limit` counts, and so does a result whose content was later
 * truncated or compacted, since only the call and the result's status are read.
 */
export function findSkillReads(
  messages: readonly BaseMessage[],
  skills: readonly {
    name: string;
    path: string;
    metadata?: Record<string, string>;
  }[],
): SkillRead[] {
  const skillsByPath = new Map<string, Omit<SkillRead, "index">>();
  for (const skill of skills) {
    const value = skill.metadata?.[INCLUDE_TOOLS_KEY];
    const includeNames =
      typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
    const path = normalizePath(skill.path);
    if (path !== undefined && includeNames.length > 0) {
      skillsByPath.set(path, { skillName: skill.name, includeNames });
    }
  }
  if (skillsByPath.size === 0) return [];
  const readPaths = new Map<string, unknown>();
  for (const message of messages) {
    if (!AIMessage.isInstance(message)) continue;
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.name === "read_file" && toolCall.id) {
        readPaths.set(
          toolCall.id,
          toolCall.args?.file_path ?? toolCall.args?.path,
        );
      }
    }
  }
  const reads: SkillRead[] = [];
  messages.forEach((message, index) => {
    // A backend read error comes back as `Error: …` text, without an error status.
    if (
      !ToolMessage.isInstance(message) ||
      message.status === "error" ||
      message.text.startsWith("Error:")
    ) {
      return;
    }
    const path = normalizePath(readPaths.get(message.tool_call_id));
    const skill = path === undefined ? undefined : skillsByPath.get(path);
    if (skill !== undefined) reads.push({ index, ...skill });
  });
  return reads;
}

/**
 * Normalize `path` as the Python SDK's `validate_path` does, or return
 * `undefined` if it is invalid.
 *
 * Backslashes become slashes, empty and `.` segments are dropped, and a
 * relative path is made absolute. A `..` segment, a leading `~` or a Windows
 * drive makes the path invalid.
 */
function normalizePath(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const segments = path.replaceAll("\\", "/").split("/");
  if (
    segments.includes("..") ||
    path.startsWith("~") ||
    /^[a-zA-Z]:/.test(path)
  ) {
    return undefined;
  }
  return `/${segments.filter((s) => s !== "" && s !== ".").join("/")}`;
}

/** A tool as it appears in `request.tools`: a tool instance, or a plain or provider-native object. */
type RequestTool = ClientTool | ServerTool;

/** A tool whose definition a disclosure can carry: a tool instance, or tool search's plain stand-in. */
type DisclosableTool = {
  name: string;
  description?: string;
  schema?: unknown;
  extras?: Record<string, unknown>;
};

/** A tool one model call discloses. */
interface DisclosedTool {
  /** The request's own entry for a deferred request tool, otherwise the skill tool. */
  tool: RequestTool;
  /** Index of the earliest skill read producing the tool; the disclosure is placed after it. */
  anchor: number;
  /**
   * The include name that produced a skill tool, for the tool-time lookup.
   * Absent for a deferred request tool, which is never gated.
   */
  includeName?: string;
}

/** Return a request tool's name, whether it is a tool instance or a provider object. */
function toolName(tool: RequestTool): string | undefined {
  const { name, function: fn } = tool as {
    name?: unknown;
    function?: { name?: unknown };
  };
  if (typeof name === "string") return name;
  return typeof fn?.name === "string" ? fn.name : undefined;
}

/**
 * Disclose the tools the read skills' include names produce to one model call.
 *
 * Returns the request to send, and the record of the skill tools it
 * discloses, for the tool-time gate.
 */
export async function discloseSkillTools<
  TRequest extends ModelRequest<any, any>,
>(
  request: TRequest,
  reads: readonly SkillRead[],
  resolver: UncheckedResolver,
): Promise<{ request: TRequest; record: Record<string, string> }> {
  // The last of a repeated name wins, as in the Python SDK.
  const requestTools = new Map<string, RequestTool>();
  for (const tool of request.tools) {
    const name = toolName(tool);
    if (name !== undefined) requestTools.set(name, tool);
  }
  // A name a request tool claims is never passed to the resolver.
  const names = [
    ...new Set(
      reads.flatMap((read) =>
        read.includeNames.filter((name) => !requestTools.has(name)),
      ),
    ),
  ];
  const tools = await Promise.all(
    names.map((name) => callSkillToolResolver(resolver, name, request.runtime)),
  );
  const resolved = new Map(names.map((name, i) => [name, tools[i]]));
  const disclosed = planDisclosure(reads, requestTools, resolved);
  if (disclosed.size === 0) return { request, record: {} };

  const chatModel = await resolveChatModel(request.model, request.runtime);
  if (llmType(chatModel) === "anthropic") {
    withholdRootCombinatorTools(disclosed);
  }
  const gatedNames = [...disclosed.keys()]
    .filter((name) => disclosed.get(name)!.includeName !== undefined)
    .sort();
  const record = Object.fromEntries(
    gatedNames.map((name) => [name, disclosed.get(name)!.includeName!]),
  );
  if (disclosed.size === 0) return { request, record };
  const build = inlineBlockBuilder(chatModel);
  if (build !== undefined) {
    return {
      request: {
        ...request,
        messages: discloseInMessages(request.messages, disclosed, build),
      },
      record,
    };
  }
  return {
    request: {
      ...request,
      tools: discloseInTools(request.tools, disclosed, gatedNames),
    },
    record,
  };
}

/**
 * Classify what each read skill's include names produce, anchoring each tool
 * at the earliest read producing it.
 *
 * An include name that matches a request tool's name produces that tool; any
 * other produces what the resolver returned for it. A produced tool whose name
 * a request tool has wins as that request tool, because it's the one that
 * runs: a deferred one is disclosed early, and a bound one adds nothing, since
 * the model already sees it. Tools are matched by name, never by identity,
 * because outer middleware such as tool search replaces the request's tools
 * with copies.
 */
function planDisclosure(
  reads: readonly SkillRead[],
  requestTools: ReadonlyMap<string, RequestTool>,
  resolved: ReadonlyMap<string, readonly ClientTool[]>,
): Map<string, DisclosedTool> {
  const disclosed = new Map<string, DisclosedTool>();
  const unresolved = new Set<string>();
  for (const { index, skillName, includeNames } of reads) {
    for (const includeName of includeNames) {
      const claimed = requestTools.get(includeName);
      const produced =
        claimed !== undefined ? [claimed] : (resolved.get(includeName) ?? []);
      if (produced.length === 0 && !unresolved.has(includeName)) {
        unresolved.add(includeName);
        // oxlint-disable-next-line no-console
        console.debug(
          `Skill '${skillName}' names tool '${includeName}', which is not available in this request`,
        );
      }
      for (const tool of produced) {
        const name = toolName(tool);
        if (name === undefined || disclosed.has(name)) continue;
        const entry = requestTools.get(name);
        if (entry === undefined) {
          disclosed.set(name, { tool, anchor: index, includeName });
        } else if (
          (entry as DisclosableTool).extras?.[DEFER_LOADING] === true
        ) {
          disclosed.set(name, { tool: entry, anchor: index });
        }
      }
    }
  }
  return disclosed;
}

/**
 * Withhold each disclosed tool whose root input schema uses `oneOf`, `anyOf`
 * or `allOf`, which the Anthropic API rejects, failing the whole request, in
 * `tools` and inline alike. Withholding it on every path keeps the record
 * equal to what the model was shown.
 */
function withholdRootCombinatorTools(
  disclosed: Map<string, DisclosedTool>,
): void {
  for (const [name, { tool }] of disclosed) {
    const schema = anthropicDefinition(tool as DisclosableTool).input_schema;
    const keys = ANTHROPIC_ROOT_COMBINATORS.filter(
      (key) =>
        typeof schema === "object" &&
        schema !== null &&
        Object.prototype.hasOwnProperty.call(schema, key),
    );
    if (keys.length > 0) {
      // oxlint-disable-next-line no-console
      console.warn(
        `Not disclosing tool '${name}': its input_schema has a top-level ${keys.join("/")}, which the Anthropic API does not support`,
      );
      disclosed.delete(name);
    }
  }
}

/**
 * Insert one `SystemMessage` per insertion point, carrying the tools anchored
 * there, for models that accept tool definitions mid-conversation.
 *
 * Each message lands at the same index with the same bytes on every call while
 * its anchor stays visible, so the provider's cached prefix survives.
 */
function discloseInMessages(
  messages: readonly BaseMessage[],
  disclosed: ReadonlyMap<string, DisclosedTool>,
  build: BlockBuilder,
): BaseMessage[] {
  const namesByIndex = new Map<number, string[]>();
  for (const [name, { anchor }] of disclosed) {
    // Insert after the anchor's tool-result batch and any user messages queued
    // behind it: Anthropic needs a system message after a user turn and before
    // an assistant turn, and OpenAI needs it to keep its position. An empty
    // reply is skipped too, because Anthropic drops it.
    let index = anchor + 1;
    while (index < messages.length) {
      const message = messages[index];
      const emptyReply =
        AIMessage.isInstance(message) &&
        message.content.length === 0 &&
        !message.tool_calls?.length;
      if (
        !ToolMessage.isInstance(message) &&
        !HumanMessage.isInstance(message) &&
        !emptyReply
      ) {
        break;
      }
      index += 1;
    }
    namesByIndex.set(index, [...(namesByIndex.get(index) ?? []), name]);
  }
  const result = [...messages];
  // Indexes were computed against the unmodified list, so insert back to front.
  for (const index of [...namesByIndex.keys()].sort((a, b) => b - a)) {
    const blocks = namesByIndex
      .get(index)!
      .sort()
      .map((name) => build(disclosed.get(name)!.tool as DisclosableTool));
    // Authored in `content`: the standard-content path drops provider-native blocks.
    result.splice(index, 0, new SystemMessage({ content: blocks as never }));
  }
  return result;
}

/**
 * Return `requestTools` with deferred disclosures undeferred and skill tools
 * appended, for models that can't take tool definitions mid-conversation.
 *
 * A deferred tool is replaced by a plain spec rather than a copy: `createAgent`
 * rejects a request that swaps a registered tool for another instance of the
 * same name, and doesn't validate plain objects.
 */
function discloseInTools(
  requestTools: readonly RequestTool[],
  disclosed: ReadonlyMap<string, DisclosedTool>,
  gatedNames: readonly string[],
): RequestTool[] {
  const tools = requestTools.map((tool): RequestTool => {
    const name = toolName(tool);
    const entry = name === undefined ? undefined : disclosed.get(name);
    if (entry?.tool !== tool || entry.includeName !== undefined) return tool;
    const { description, schema, extras = {} } = tool as DisclosableTool;
    const { [DEFER_LOADING]: _deferLoading, ...rest } = extras;
    return { name, description, schema, extras: rest };
  });
  return [...tools, ...gatedNames.map((name) => disclosed.get(name)!.tool)];
}

/** Return the model inside a `bind()` / `withConfig()` wrapper; chained calls merge into one. */
function unwrapBinding(model: unknown): unknown {
  return RunnableBinding.isRunnableBinding(model) ? model.bound : model;
}

/**
 * Return the concrete chat model a request will call.
 *
 * Resolves a `ConfigurableModel`, which a string `model` always becomes, to
 * the instance it will call with this run's `configurable`. Without
 * configurable overrides that's the instance cached at creation: the instance
 * cache is keyed on the whole config, so passing `configurable`
 * unconditionally would build one per thread.
 */
async function resolveChatModel(
  model: unknown,
  runtime: Runtime<unknown>,
): Promise<unknown> {
  const current = unwrapBinding(model) as {
    _queuedMethodOperations?: unknown;
    _getModelInstance?: (config?: object) => Promise<unknown>;
    _modelParams?: (config: object) => Record<string, unknown>;
  };
  // Duck-typed as langchain's own (unexported) `isConfigurableModel`.
  if (
    current?._queuedMethodOperations === undefined ||
    typeof current._getModelInstance !== "function"
  ) {
    return current;
  }
  const configurable = runtime.configurable ?? {};
  const overrides = current._modelParams?.({ configurable }) ?? {};
  const instance =
    Object.keys(overrides).length > 0
      ? await current._getModelInstance({ configurable })
      : await current._getModelInstance();
  return unwrapBinding(instance);
}

/** Return a chat model's `_llmType()`, which tells providers apart. */
function llmType(model: unknown): string | undefined {
  const fn = (model as { _llmType?: () => string } | null)?._llmType;
  return typeof fn === "function" ? fn.call(model) : undefined;
}

/** Builds the provider-native block that makes one tool callable from its position on. */
type BlockBuilder = (tool: DisclosableTool) => Record<string, unknown>;

/**
 * Return how `chatModel` is given a tool mid-conversation, or `undefined` if
 * it can't be.
 *
 * The one place that decides support, so a model-profile capability can
 * replace the allowlists later.
 */
function inlineBlockBuilder(chatModel: unknown): BlockBuilder | undefined {
  const { model: name, useResponsesApi } = chatModel as {
    model?: unknown;
    useResponsesApi?: unknown;
  };
  if (typeof name !== "string") return undefined;
  const type = llmType(chatModel);
  if (
    type === "anthropic" &&
    ANTHROPIC_INLINE_TOOL_MODELS.some((prefix) => name.startsWith(prefix))
  ) {
    return anthropicToolAddition;
  }
  // `_llmType()` tells `ChatOpenAI` apart from `AzureChatOpenAI`. Only an
  // explicit `useResponsesApi`: a `ChatOpenAI` that routes to the Responses
  // API on its own takes the fallback, which costs the cache but can't send
  // `additional_tools` on Chat Completions.
  if (
    type === "openai" &&
    useResponsesApi === true &&
    OPENAI_INLINE_TOOL_MODELS.some((prefix) => name.startsWith(prefix))
  ) {
    return openaiAdditionalTools;
  }
  return undefined;
}

/**
 * Return the definition `ChatAnthropic` sends in `tools` for `tool`, without
 * `defer_loading` (a deferred definition would stay withheld) or
 * `cache_control` (a stray marker uses up a breakpoint).
 */
function anthropicDefinition(tool: DisclosableTool): Record<string, unknown> {
  const definition: Record<string, unknown> = {
    name: tool.name,
    description: tool.description,
    input_schema: isInteropZodSchema(tool.schema)
      ? toJsonSchema(tool.schema)
      : tool.schema,
  };
  for (const key of ANTHROPIC_DEFINITION_EXTRAS) {
    if (tool.extras?.[key] !== undefined) definition[key] = tool.extras[key];
  }
  return definition;
}

/** Build the Anthropic `tool_addition` block carrying `tool`'s full definition. */
function anthropicToolAddition(tool: DisclosableTool): Record<string, unknown> {
  return {
    type: "tool_addition",
    tool: { type: "tool_definition", definition: anthropicDefinition(tool) },
  };
}

/** Build the OpenAI Responses `additional_tools` item carrying `tool`'s function schema. */
function openaiAdditionalTools(tool: DisclosableTool): Record<string, unknown> {
  const { function: fn } = convertToOpenAITool(tool as never);
  const { [DEFER_LOADING]: _deferLoading, ...definition } = {
    type: "function",
    ...fn,
  } as Record<string, unknown>;
  return { type: "additional_tools", role: "developer", tools: [definition] };
}
