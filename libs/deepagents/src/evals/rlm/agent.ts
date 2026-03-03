/**
 * RLM agent factory for OOLONG eval.
 *
 * Creates a deepagent configured for the RLM pattern:
 * - QuickJS REPL middleware with PTC (programmatic tool calling)
 * - General-purpose subagent (Haiku) for sub-LLM queries
 * - Increased timeouts and memory for 131K context processing
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { createQuickJSMiddleware } from "@langchain/quickjs";
import {
  createDeepAgent,
  KVBackend,
  createFileData,
  GENERAL_PURPOSE_SUBAGENT,
} from "../../index.js";
import { RLM_COORDINATOR_PROMPT } from "./prompts.js";

export interface RlmAgentOptions {
  /** Model for the coordinator agent. @default "claude-opus-4-6" */
  model?: string;
  /** Model for the subagent. @default "claude-haiku-4-5-20251001" */
  subagentModel?: string;
  /** Execution timeout per js_eval call in ms. @default 300_000 (5 min) */
  executionTimeoutMs?: number;
  /** Memory limit for QuickJS in bytes. @default 104857600 (100MB) */
  memoryLimitBytes?: number;
  /** Files to seed into the REPL's VFS. */
  files?: Record<string, string>;
}

/**
 * Create an agent configured for the RLM pattern on OOLONG tasks.
 *
 * Uses the standard general-purpose subagent with a Haiku model for
 * cost-efficient worker tasks. Strategy (chunking, classification,
 * aggregation) is discovered by the model.
 *
 * A new agent must be created per task since the KVBackend is seeded
 * with task-specific files at construction time.
 */
export function createRlmAgent(options: RlmAgentOptions = {}) {
  const {
    model = "claude-opus-4-6",
    subagentModel = "claude-haiku-4-5-20251001",
    executionTimeoutMs = 300_000,
    memoryLimitBytes = 100 * 1024 * 1024,
    files = {},
  } = options;

  const kvFiles = Object.fromEntries(
    Object.entries(files).map(([k, v]) => [k, createFileData(v)]),
  );

  // Single KVBackend shared between the REPL and subagents so that
  // files written via writeFile() in the REPL are visible to subagents.
  const sharedBackend = new KVBackend(kvFiles);

  return createDeepAgent({
    model: new ChatAnthropic({ model }),
    systemPrompt: RLM_COORDINATOR_PROMPT,
    backend: sharedBackend,
    subagents: [
      {
        ...GENERAL_PURPOSE_SUBAGENT,
        model: new ChatAnthropic({ model: subagentModel }),
      },
    ],
    middleware: [
      createQuickJSMiddleware({
        backend: sharedBackend,
        ptc: ["task"],
        executionTimeoutMs,
        memoryLimitBytes,
      }),
    ],
  });
}
