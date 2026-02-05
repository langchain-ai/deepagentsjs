/**
 * Type definitions for the DeepAgents ACP Server
 *
 * This module provides TypeScript type definitions for integrating
 * DeepAgents with the Agent Client Protocol (ACP).
 */

import type { CreateDeepAgentParams } from "deepagents";

/**
 * Configuration for a DeepAgent exposed via ACP
 *
 * Extends CreateDeepAgentParams from deepagents with ACP-specific fields.
 * The `name` field is required for ACP session routing.
 */
export interface DeepAgentConfig extends CreateDeepAgentParams {
  /**
   * Unique name for this agent (required for ACP session routing)
   */
  name: string;

  /**
   * Human-readable description of the agent's capabilities
   * Shown to ACP clients when listing available agents
   */
  description?: string;
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
   * Enable debug logging to stderr
   */
  debug?: boolean;

  /**
   * Path to log file for persistent logging
   * Logs are written to this file regardless of debug flag, useful for production debugging
   */
  logFile?: string;

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
  status:
    | "pending"
    | "in_progress"
    | "completed"
    | "failed"
    | "cancelled"
    | "error";

  /**
   * Result content (if completed or error)
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
