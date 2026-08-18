import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import * as ls from "langsmith/vitest";

const EXPLORATION_TOOLS = new Set(["read_file", "grep", "glob", "ls"]);

export interface UsageTotals {
  freshInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  llmCalls: number;
  explorationToolCalls: number;
}

/**
 * Callback handler collecting raw provider usage (cache_read/cache_creation
 * shape, Anthropic-only — silently zero on other providers) and exploration
 * tool-call counts. Callbacks propagate through nested subagent runnables,
 * so this captures both the parent's and any forked subagent's calls in one
 * run — exactly the end-to-end cost we're comparing across modes.
 */
export class UsageCollector extends BaseCallbackHandler {
  name = `usage-collector-${Math.random().toString(36).slice(2)}`;

  totals: UsageTotals = {
    freshInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    llmCalls: 0,
    explorationToolCalls: 0,
  };

  async handleLLMEnd(output: LLMResult): Promise<void> {
    for (const batch of output.generations) {
      for (const generation of batch) {
        const message = (
          generation as {
            message?: { response_metadata?: Record<string, unknown> };
          }
        ).message;
        const usage = message?.response_metadata?.usage as
          | Record<string, number>
          | undefined;
        if (!usage) continue;

        this.totals.llmCalls += 1;
        this.totals.freshInputTokens += usage.input_tokens ?? 0;
        this.totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        this.totals.cacheCreationTokens +=
          usage.cache_creation_input_tokens ?? 0;
        this.totals.outputTokens += usage.output_tokens ?? 0;
      }
    }
  }

  async handleToolStart(
    _tool: unknown,
    _input: string,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    if (runName && EXPLORATION_TOOLS.has(runName)) {
      this.totals.explorationToolCalls += 1;
    }
  }
}

export function logUsageFeedback(totals: UsageTotals, latencyMs: number): void {
  const cacheEligible = totals.cacheReadTokens + totals.freshInputTokens;
  const cacheHitRate =
    cacheEligible > 0 ? totals.cacheReadTokens / cacheEligible : 0;

  ls.logFeedback({ key: "latency_ms", score: latencyMs });
  ls.logFeedback({ key: "fresh_input_tokens", score: totals.freshInputTokens });
  ls.logFeedback({ key: "cache_read_tokens", score: totals.cacheReadTokens });
  ls.logFeedback({
    key: "cache_creation_tokens",
    score: totals.cacheCreationTokens,
  });
  ls.logFeedback({ key: "output_tokens", score: totals.outputTokens });
  ls.logFeedback({ key: "cache_hit_rate", score: cacheHitRate });
  ls.logFeedback({
    key: "exploration_tool_calls",
    score: totals.explorationToolCalls,
  });
}
