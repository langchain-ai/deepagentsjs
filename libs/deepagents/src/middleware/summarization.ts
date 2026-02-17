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
  SystemMessage,
  BaseMessage,
  type AgentMiddleware as _AgentMiddleware,
} from "langchain";
import { getBufferString } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import { initChatModel } from "langchain/chat_models/universal";
import { Command } from "@langchain/langgraph";

import type { BackendProtocol, BackendFactory } from "../backends/protocol.js";
import type { StateBackend } from "../backends/state.js";
import type { BaseStore } from "@langchain/langgraph-checkpoint";

const LOG_PREFIX = "[SummarizationMiddleware]";

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
   * Can be a model string (e.g., "gpt-4o-mini") or a language model instance.
   */
  model: string | BaseChatModel | BaseLanguageModel;

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

// Fallback defaults when model has no profile
const FALLBACK_TRIGGER: ContextSize = { type: "tokens", value: 170_000 };
const FALLBACK_KEEP: ContextSize = { type: "messages", value: 6 };
const FALLBACK_TRUNCATE_ARGS: TruncateArgsSettings = {
  trigger: { type: "messages", value: 20 },
  keep: { type: "messages", value: 20 },
};

// Profile-based defaults (when model has max_input_tokens in profile)
const PROFILE_TRIGGER: ContextSize = { type: "fraction", value: 0.85 };
const PROFILE_KEEP: ContextSize = { type: "fraction", value: 0.1 };
const PROFILE_TRUNCATE_ARGS: TruncateArgsSettings = {
  trigger: { type: "fraction", value: 0.85 },
  keep: { type: "fraction", value: 0.1 },
};

/**
 * Compute summarization defaults based on model profile.
 * Mirrors Python's `_compute_summarization_defaults`.
 *
 * If the model has a profile with `maxInputTokens`, uses fraction-based
 * settings. Otherwise, uses fixed token/message counts.
 */
export function computeSummarizationDefaults(resolvedModel: BaseChatModel): {
  trigger: ContextSize;
  keep: ContextSize;
  truncateArgsSettings: TruncateArgsSettings;
} {
  const profile = resolvedModel.profile;
  const hasProfile =
    profile &&
    typeof profile === "object" &&
    "maxInputTokens" in profile &&
    typeof profile.maxInputTokens === "number";

  if (hasProfile) {
    return {
      trigger: PROFILE_TRIGGER,
      keep: PROFILE_KEEP,
      truncateArgsSettings: PROFILE_TRUNCATE_ARGS,
    };
  }

  return {
    trigger: FALLBACK_TRIGGER,
    keep: FALLBACK_KEEP,
    truncateArgsSettings: FALLBACK_TRUNCATE_ARGS,
  };
}
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
    summaryPrompt = DEFAULT_SUMMARY_PROMPT,
    trimTokensToSummarize = DEFAULT_TRIM_TOKEN_LIMIT,
    historyPathPrefix = "/conversation_history",
  } = options;

  // Mutable config that may be lazily computed from model profile.
  // When trigger/keep/truncateArgsSettings are not provided, they will be
  // computed from the model profile on first wrapModelCall, matching
  // Python's `_compute_summarization_defaults` behavior.
  let trigger = options.trigger;
  let keep: ContextSize = options.keep ?? {
    type: "messages",
    value: DEFAULT_MESSAGES_TO_KEEP,
  };
  let truncateArgsSettings = options.truncateArgsSettings;
  let defaultsComputed = trigger != null;

  // Parse truncate settings (will be re-parsed after defaults are computed)
  let truncateTrigger = truncateArgsSettings?.trigger;
  let truncateKeep: ContextSize = truncateArgsSettings?.keep ?? {
    type: "messages" as const,
    value: 20,
  };
  let maxArgLength = truncateArgsSettings?.maxLength ?? 2000;
  let truncationText =
    truncateArgsSettings?.truncationText ?? "...(argument truncated)";

  /**
   * Lazily compute defaults from model profile when trigger was not provided.
   * Called once when the model is first resolved.
   */
  function applyModelDefaults(resolvedModel: BaseChatModel): void {
    if (defaultsComputed) {
      return;
    }
    defaultsComputed = true;

    const defaults = computeSummarizationDefaults(resolvedModel);
    console.log(
      `${LOG_PREFIX} Auto-computed defaults from model profile: ` +
        `trigger=${JSON.stringify(defaults.trigger)}, ` +
        `keep=${JSON.stringify(defaults.keep)}, ` +
        `truncateArgs=${JSON.stringify(defaults.truncateArgsSettings)}`,
    );

    trigger = defaults.trigger;
    keep = options.keep ?? defaults.keep;

    if (!options.truncateArgsSettings) {
      truncateArgsSettings = defaults.truncateArgsSettings;
      truncateTrigger = defaults.truncateArgsSettings.trigger;
      truncateKeep = defaults.truncateArgsSettings.keep ?? {
        type: "messages" as const,
        value: 20,
      };
      maxArgLength = defaults.truncateArgsSettings.maxLength ?? 2000;
      truncationText =
        defaults.truncateArgsSettings.truncationText ??
        "...(argument truncated)";
    }
  }

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
      cachedModel = model as BaseChatModel;
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
   * Find a safe cutoff point that doesn't split AI/Tool message pairs.
   *
   * If the message at `cutoffIndex` is a ToolMessage, search backward for the
   * AIMessage containing the corresponding tool_calls and adjust the cutoff to
   * include it. This ensures tool call requests and responses stay together.
   *
   * Falls back to advancing forward past ToolMessage objects only if no matching
   * AIMessage is found (edge case).
   */
  function findSafeCutoffPoint(
    messages: BaseMessage[],
    cutoffIndex: number,
  ): number {
    if (
      cutoffIndex >= messages.length ||
      !ToolMessage.isInstance(messages[cutoffIndex])
    ) {
      return cutoffIndex;
    }

    // Collect tool_call_ids from consecutive ToolMessages at/after cutoff
    const toolCallIds = new Set<string>();
    let idx = cutoffIndex;
    while (idx < messages.length && ToolMessage.isInstance(messages[idx])) {
      const toolMsg = messages[idx] as InstanceType<typeof ToolMessage>;
      if (toolMsg.tool_call_id) {
        toolCallIds.add(toolMsg.tool_call_id);
      }
      idx++;
    }

    // Search backward for AIMessage with matching tool_calls
    for (let i = cutoffIndex - 1; i >= 0; i--) {
      const msg = messages[i];
      if (AIMessage.isInstance(msg) && msg.tool_calls) {
        const aiToolCallIds = new Set(
          msg.tool_calls
            .map((tc) => tc.id)
            .filter((id): id is string => id != null),
        );
        // Check if there's any overlap
        for (const id of toolCallIds) {
          if (aiToolCallIds.has(id)) {
            // Found the AIMessage - move cutoff to include it
            return i;
          }
        }
      }
    }

    // Fallback: no matching AIMessage found, advance past ToolMessages
    // to avoid orphaned tool responses
    return idx;
  }

  /**
   * Determine cutoff index for messages to summarize.
   * Messages at index < cutoff will be summarized.
   * Messages at index >= cutoff will be preserved.
   *
   * Uses findSafeCutoffPoint to ensure tool call/result pairs stay together.
   */
  function determineCutoffIndex(
    messages: BaseMessage[],
    maxInputTokens?: number,
  ): number {
    let rawCutoff: number;

    if (keep.type === "messages") {
      if (messages.length <= keep.value) {
        return 0;
      }
      rawCutoff = messages.length - keep.value;
    } else if (keep.type === "tokens" || keep.type === "fraction") {
      const targetTokenCount =
        keep.type === "fraction" && maxInputTokens
          ? Math.floor(maxInputTokens * keep.value)
          : keep.value;

      let tokensKept = 0;
      rawCutoff = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = countTokensApproximately([messages[i]]);
        if (tokensKept + msgTokens > targetTokenCount) {
          rawCutoff = i + 1;
          break;
        }
        tokensKept += msgTokens;
      }
    } else {
      return 0;
    }

    return findSafeCutoffPoint(messages, rawCutoff);
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
   * Uses findSafeCutoffPoint to ensure tool call/result pairs stay together.
   */
  function determineTruncateCutoffIndex(
    messages: BaseMessage[],
    maxInputTokens?: number,
  ): number {
    let rawCutoff: number;

    if (truncateKeep.type === "messages") {
      if (messages.length <= truncateKeep.value) {
        return messages.length;
      }
      rawCutoff = messages.length - truncateKeep.value;
    } else if (
      truncateKeep.type === "tokens" ||
      truncateKeep.type === "fraction"
    ) {
      const targetTokenCount =
        truncateKeep.type === "fraction" && maxInputTokens
          ? Math.floor(maxInputTokens * truncateKeep.value)
          : truncateKeep.value;

      let tokensKept = 0;
      rawCutoff = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msgTokens = countTokensApproximately([messages[i]]);
        if (tokensKept + msgTokens > targetTokenCount) {
          rawCutoff = i + 1;
          break;
        }
        tokensKept += msgTokens;
      }
    } else {
      return messages.length;
    }

    return findSafeCutoffPoint(messages, rawCutoff);
  }

  /**
   * Count tokens including system message and tools, matching Python's approach.
   * This gives a more accurate picture of what actually gets sent to the model.
   */
  function countTotalTokens(
    messages: BaseMessage[],
    systemMessage?: SystemMessage | unknown,
    tools?: (ServerTool | ClientTool)[] | unknown[],
  ): number {
    const countedMessages: BaseMessage[] =
      systemMessage && SystemMessage.isInstance(systemMessage)
        ? [systemMessage as SystemMessage, ...messages]
        : [...messages];

    const toolsArray =
      tools && Array.isArray(tools) && tools.length > 0
        ? (tools as Array<Record<string, unknown>>)
        : null;

    return countTokensApproximately(countedMessages, toolsArray);
  }

  /**
   * Truncate large tool arguments in old messages.
   */
  function truncateArgs(
    messages: BaseMessage[],
    maxInputTokens?: number,
    systemMessage?: SystemMessage | unknown,
    tools?: (ServerTool | ClientTool)[] | unknown[],
  ): { messages: BaseMessage[]; modified: boolean } {
    const totalTokens = countTotalTokens(messages, systemMessage, tools);
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

    // Build effective messages: summary message, then messages from cutoff onward
    const result: BaseMessage[] = [event.summaryMessage];
    result.push(...messages.slice(event.cutoffIndex));

    return result;
  }

  /**
   * Perform the summarization flow: offload, generate summary, return Command.
   * Extracted so it can be called both from the normal path and the overflow fallback.
   */
  async function performSummarization(
    request: {
      messages: BaseMessage[];
      state: Record<string, unknown>;
      systemMessage?: SystemMessage | unknown;
      tools?: (ServerTool | ClientTool)[] | unknown[];
      [key: string]: unknown;
    },
    handler: (req: any) => any,
    truncatedMessages: BaseMessage[],
    resolvedModel: BaseChatModel,
    maxInputTokens: number | undefined,
  ): Promise<any> {
    const cutoffIndex = determineCutoffIndex(truncatedMessages, maxInputTokens);
    if (cutoffIndex <= 0) {
      console.log(
        `${LOG_PREFIX} cutoffIndex=0, nothing to summarize (all messages within keep policy). Passing through.`,
      );
      return handler({ ...request, messages: truncatedMessages });
    }

    const messagesToSummarize = truncatedMessages.slice(0, cutoffIndex);
    const preservedMessages = truncatedMessages.slice(cutoffIndex);

    console.log(
      `${LOG_PREFIX} Summarizing: cutoffIndex=${cutoffIndex}, summarizing ${messagesToSummarize.length} messages, preserving ${preservedMessages.length} messages`,
    );

    const resolvedBackend = getBackend(request.state);
    const filePath = await offloadToBackend(
      resolvedBackend,
      messagesToSummarize,
      request.state,
    );

    if (filePath === null) {
      console.warn(
        `${LOG_PREFIX} Offloading conversation history to backend failed during summarization. Proceeding with summary generation anyway.`,
      );
    }

    const summary = await createSummary(messagesToSummarize, resolvedModel);
    const summaryMessage = buildSummaryMessage(summary, filePath);

    const previousEvent = request.state._summarizationEvent;
    const stateCutoffIndex =
      previousEvent != null
        ? (previousEvent as SummarizationEvent).cutoffIndex + cutoffIndex - 1
        : cutoffIndex;

    const newEvent: SummarizationEvent = {
      cutoffIndex: stateCutoffIndex,
      summaryMessage,
      filePath,
    };

    const modifiedMessages = [summaryMessage, ...preservedMessages];
    const modifiedTokens = countTotalTokens(
      modifiedMessages,
      request.systemMessage,
      request.tools,
    );
    console.log(
      `${LOG_PREFIX} After summarization: ${modifiedMessages.length} messages, ~${modifiedTokens} tokens (including system message + tools)`,
    );

    await handler({ ...request, messages: modifiedMessages });

    return new Command({
      update: {
        _summarizationEvent: newEvent,
        _summarizationSessionId: getSessionId(request.state),
      },
    });
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

      console.log(
        `${LOG_PREFIX} wrapModelCall: ${request.messages?.length ?? 0} raw messages, ${effectiveMessages.length} effective messages`,
      );

      if (effectiveMessages.length === 0) {
        console.log(`${LOG_PREFIX} No messages, passing through.`);
        return handler(request);
      }

      /**
       * Resolve the chat model and get max input tokens from profile.
       * Also compute defaults if trigger was not provided (lazy initialization
       * matching Python's _compute_summarization_defaults).
       */
      const resolvedModel = await getChatModel();
      applyModelDefaults(resolvedModel);
      const maxInputTokens = getMaxInputTokens(resolvedModel);
      console.log(
        `${LOG_PREFIX} Model profile: maxInputTokens=${maxInputTokens ?? "unknown"}`,
      );

      /**
       * Step 1: Truncate args if configured
       */
      const { messages: truncatedMessages, modified: argsWereTruncated } =
        truncateArgs(
          effectiveMessages,
          maxInputTokens,
          request.systemMessage,
          request.tools,
        );

      if (argsWereTruncated) {
        console.log(`${LOG_PREFIX} Tool arguments truncated in old messages.`);
      }

      /**
       * Step 2: Check if summarization should happen.
       * Count tokens including system message and tools to match what's
       * actually sent to the model (matching Python implementation).
       */
      const totalTokens = countTotalTokens(
        truncatedMessages,
        request.systemMessage,
        request.tools,
      );

      const shouldDoSummarization = shouldSummarize(
        truncatedMessages,
        totalTokens,
        maxInputTokens,
      );

      console.log(
        `${LOG_PREFIX} Token count: ~${totalTokens} tokens ` +
          `(${truncatedMessages.length} messages + system message + ${Array.isArray(request.tools) ? request.tools.length : 0} tools), ` +
          `trigger=${JSON.stringify(trigger)}, shouldSummarize=${shouldDoSummarization}`,
      );

      /**
       * If no summarization needed, try passing through.
       * If the handler throws a context overflow error, fall back to summarization.
       */
      if (!shouldDoSummarization) {
        try {
          return await handler({
            ...request,
            messages: truncatedMessages,
          });
        } catch (err: unknown) {
          // Check if this is a context overflow / prompt too long error
          const errMsg =
            err && typeof err === "object" && "message" in err
              ? String((err as { message: unknown }).message)
              : typeof err === "string"
                ? err
                : JSON.stringify(err);
          const isContextOverflow =
            /prompt.*(too long|too large)|token.*limit|context.*overflow|context.*length|maximum.*token|exceeds.*maximum/i.test(
              errMsg,
            );

          if (isContextOverflow) {
            console.warn(
              `${LOG_PREFIX} Context overflow detected after handler call (${totalTokens} tokens). ` +
                `Falling back to emergency summarization. Error: ${errMsg}`,
            );
            // Fall through to summarization below
          } else {
            throw err;
          }
        }
      }

      /**
       * Step 3: Perform summarization
       */
      return performSummarization(
        request as any,
        handler,
        truncatedMessages,
        resolvedModel,
        maxInputTokens,
      );
    },
  });
}
