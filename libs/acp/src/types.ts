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

  /**
   * Custom slash commands to advertise to the ACP client.
   * Merged with built-in commands (plan, agent, ask, clear, status).
   */
  commands?: Array<{
    name: string;
    description: string;
    input?: { hint: string };
  }>;
}

/**
 * Environment variable descriptor for env_var auth methods.
 *
 * @see https://agentclientprotocol.com/rfds/auth-methods
 */
export interface ACPAuthEnvVar {
  /** Environment variable name (e.g. "OPENAI_API_KEY") */
  name: string;
  /** Human-readable label shown in client UI */
  label?: string;
  /** Whether this value is a secret (default: true). Clients use password-style input for secrets. */
  secret?: boolean;
  /** Whether this variable is optional (default: false) */
  optional?: boolean;
}

/**
 * Agent-type auth method — the agent handles authentication itself.
 * This is the default type when no `type` is provided.
 */
export interface ACPAuthMethodAgent {
  id: string;
  name: string;
  type?: "agent";
  description?: string;
}

/**
 * Env-var auth method — credentials are passed as environment variables.
 * Clients can show input UI for each variable and restart the agent with them set.
 */
export interface ACPAuthMethodEnvVar {
  id: string;
  name: string;
  type: "env_var";
  /** URL where the user can obtain credentials */
  link?: string;
  /** Environment variables required for this auth method */
  vars: ACPAuthEnvVar[];
}

/**
 * Terminal auth method — requires an interactive terminal for login (e.g. TUI).
 * Only used when the client advertises `auth.terminal` capability.
 */
export interface ACPAuthMethodTerminal {
  id: string;
  name: string;
  type: "terminal";
  /** Additional arguments passed when running the agent binary for login */
  args?: string[];
  /** Additional environment variables set during the login invocation */
  env?: Record<string, string>;
}

/**
 * Union of all ACP authentication method types.
 *
 * Advertised in the `InitializeResponse` so clients know how to help
 * users authenticate with the agent.
 *
 * @see https://agentclientprotocol.com/rfds/auth-methods
 *
 * @example
 * ```typescript
 * const server = new DeepAgentsServer({
 *   agents: { name: "my-agent" },
 *   authMethods: [
 *     {
 *       id: "anthropic",
 *       name: "Anthropic API Key",
 *       type: "env_var",
 *       vars: [{ name: "ANTHROPIC_API_KEY" }],
 *       link: "https://console.anthropic.com/settings/keys",
 *     },
 *   ],
 * });
 * ```
 */
export type ACPAuthMethod =
  | ACPAuthMethodAgent
  | ACPAuthMethodEnvVar
  | ACPAuthMethodTerminal;

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

  /**
   * Authentication methods advertised to ACP clients during initialization.
   *
   * If not provided, defaults to env_var methods for common LLM provider
   * API keys (Anthropic, OpenAI) plus a generic agent-type fallback.
   *
   * @see https://agentclientprotocol.com/rfds/auth-methods
   */
  authMethods?: ACPAuthMethod[];
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

  /**
   * Cached permission decisions for tools (always-allow / always-reject)
   */
  permissionDecisions?: Map<string, "allow_always" | "reject_always">;
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
