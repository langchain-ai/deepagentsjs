/**
 * Type definitions for the DeepAgents ACP Server
 *
 * This module provides TypeScript type definitions for integrating
 * DeepAgents with the Agent Client Protocol (ACP).
 */

import type { BackendProtocol, BackendFactory } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

// Re-export middleware type for convenience
type AgentMiddleware = unknown;

// ResponseFormat placeholder (actual type comes from langchain)
type ResponseFormat = unknown;

// Checkpointer type alias
type Checkpointer = BaseCheckpointSaver;

/**
 * Configuration for a DeepAgent exposed via ACP
 */
export interface DeepAgentConfig {
  /**
   * Unique name for this agent (used in session routing)
   */
  name: string;

  /**
   * Human-readable description of the agent's capabilities
   */
  description?: string;

  /**
   * LLM model to use (default: "claude-sonnet-4-5-20250929")
   */
  model?: string;

  /**
   * Custom tools available to the agent
   */
  tools?: StructuredTool[];

  /**
   * Custom system prompt (combined with base prompt)
   */
  systemPrompt?: string;

  /**
   * Custom middleware array
   */
  middleware?: AgentMiddleware[];

  /**
   * Backend for filesystem operations
   * Can be an instance or a factory function
   */
  backend?: BackendProtocol | BackendFactory;

  /**
   * Array of skill source paths (SKILL.md files)
   */
  skills?: string[];

  /**
   * Array of memory source paths (AGENTS.md files)
   */
  memory?: string[];

  /**
   * Structured output format
   */
  responseFormat?: ResponseFormat;

  /**
   * State persistence checkpointer
   */
  checkpointer?: Checkpointer;
}

/**
 * Server configuration options
 */
export interface DeepAgentsServerOptions {
  /**
   * Agent configuration(s) - can be a single agent or multiple
   */
  agents: DeepAgentConfig | DeepAgentConfig[];

  /**
   * Server name for ACP initialization
   */
  serverName?: string;

  /**
   * Server version
   */
  serverVersion?: string;

  /**
   * Enable debug logging
   */
  debug?: boolean;

  /**
   * Workspace root directory (defaults to cwd)
   */
  workspaceRoot?: string;
}

/**
 * ACP Session state
 */
export interface SessionState {
  /**
   * Session ID
   */
  id: string;

  /**
   * Agent name for this session
   */
  agentName: string;

  /**
   * LangGraph thread ID for state persistence
   */
  threadId: string;

  /**
   * Conversation messages history
   */
  messages: unknown[];

  /**
   * Created timestamp
   */
  createdAt: Date;

  /**
   * Last activity timestamp
   */
  lastActivityAt: Date;

  /**
   * Current mode (if applicable)
   */
  mode?: string;
}

/**
 * Tool call tracking for ACP updates
 */
export interface ToolCallInfo {
  /**
   * Unique tool call ID
   */
  id: string;

  /**
   * Tool name
   */
  name: string;

  /**
   * Tool arguments
   */
  args: Record<string, unknown>;

  /**
   * Current status
   */
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";

  /**
   * Result content (if completed)
   */
  result?: unknown;

  /**
   * Error message (if failed)
   */
  error?: string;
}

/**
 * Plan entry for ACP agent plan updates
 */
export interface PlanEntry {
  /**
   * Plan entry content/description
   */
  content: string;

  /**
   * Priority level
   */
  priority?: "high" | "medium" | "low";

  /**
   * Current status
   */
  status: "pending" | "in_progress" | "completed" | "skipped";
}

/**
 * Stop reasons for ACP prompt responses
 */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

/**
 * ACP capability flags
 */
export interface ACPCapabilities {
  /**
   * File system read capability
   */
  fsReadTextFile?: boolean;

  /**
   * File system write capability
   */
  fsWriteTextFile?: boolean;

  /**
   * Terminal capability
   */
  terminal?: boolean;

  /**
   * Session loading capability
   */
  loadSession?: boolean;

  /**
   * Modes capability
   */
  modes?: boolean;

  /**
   * Commands capability
   */
  commands?: boolean;
}

/**
 * Events emitted by the server
 */
export interface ServerEvents {
  /**
   * Session created
   */
  sessionCreated: (session: SessionState) => void;

  /**
   * Session ended
   */
  sessionEnded: (sessionId: string) => void;

  /**
   * Prompt started
   */
  promptStarted: (sessionId: string, prompt: string) => void;

  /**
   * Prompt completed
   */
  promptCompleted: (sessionId: string, stopReason: StopReason) => void;

  /**
   * Tool call started
   */
  toolCallStarted: (sessionId: string, toolCall: ToolCallInfo) => void;

  /**
   * Tool call completed
   */
  toolCallCompleted: (sessionId: string, toolCall: ToolCallInfo) => void;

  /**
   * Error occurred
   */
  error: (error: Error) => void;
}
