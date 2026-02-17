/* eslint-disable no-console */
/**
 * Summarization middleware with backend support for conversation history offloading.
 *
 * This module extends the base LangChain summarization middleware with additional
 * backend-based features for persisting conversation history before summarization.
 *
 * ## Usage
 *
 * ```typescript
 * import { createSummarizationMiddleware } from "@anthropic/deepagents";
 * import { FilesystemBackend } from "@anthropic/deepagents";
 *
 * const backend = new FilesystemBackend({ rootDir: "/data" });
 *
 * const middleware = createSummarizationMiddleware({
 *   model: "gpt-4o-mini",
 *   backend,
 *   trigger: { type: "fraction", value: 0.85 },
 *   keep: { type: "fraction", value: 0.10 },
 * });
 *
 * const agent = createDeepAgent({ middleware: [middleware] });
 * ```
 *
 * ## Storage
 *
 * Offloaded messages are stored as markdown at `/conversation_history/{thread_id}.md`.
 *
 * Each summarization event appends a new section to this file, creating a running log
 * of all evicted messages.
 *
 * ## Relationship to LangChain Summarization Middleware
 *
 * The base `summarizationMiddleware` from `langchain` provides core summarization
 * functionality. This middleware adds:
 * - Backend-based conversation history offloading
 * - Tool argument truncation for old messages
 *
 * For simple use cases without backend offloading, use `summarizationMiddleware`
 * from `langchain` directly.
 */

import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import {
  createMiddleware,
  countTokensApproximately,
  HumanMessage,
  AIMessage,
  ToolMessage,
  BaseMessage,
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { getBufferString } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { initChatModel } from "langchain/chat_models/universal";
import { Command } from "@langchain/langgraph";

import type { BackendProtocol, BackendFactory } from "../backends/protocol.js";
import type { StateBackend } from "../backends/state.js";
import type { BaseStore } from "@langchain/langgraph-checkpoint";

// Re-export the base summarization middleware from langchain for users who don't need backend offloading
export { summarizationMiddleware } from "langchain";

/**
 * Context size specification for summarization triggers and retention policies.
 */
export interface ContextSize {
  /** Type of context measurement */
  type: "messages" | "tokens" | "fraction";
  /** Threshold value */
  value: number;
}

/**
 * Settings for truncating large tool arguments in old messages.
 */
export interface TruncateArgsSettings {
  /**
   * Threshold to trigger argument truncation.
   * If not provided, truncation is disabled.
   */
  trigger?: ContextSize;

  /**
   * Context retention policy for message truncation.
   * Defaults to keeping last 20 messages.
   */
  keep?: ContextSize;

  /**
   * Maximum character length for tool arguments before truncation.
   * Defaults to 2000.
   */
  maxLength?: number;

  /**
   * Text to replace truncated arguments with.
   * Defaults to "...(argument truncated)".
   */
  truncationText?: string;
}

/**
 * Options for the summarization middleware.
 */
export interface SummarizationMiddlewareOptions {
  /**
   * The language model to use for generating summaries.
   * Can be a model string (e.g., "gpt-4o-mini") or a BaseChatModel instance.
   */
  model: string | BaseChatModel;

  /**
   * Backend instance or factory for persisting conversation history.
   */
  backend:
    | BackendProtocol
    | BackendFactory
    | ((config: { state: unknown; store?: BaseStore }) => StateBackend);

  /**
   * Threshold(s) that trigger summarization.
   * Can be a single ContextSize or an array for multiple triggers.
   */
  trigger?: ContextSize | ContextSize[];

  /**
   * Context retention policy after summarization.
   * Defaults to keeping last 20 messages.
   */
  keep?: ContextSize;

  /**
   * Prompt template for generating summaries.
   */
  summaryPrompt?: string;

  /**
   * Max tokens to include when generating summary.
   * Defaults to 4000.
   */
  trimTokensToSummarize?: number;

  /**
   * Path prefix for storing conversation history.
   * Defaults to "/conversation_history".
   */
  historyPathPrefix?: string;

  /**
   * Settings for truncating large tool arguments in old messages.
   * If not provided, argument truncation is disabled.
   */
  truncateArgsSettings?: TruncateArgsSettings;
}

// Default values
const DEFAULT_MESSAGES_TO_KEEP = 20;
const DEFAULT_TRIM_TOKEN_LIMIT = 4000;
const DEFAULT_SUMMARY_PROMPT = `You are a conversation summarizer. Your task is to create a concise summary of the conversation that captures:
1. The main topics discussed
2. Key decisions or conclusions reached
3. Any important context that would be needed for continuing the conversation

Keep the summary focused and informative. Do not include unnecessary details.

Conversation to summarize:
{conversation}

Summary:`;

/**
 * Zod schema for a summarization event that tracks what was summarized and
 * where the cutoff is.
 *
 * Instead of rewriting LangGraph state with `RemoveMessage(REMOVE_ALL_MESSAGES)`,
 * the middleware stores this event and uses it to reconstruct the effective message
 * list on subsequent calls.
 */
const SummarizationEventSchema = z.object({
  /**
   * The index in the state messages list where summarization occurred.
   * Messages before this index have been summarized. */
  cutoffIndex: z.number(),
  /** The HumanMessage containing the summary. */
  summaryMessage: z.instanceof(HumanMessage),
  /** Path where the conversation history was offloaded, or null if offload failed. */
  filePath: z.string().nullable(),
});

/**
 * Represents a summarization event that tracks what was summarized and where the cutoff is.
 */
export type SummarizationEvent = z.infer<typeof SummarizationEventSchema>;

/**
 * State schema for summarization middleware.
 */
const SummarizationStateSchema = z.object({
  /** Session ID for history file naming */
  _summarizationSessionId: z.string().optional(),
  /** Most recent summarization event (private state, not visible to agent) */
  _summarizationEvent: SummarizationEventSchema.optional(),
});

/**
 * Check if a message is a previous summarization message.
 * Summary messages are HumanMessage objects with lc_source='summarization' in additional_kwargs.
 */
function isSummaryMessage(msg: BaseMessage): boolean {
  if (!HumanMessage.isInstance(msg)) {
    return false;
  }
  return msg.additional_kwargs?.lc_source === "summarization";
}

/**
 * Estimate the token overhead from tool definition schemas.
 *
 * `countTokensApproximately` handles messages (including the system message when
 * prepended), but it does not accept tool definitions. This helper uses the same
 * chars/4 heuristic to approximate the tokens consumed by tool schemas.
 *
 * Matches the Python approach where `tools=request.tools` is passed to the
 * token counter — here we estimate separately because the JS token counter
 * does not accept a `tools` parameter.
 */
function estimateToolsOverhead(
  tools?: Array<{ name?: string; description?: string; schema?: unknown }>,
): number {
  if (!tools?.length) {
    return 0;
  }

  let chars = 0;
  for (const tool of tools) {
    chars += JSON.stringify({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
    }).length;
  }

  return Math.ceil(chars / 4);
}

const CONTENT_TRUNCATION_NOTICE =
  "\n\n...(content truncated to fit context window)";

/**
 * Emergency truncation of oversized individual messages when summarization
 * cannot reduce the message count (e.g., too few messages to cut).
 *
 * Iteratively truncates the largest string-content messages until the total
 * estimated token count fits within `maxTokens`.
 * Only ToolMessage and HumanMessage content is truncated; AIMessage content
 * is left intact to preserve tool_calls structure.
 *
 * @param messages - The agent messages (without system message)
 * @param systemMessage - The system message (included in token counting)
 * @param maxTokens - Hard token limit (e.g. model's maxInputTokens)
 * @param toolsOverhead - Estimated tokens from tool definitions
 */
function emergencyTruncateMessages(
  messages: BaseMessage[],
  systemMessage: BaseMessage | undefined,
  maxTokens: number,
  toolsOverhead: number,
): BaseMessage[] | null {
  const result = [...messages];

  function estimateTotal(): number {
    const counted = systemMessage != null ? [systemMessage, ...result] : result;
    return countTokensApproximately(counted) + toolsOverhead;
  }

  let totalTokens = estimateTotal();

  if (totalTokens <= maxTokens) {
    return null; // No truncation needed
  }

  // Iterate: find the largest truncatable message, halve it, repeat
  const MAX_ITERATIONS = 10;
  for (let iter = 0; iter < MAX_ITERATIONS && totalTokens > maxTokens; iter++) {
    let largestIdx = -1;
    let largestLen = 0;

    for (let i = 0; i < result.length; i++) {
      const msg = result[i];
      if (
        typeof msg.content === "string" &&
        msg.content.length > largestLen &&
        (ToolMessage.isInstance(msg) || HumanMessage.isInstance(msg))
      ) {
        largestIdx = i;
        largestLen = msg.content.length;
      }
    }

    // Nothing left to truncate
    if (
      largestIdx === -1 ||
      largestLen <= CONTENT_TRUNCATION_NOTICE.length * 2
    ) {
      break;
    }

    const msg = result[largestIdx];
    const content = msg.content as string;

    // Calculate how many chars to keep: target is to remove just enough
    const excess = totalTokens - maxTokens;
    const charsToRemove = Math.max(
      excess * 4, // convert tokens to chars
      content.length / 2, // at least halve
    );
    const newLength = Math.max(
      200, // keep at least some context
      content.length - charsToRemove,
    );
    const newContent =
      content.substring(0, newLength) + CONTENT_TRUNCATION_NOTICE;

    // Reconstruct message preserving its type and metadata
    if (ToolMessage.isInstance(msg)) {
      result[largestIdx] = new ToolMessage({
        content: newContent,
        tool_call_id: msg.tool_call_id,
        name: msg.name,
        additional_kwargs: msg.additional_kwargs,
      });
    } else {
      result[largestIdx] = new HumanMessage({
        content: newContent,
        additional_kwargs: msg.additional_kwargs,
      });
    }

    totalTokens = estimateTotal();
  }

  return totalTokens <= maxTokens ? result : null;
}

/**
 * Create summarization middleware with backend support for conversation history offloading.
 *
 * This middleware:
 * 1. Monitors conversation length against configured thresholds
 * 2. When triggered, offloads old messages to backend storage
 * 3. Generates a summary of offloaded messages
 * 4. Replaces old messages with the summary, preserving recent context
 *
 * @param options - Configuration options
 * @returns AgentMiddleware for summarization and history offloading
 */
export function createSummarizationMiddleware(
  options: SummarizationMiddlewareOptions,
) {
  const {
    model,
    backend,
    trigger,
    keep = { type: "messages", value: DEFAULT_MESSAGES_TO_KEEP },
    summaryPrompt = DEFAULT_SUMMARY_PROMPT,
    trimTokensToSummarize = DEFAULT_TRIM_TOKEN_LIMIT,
    historyPathPrefix = "/conversation_history",
    truncateArgsSettings,
  } = options;

  // Parse truncate settings
  const truncateTrigger = truncateArgsSettings?.trigger;
  const truncateKeep = truncateArgsSettings?.keep || {
    type: "messages" as const,
    value: 20,
  };
  const maxArgLength = truncateArgsSettings?.maxLength || 2000;
  const truncationText =
    truncateArgsSettings?.truncationText || "...(argument truncated)";

  // Session ID for this middleware instance (fallback if no thread_id)
  let sessionId: string | null = null;

  /**
   * Resolve backend from instance or factory.
   */
  function getBackend(state: unknown): BackendProtocol {
    if (typeof backend === "function") {
      return backend({ state }) as BackendProtocol;
    }
    return backend;
  }

  /**
   * Get or create session ID for history file naming.
   */
  function getSessionId(state: Record<string, unknown>): string {
    if (state._summarizationSessionId) {
      return state._summarizationSessionId as string;
    }
    if (!sessionId) {
      sessionId = `session_${uuidv4().substring(0, 8)}`;
    }
    return sessionId;
  }

  /**
   * Get the history file path.
   */
  function getHistoryPath(state: Record<string, unknown>): string {
    const id = getSessionId(state);
    return `${historyPathPrefix}/${id}.md`;
  }

  /**
   * Cached resolved model to avoid repeated initChatModel calls
   */
  let cachedModel: BaseChatModel | undefined = undefined;

  /**
   * Resolve the chat model.
   * Uses initChatModel to support any model provider from a string name.
   * The resolved model is cached for subsequent calls.
   */
  async function getChatModel(): Promise<BaseChatModel> {
    if (cachedModel) {
      return cachedModel;
    }

    if (typeof model === "string") {
      cachedModel = await initChatModel(model);
    } else {
      cachedModel = model;
    }
    return cachedModel;
  }

  /**
   * Get the max input tokens from the resolved model's profile.
   * Similar to Python's _get_profile_limits.
   */
  function getMaxInputTokens(resolvedModel: BaseChatModel): number | undefined {
    const profile = resolvedModel.profile;
    if (
      profile &&
      typeof profile === "object" &&
      "maxInputTokens" in profile &&
      typeof profile.maxInputTokens === "number"
    ) {
      return profile.maxInputTokens;
    }
    return undefined;
  }

  /**
   * Check if summarization should be triggered.
   */
  function shouldSummarize(
    messages: BaseMessage[],
    totalTokens: number,
    maxInputTokens?: number,
  ): boolean {
    if (!trigger) {
      return false;
    }

    const triggers = Array.isArray(trigger) ? trigger : [trigger];

    for (const t of triggers) {
      if (t.type === "messages" && messages.length >= t.value) {
        return true;
      }
      if (t.type === "tokens" && totalTokens >= t.value) {
        return true;
      }
      if (t.type === "fraction" && maxInputTokens) {
        const threshold = Math.floor(maxInputTokens * t.value);
        if (totalTokens >= threshold) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Determine cutoff index for messages to summarize.
   * Messages at index < cutoff will be summarized.
   * Messages at index >= cutoff will be preserved.
   */
  function determineCutoffIndex(
    messages: BaseMessage[],
    maxInputTokens?: number,
  ): number {
    if (keep.type === "messages") {
      if (messages.length <= keep.value) {
        return 0;
      }
      return messages.length - keep.value;
    }

    if (keep.type === "tokens" || keep.type === "fraction") {
      const targetTokenCount =
        keep.type === "fraction" && maxInputTokens
          ? Math.floor(maxInputTokens * keep.value)
          : keep.value;

      let tokensKept = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = countTokensApproximately([messages[i]]);
        if (tokensKept + msgTokens > targetTokenCount) {
          return i + 1;
        }
        tokensKept += msgTokens;
      }
      return 0;
    }

    return 0;
  }

  /**
   * Adjust a cutoff index to avoid orphaning ToolMessages.
   *
   * When the cutoff falls between an AIMessage (with tool_calls) and its
   * corresponding ToolMessages, the preserved messages would start with
   * orphaned ToolMessages. This breaks the API contract that every
   * tool_result must have a corresponding tool_use in the preceding message.
   *
   * Advances the cutoff past any leading ToolMessages to the next
   * non-ToolMessage (typically an AIMessage starting a new turn).
   */
  function adjustCutoffForToolMessages(
    messages: BaseMessage[],
    cutoffIndex: number,
  ): number {
    let adjusted = cutoffIndex;
    while (
      adjusted < messages.length &&
      ToolMessage.isInstance(messages[adjusted])
    ) {
      adjusted++;
    }
    return adjusted;
  }

  /**
   * Check if argument truncation should be triggered.
   */
  function shouldTruncateArgs(
    messages: BaseMessage[],
    totalTokens: number,
    maxInputTokens?: number,
  ): boolean {
    if (!truncateTrigger) {
      return false;
    }

    if (truncateTrigger.type === "messages") {
      return messages.length >= truncateTrigger.value;
    }
    if (truncateTrigger.type === "tokens") {
      return totalTokens >= truncateTrigger.value;
    }
    if (truncateTrigger.type === "fraction" && maxInputTokens) {
      const threshold = Math.floor(maxInputTokens * truncateTrigger.value);
      return totalTokens >= threshold;
    }

    return false;
  }

  /**
   * Determine cutoff index for argument truncation.
   */
  function determineTruncateCutoffIndex(
    messages: BaseMessage[],
    maxInputTokens?: number,
  ): number {
    if (truncateKeep.type === "messages") {
      if (messages.length <= truncateKeep.value) {
        return messages.length;
      }
      return messages.length - truncateKeep.value;
    }

    if (truncateKeep.type === "tokens" || truncateKeep.type === "fraction") {
      const targetTokenCount =
        truncateKeep.type === "fraction" && maxInputTokens
          ? Math.floor(maxInputTokens * truncateKeep.value)
          : truncateKeep.value;

      let tokensKept = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = countTokensApproximately([messages[i]]);
        if (tokensKept + msgTokens > targetTokenCount) {
          return i + 1;
        }
        tokensKept += msgTokens;
      }
      return 0;
    }

    return messages.length;
  }

  /**
   * Truncate large tool arguments in old messages.
   * Matches Python's _truncate_args(messages, system_message, tools).
   */
  function truncateArgs(
    messages: BaseMessage[],
    systemMessage: BaseMessage | undefined,
    tools:
      | Array<{ name?: string; description?: string; schema?: unknown }>
      | undefined,
    maxInputTokens?: number,
  ): { messages: BaseMessage[]; modified: boolean } {
    const countedMessages =
      systemMessage != null ? [systemMessage, ...messages] : messages;
    const totalTokens =
      countTokensApproximately(countedMessages) + estimateToolsOverhead(tools);
    if (!shouldTruncateArgs(messages, totalTokens, maxInputTokens)) {
      return { messages, modified: false };
    }

    const cutoffIndex = determineTruncateCutoffIndex(messages, maxInputTokens);
    if (cutoffIndex >= messages.length) {
      return { messages, modified: false };
    }

    const truncatedMessages: BaseMessage[] = [];
    let modified = false;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (i < cutoffIndex && AIMessage.isInstance(msg) && msg.tool_calls) {
        const truncatedToolCalls = msg.tool_calls.map((toolCall) => {
          const args = toolCall.args || {};
          const truncatedArgs: Record<string, unknown> = {};
          let toolModified = false;

          for (const [key, value] of Object.entries(args)) {
            if (
              typeof value === "string" &&
              value.length > maxArgLength &&
              (toolCall.name === "write_file" || toolCall.name === "edit_file")
            ) {
              truncatedArgs[key] = value.substring(0, 20) + truncationText;
              toolModified = true;
            } else {
              truncatedArgs[key] = value;
            }
          }

          if (toolModified) {
            modified = true;
            return { ...toolCall, args: truncatedArgs };
          }
          return toolCall;
        });

        if (modified) {
          const truncatedMsg = new AIMessage({
            content: msg.content,
            tool_calls: truncatedToolCalls,
            additional_kwargs: msg.additional_kwargs,
          });
          truncatedMessages.push(truncatedMsg);
        } else {
          truncatedMessages.push(msg);
        }
      } else {
        truncatedMessages.push(msg);
      }
    }

    return { messages: truncatedMessages, modified };
  }

  /**
   * Filter out previous summary messages.
   */
  function filterSummaryMessages(messages: BaseMessage[]): BaseMessage[] {
    return messages.filter((msg) => !isSummaryMessage(msg));
  }

  /**
   * Offload messages to backend.
   */
  async function offloadToBackend(
    resolvedBackend: BackendProtocol,
    messages: BaseMessage[],
    state: Record<string, unknown>,
  ): Promise<string | null> {
    const path = getHistoryPath(state);
    const filteredMessages = filterSummaryMessages(messages);

    const timestamp = new Date().toISOString();
    const newSection = `## Summarized at ${timestamp}\n\n${getBufferString(filteredMessages)}\n\n`;

    // Read existing content
    let existingContent = "";
    try {
      if (resolvedBackend.downloadFiles) {
        const responses = await resolvedBackend.downloadFiles([path]);
        if (
          responses.length > 0 &&
          responses[0].content &&
          !responses[0].error
        ) {
          existingContent = new TextDecoder().decode(responses[0].content);
        }
      }
    } catch {
      // File doesn't exist yet, that's fine
    }

    const combinedContent = existingContent + newSection;

    try {
      let result;
      if (existingContent) {
        result = await resolvedBackend.edit(
          path,
          existingContent,
          combinedContent,
        );
      } else {
        result = await resolvedBackend.write(path, combinedContent);
      }

      if (result.error) {
        console.warn(
          `Failed to offload conversation history to ${path}: ${result.error}`,
        );
        return null;
      }

      return path;
    } catch (e) {
      console.warn(`Exception offloading conversation history to ${path}:`, e);
      return null;
    }
  }

  /**
   * Create summary of messages.
   */
  async function createSummary(
    messages: BaseMessage[],
    chatModel: BaseChatModel,
  ): Promise<string> {
    // Trim messages if too long
    let messagesToSummarize = messages;
    const tokens = countTokensApproximately(messages);
    if (tokens > trimTokensToSummarize) {
      // Keep only recent messages that fit
      let kept = 0;
      const trimmedMessages: BaseMessage[] = [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = countTokensApproximately([messages[i]]);
        if (kept + msgTokens > trimTokensToSummarize) {
          break;
        }
        trimmedMessages.unshift(messages[i]);
        kept += msgTokens;
      }
      messagesToSummarize = trimmedMessages;
    }

    const conversation = getBufferString(messagesToSummarize);
    const prompt = summaryPrompt.replace("{conversation}", conversation);

    const response = await chatModel.invoke([
      new HumanMessage({ content: prompt }),
    ]);

    return typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);
  }

  /**
   * Build the summary message with file path reference.
   */
  function buildSummaryMessage(
    summary: string,
    filePath: string | null,
  ): HumanMessage {
    let content: string;
    if (filePath) {
      content = `You are in the middle of a conversation that has been summarized.

The full conversation history has been saved to ${filePath} should you need to refer back to it for details.

A condensed summary follows:

<summary>
${summary}
</summary>`;
    } else {
      content = `Here is a summary of the conversation to date:\n\n${summary}`;
    }

    return new HumanMessage({
      content,
      additional_kwargs: { lc_source: "summarization" },
    });
  }

  /**
   * Reconstruct the effective message list based on any previous summarization event.
   *
   * After summarization, instead of using all messages from state, we use the summary
   * message plus messages after the cutoff index. This avoids full state rewrites.
   */
  function getEffectiveMessages(
    messages: BaseMessage[],
    state: Record<string, unknown>,
  ): BaseMessage[] {
    const event = state._summarizationEvent as SummarizationEvent | undefined;

    // If no summarization event, return all messages as-is
    if (!event) {
      return messages;
    }

    // Build effective messages: summary message, then messages from cutoff onward.
    // Defensively skip orphaned ToolMessages at the cutoff boundary to
    // maintain API message structure integrity (tool_results need a
    // preceding tool_use in the assistant message).
    const startIdx = adjustCutoffForToolMessages(messages, event.cutoffIndex);

    const result: BaseMessage[] = [event.summaryMessage];
    result.push(...messages.slice(startIdx));

    return result;
  }

  return createMiddleware({
    name: "SummarizationMiddleware",
    stateSchema: SummarizationStateSchema,

    async wrapModelCall(request, handler) {
      // Get effective messages based on previous summarization events
      const effectiveMessages = getEffectiveMessages(
        request.messages ?? [],
        request.state,
      );

      if (effectiveMessages.length === 0) {
        return handler(request);
      }

      /**
       * Resolve the chat model and get max input tokens from profile
       */
      const resolvedModel = await getChatModel();
      const maxInputTokens = getMaxInputTokens(resolvedModel);

      /**
       * Step 1: Truncate args if configured.
       * Pass systemMessage and tools so the token count includes full request overhead.
       */
      const { messages: truncatedMessages } = truncateArgs(
          effectiveMessages,
          request.systemMessage,
          request.tools,
          maxInputTokens,
        );

      /**
       * Step 2: Check if summarization should happen.
       * Prepend systemMessage to the counted list (matches Python's approach)
       * and add tool schema overhead so the trigger fires before the full
       * request exceeds the model limit.
       */
      const countedMessages =
        request.systemMessage != null
          ? [request.systemMessage, ...truncatedMessages]
          : truncatedMessages;
      const toolsOverhead = estimateToolsOverhead(request.tools);
      const totalTokens =
        countTokensApproximately(countedMessages) + toolsOverhead;
      const shouldDoSummarization = shouldSummarize(
        truncatedMessages,
        totalTokens,
        maxInputTokens,
      );

      /**
       * If summarization is not needed, pass messages through.
       * Safety net: if estimated tokens still exceed maxInputTokens (e.g. a
       * single massive tool result jumped past the trigger in one step),
       * apply emergency truncation to prevent API errors.
       */
      if (!shouldDoSummarization) {
        if (maxInputTokens && totalTokens > maxInputTokens) {
          const fitted = emergencyTruncateMessages(
            truncatedMessages,
            request.systemMessage,
            maxInputTokens,
            toolsOverhead,
          );
          if (fitted) {
            console.warn(
              `[Summarization] no summarization triggered but tokens exceed limit — ` +
                `emergency-truncating (${truncatedMessages.length} msgs, ` +
                `~${totalTokens} estimated tok, limit: ${maxInputTokens})`,
            );
            return handler({ ...request, messages: fitted });
          }
        }
        return handler({ ...request, messages: truncatedMessages });
      }

      /**
       * Step 3: Perform summarization
       */
      const cutoffIndex = adjustCutoffForToolMessages(
        truncatedMessages,
        determineCutoffIndex(truncatedMessages, maxInputTokens),
      );
      if (cutoffIndex <= 0) {
        // Not enough messages to cut. Fall back to truncating oversized
        // individual messages (e.g., a single grep/read_file result that
        // consumed most of the context window).
        if (maxInputTokens) {
          const fitted = emergencyTruncateMessages(
            truncatedMessages,
            request.systemMessage,
            maxInputTokens,
            toolsOverhead,
          );
          if (fitted) {
            console.warn(
              `[Summarization] cutoffIndex=0, emergency-truncated oversized messages ` +
                `(${truncatedMessages.length} msgs, ~${totalTokens} estimated tok)`,
            );
            return handler({ ...request, messages: fitted });
          }
        }
        console.warn(
          `[Summarization] cutoffIndex=0, cannot reduce — ` +
            `${truncatedMessages.length} msgs, ~${totalTokens} estimated tok`,
        );
        return handler({ ...request, messages: truncatedMessages });
      }

      const messagesToSummarize = truncatedMessages.slice(0, cutoffIndex);
      const preservedMessages = truncatedMessages.slice(cutoffIndex);

      /**
       * Offload to backend first
       */
      const resolvedBackend = getBackend(request.state);
      const filePath = await offloadToBackend(
        resolvedBackend,
        messagesToSummarize,
        request.state,
      );

      if (filePath === null) {
        /**
         * Offloading failed - don't proceed with summarization
         */
        console.warn(
          `[Summarization] backend offload failed — skipping summarization`,
        );
        return handler({ ...request, messages: truncatedMessages });
      }

      /**
       * Generate summary
       */
      const summary = await createSummary(messagesToSummarize, resolvedModel);

      /**
       * Build summary message
       */
      const summaryMessage = buildSummaryMessage(summary, filePath);

      /**
       * Calculate state cutoff index for chained summarizations.
       * If this is a subsequent summarization, convert effective message index to state index.
       * The -1 accounts for the summary message at effective[0] which does not
       * correspond to any state message.
       *
       * When getEffectiveMessages skips orphaned ToolMessages at the boundary,
       * the effective-to-state mapping shifts. We compute the actual adjusted
       * start index to correctly map back to state positions.
       */
      const previousEvent = request.state._summarizationEvent;
      let stateCutoffIndex: number;
      if (previousEvent != null) {
        // Account for any ToolMessages skipped by getEffectiveMessages
        const adjustedStart = adjustCutoffForToolMessages(
          request.messages ?? [],
          previousEvent.cutoffIndex,
        );
        stateCutoffIndex = adjustedStart + cutoffIndex - 1;
      } else {
        stateCutoffIndex = cutoffIndex;
      }

      /**
       * Create new summarization event
       */
      const newEvent: SummarizationEvent = {
        cutoffIndex: stateCutoffIndex,
        summaryMessage,
        filePath,
      };

      /**
       * Call handler with summarized messages.
       *
       * Post-summarization safety: even after cutting messages, a single
       * oversized tool result in the preserved window can keep the total
       * above the model limit. Apply emergency truncation if needed.
       */
      let finalMessages: BaseMessage[] = [summaryMessage, ...preservedMessages];

      if (maxInputTokens) {
        const postSumCounted =
          request.systemMessage != null
            ? [request.systemMessage, ...finalMessages]
            : finalMessages;
        const postSumTokens =
          countTokensApproximately(postSumCounted) + toolsOverhead;

        if (postSumTokens > maxInputTokens) {
          const fitted = emergencyTruncateMessages(
            finalMessages,
            request.systemMessage,
            maxInputTokens,
            toolsOverhead,
          );
          if (fitted) {
            console.warn(
              `[Summarization] post-summarization still exceeds limit — ` +
                `emergency-truncating (${finalMessages.length} msgs, ` +
                `~${postSumTokens} tok, limit: ${maxInputTokens})`,
            );
            finalMessages = fitted;
          } else {
            console.warn(
              `[Summarization] post-summarization emergency truncation failed — ` +
                `${finalMessages.length} msgs, ~${postSumTokens} tok, ` +
                `limit: ${maxInputTokens}`,
            );
          }
        }
      }

      await handler({ ...request, messages: finalMessages });

      /**
       * Return Command with state update for the summarization event
       */
      return new Command({
        update: {
          _summarizationEvent: newEvent,
          _summarizationSessionId: getSessionId(request.state),
        },
      });
    },
  });
}
