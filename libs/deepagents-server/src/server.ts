/**
 * DeepAgents ACP Server Implementation
 *
 * This module provides an ACP (Agent Client Protocol) server that wraps
 * DeepAgents, enabling integration with IDEs like Zed, JetBrains, and others.
 *
 * @see https://agentclientprotocol.com
 * @see https://github.com/agentclientprotocol/typescript-sdk
 */

import {
  AgentSideConnection,
  ndJsonStream,
  type Agent,
  type ContentBlock,
} from "@agentclientprotocol/sdk";

import {
  createDeepAgent,
  FilesystemBackend,
  type BackendProtocol,
  type BackendFactory,
} from "deepagents";

import { HumanMessage, AIMessage, isAIMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";

import type {
  DeepAgentConfig,
  DeepAgentsServerOptions,
  SessionState,
  ToolCallInfo,
  StopReason,
  ACPCapabilities,
} from "./types.js";

import {
  acpPromptToHumanMessage,
  langChainMessageToACP,
  extractToolCalls,
  todosToPlanEntries,
  generateSessionId,
  getToolCallKind,
  formatToolCallTitle,
} from "./adapter.js";

// Type definitions for ACP requests/responses (SDK uses generic types)
type InitializeRequest = Record<string, unknown>;
type InitializeResponse = Record<string, unknown>;
type NewSessionRequest = Record<string, unknown>;
type NewSessionResponse = Record<string, unknown>;
type LoadSessionRequest = Record<string, unknown>;
type LoadSessionResponse = Record<string, unknown>;
type PromptRequest = Record<string, unknown>;
type PromptResponse = Record<string, unknown>;
type CancelNotification = Record<string, unknown>;
type SetSessionModeRequest = Record<string, unknown>;
type SetSessionModeResponse = Record<string, unknown>;
type AuthenticateRequest = Record<string, unknown>;
type AuthenticateResponse = Record<string, unknown>;
type SessionNotification = Record<string, unknown>;

/**
 * DeepAgents ACP Server
 *
 * Wraps DeepAgents with the Agent Client Protocol, enabling communication
 * with ACP clients like Zed, JetBrains IDEs, and other compatible tools.
 *
 * @example
 * ```typescript
 * import { DeepAgentsServer } from "deepagents-server";
 *
 * const server = new DeepAgentsServer({
 *   agents: {
 *     name: "coding-assistant",
 *     description: "AI coding assistant with filesystem access",
 *   },
 *   workspaceRoot: process.cwd(),
 * });
 *
 * await server.start();
 * ```
 */
export class DeepAgentsServer {
  private connection: AgentSideConnection | null = null;
  private agents: Map<string, ReturnType<typeof createDeepAgent>> = new Map();
  private agentConfigs: Map<string, DeepAgentConfig> = new Map();
  private sessions: Map<string, SessionState> = new Map();
  private checkpointer: MemorySaver;
  private clientCapabilities: ACPCapabilities = {};
  private isRunning = false;
  private currentPromptAbortController: AbortController | null = null;

  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly debug: boolean;
  private readonly workspaceRoot: string;

  constructor(options: DeepAgentsServerOptions) {
    this.serverName = options.serverName ?? "deepagents-server";
    this.serverVersion = options.serverVersion ?? "0.0.1";
    this.debug = options.debug ?? false;
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();

    // Shared checkpointer for session persistence
    this.checkpointer = new MemorySaver();

    // Initialize agent configurations
    const agentConfigs = Array.isArray(options.agents)
      ? options.agents
      : [options.agents];

    for (const config of agentConfigs) {
      this.agentConfigs.set(config.name, config);
    }

    this.log("Initialized with agents:", [...this.agentConfigs.keys()]);
  }

  /**
   * Start the ACP server and listen for connections
   *
   * Uses stdio transport by default (stdin/stdout)
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Server is already running");
    }

    // Set up process signal handlers for graceful shutdown
    const handleSignal = (signal: string) => {
      this.log(`Received ${signal}, shutting down...`);
      this.stop();
      process.exit(0);
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));

    // Handle uncaught errors
    process.on("uncaughtException", (err) => {
      this.log("Uncaught exception:", err);
      process.exit(1);
    });

    process.on("unhandledRejection", (reason) => {
      this.log("Unhandled rejection:", reason);
      // Don't exit - try to keep running
    });

    try {
      // Create the stdio stream for ACP communication
      // ndJsonStream signature: (output: WritableStream, input: ReadableStream)
      // output = where we write responses (stdout)
      // input = where we read requests from (stdin)
      const input = new ReadableStream<Uint8Array>({
        start: (controller) => {
          // Keep stdin open in raw mode for continuous reading
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          process.stdin.resume();

          process.stdin.on("data", (chunk: Buffer) => {
            try {
              controller.enqueue(new Uint8Array(chunk));
            } catch (err) {
              this.log("Error enqueueing data:", err);
            }
          });

          process.stdin.on("end", () => {
            this.log("stdin ended");
            try {
              controller.close();
            } catch {
              // Controller may already be closed
            }
          });

          process.stdin.on("error", (err) => {
            this.log("stdin error:", err);
            try {
              controller.error(err);
            } catch {
              // Controller may already be errored
            }
          });

          process.stdin.on("close", () => {
            this.log("stdin closed");
          });
        },
      });

      const output = new WritableStream<Uint8Array>({
        write: (chunk) => {
          return new Promise((resolve, reject) => {
            if (!process.stdout.writable) {
              this.log("stdout not writable, dropping message");
              resolve();
              return;
            }
            process.stdout.write(chunk, (err) => {
              if (err) {
                this.log("stdout write error:", err);
                reject(err);
              } else {
                resolve();
              }
            });
          });
        },
        close: () => {
          this.log("output stream closed");
        },
        abort: (reason) => {
          this.log("output stream aborted:", reason);
        },
      });

      // ndJsonStream(output, input) - output first, then input
      const stream = ndJsonStream(output, input);

      // Create the agent-side connection with our Agent implementation
      this.connection = new AgentSideConnection(
        (conn) => this.createAgentHandler(conn),
        stream,
      );

      this.isRunning = true;
      this.log("Server started, waiting for connections...");

      // Wait for the connection to close
      await this.connection.closed;

      this.isRunning = false;
      this.log("Server stopped");
    } catch (err) {
      this.log("Server error:", err);
      this.isRunning = false;
      throw err;
    }
  }

  /**
   * Stop the ACP server
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.connection = null;
    this.sessions.clear();
    this.log("Server stopped");
  }

  /**
   * Create the Agent handler for ACP
   */
  private createAgentHandler(conn: AgentSideConnection): Agent {
    return {
      initialize: (params) =>
        this.handleInitialize(params as InitializeRequest),
      authenticate: (params) =>
        this.handleAuthenticate(params as AuthenticateRequest),
      newSession: (params) =>
        this.handleNewSession(params as NewSessionRequest, conn),
      loadSession: (params) =>
        this.handleLoadSession(params as LoadSessionRequest, conn),
      prompt: (params) => this.handlePrompt(params as PromptRequest, conn),
      cancel: (params) => this.handleCancel(params as CancelNotification),
      setSessionMode: (params) =>
        this.handleSetSessionMode(params as SetSessionModeRequest),
    };
  }

  /**
   * Handle ACP initialize request
   */
  private async handleInitialize(
    params: InitializeRequest,
  ): Promise<InitializeResponse> {
    this.log(
      "Client connected:",
      params.clientName ?? "unknown",
      params.clientVersion ?? "unknown",
    );

    // Store client capabilities
    const capabilities = params.capabilities as
      | Record<string, unknown>
      | undefined;
    if (capabilities) {
      const fs = capabilities.fs as Record<string, boolean> | undefined;
      this.clientCapabilities = {
        fsReadTextFile: fs?.readTextFile ?? false,
        fsWriteTextFile: fs?.writeTextFile ?? false,
        terminal: capabilities.terminal !== undefined,
      };
    }

    return {
      serverName: this.serverName,
      serverVersion: this.serverVersion,
      protocolVersion: params.protocolVersion ?? "1.0",
      capabilities: {
        // We support session loading
        loadSession: true,
        // We support modes
        modes: true,
        // We support commands
        commands: true,
      },
      // Prompt capabilities - what content types we accept
      promptCapabilities: {
        text: true,
        images: true,
        resources: true,
      },
    };
  }

  /**
   * Handle ACP authenticate request (no-op for now)
   */
  private async handleAuthenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse | void> {
    // No authentication required
    return;
  }

  /**
   * Handle ACP session/new request
   */
  private async handleNewSession(
    params: NewSessionRequest,
    _conn: AgentSideConnection,
  ): Promise<NewSessionResponse> {
    const sessionId = generateSessionId();
    const threadId = crypto.randomUUID();

    // Default to first agent if not specified
    const configOptions = params.configOptions as
      | Record<string, unknown>
      | undefined;
    const agentName =
      (configOptions?.agent as string) ?? [...this.agentConfigs.keys()][0];

    if (!agentName || !this.agentConfigs.has(agentName)) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    // Create session state
    const session: SessionState = {
      id: sessionId,
      agentName,
      threadId,
      messages: [],
      createdAt: new Date(),
      lastActivityAt: new Date(),
      mode: params.mode as string | undefined,
    };

    this.sessions.set(sessionId, session);

    // Lazily create the agent if not already created
    if (!this.agents.has(agentName)) {
      this.createAgent(agentName);
    }

    this.log("Created session:", sessionId, "for agent:", agentName);

    return {
      sessionId,
      // Available modes for this agent
      availableModes: [
        {
          id: "agent",
          name: "Agent Mode",
          description: "Full autonomous agent",
        },
        {
          id: "plan",
          name: "Plan Mode",
          description: "Planning and discussion",
        },
        {
          id: "ask",
          name: "Ask Mode",
          description: "Q&A without file changes",
        },
      ],
      currentMode: (params.mode as string) ?? "agent",
      // Available slash commands
      availableCommands: [
        { name: "help", description: "Show available commands" },
        { name: "clear", description: "Clear conversation history" },
        { name: "status", description: "Show current task status" },
      ],
    };
  }

  /**
   * Handle ACP session/load request
   */
  private async handleLoadSession(
    params: LoadSessionRequest,
    _conn: AgentSideConnection,
  ): Promise<LoadSessionResponse> {
    const sessionId = params.sessionId as string;
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.lastActivityAt = new Date();

    return {
      sessionId: session.id,
      availableModes: [
        {
          id: "agent",
          name: "Agent Mode",
          description: "Full autonomous agent",
        },
        {
          id: "plan",
          name: "Plan Mode",
          description: "Planning and discussion",
        },
        {
          id: "ask",
          name: "Ask Mode",
          description: "Q&A without file changes",
        },
      ],
      currentMode: session.mode ?? "agent",
      availableCommands: [
        { name: "help", description: "Show available commands" },
        { name: "clear", description: "Clear conversation history" },
        { name: "status", description: "Show current task status" },
      ],
    };
  }

  /**
   * Handle ACP session/prompt request
   *
   * This is the main entry point for agent interactions
   */
  private async handlePrompt(
    params: PromptRequest,
    conn: AgentSideConnection,
  ): Promise<PromptResponse> {
    const sessionId = params.sessionId as string;
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const agent = this.agents.get(session.agentName);

    if (!agent) {
      throw new Error(`Agent not found: ${session.agentName}`);
    }

    session.lastActivityAt = new Date();

    // Create abort controller for cancellation
    this.currentPromptAbortController = new AbortController();

    try {
      // Convert ACP prompt to LangChain message
      const prompt = params.prompt as ContentBlock[];
      const humanMessage = acpPromptToHumanMessage(prompt);

      // Stream the agent response
      const stopReason = await this.streamAgentResponse(
        session,
        agent,
        humanMessage,
        conn,
      );

      return { stopReason };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return { stopReason: "cancelled" };
      }
      throw error;
    } finally {
      this.currentPromptAbortController = null;
    }
  }

  /**
   * Handle ACP session/cancel notification
   */
  private async handleCancel(params: CancelNotification): Promise<void> {
    this.log("Cancelling session:", params.sessionId);

    if (this.currentPromptAbortController) {
      this.currentPromptAbortController.abort();
    }
  }

  /**
   * Handle ACP session/set_mode request
   */
  private async handleSetSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    const sessionId = params.sessionId as string;
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.mode = params.mode as string;
    this.log("Set mode for session:", sessionId, "to:", params.mode);

    return;
  }

  /**
   * Stream agent response and send ACP updates
   */
  private async streamAgentResponse(
    session: SessionState,
    agent: ReturnType<typeof createDeepAgent>,
    humanMessage: HumanMessage,
    conn: AgentSideConnection,
  ): Promise<StopReason> {
    const config = {
      configurable: { thread_id: session.threadId },
      signal: this.currentPromptAbortController?.signal,
    };

    // Track active tool calls
    const activeToolCalls = new Map<string, ToolCallInfo>();

    // Stream the agent
    const stream = await agent.stream({ messages: [humanMessage] }, config);

    for await (const event of stream) {
      // Check for cancellation
      if (this.currentPromptAbortController?.signal.aborted) {
        // Cancel all active tool calls
        for (const toolCall of activeToolCalls.values()) {
          await this.sendToolCallUpdate(session.id, conn, {
            ...toolCall,
            status: "cancelled",
          });
        }
        return "cancelled";
      }

      // Handle different event types
      if (event.messages && Array.isArray(event.messages)) {
        for (const message of event.messages) {
          if (isAIMessage(message)) {
            await this.handleAIMessage(
              session,
              message as AIMessage,
              activeToolCalls,
              conn,
            );
          }
        }
      }

      // Handle todo list updates (plan entries)
      if (event.todos && Array.isArray(event.todos)) {
        const planEntries = todosToPlanEntries(event.todos);
        await this.sendPlanUpdate(session.id, conn, planEntries);
      }
    }

    return "end_turn";
  }

  /**
   * Handle an AI message from the agent
   */
  private async handleAIMessage(
    session: SessionState,
    message: AIMessage,
    activeToolCalls: Map<string, ToolCallInfo>,
    conn: AgentSideConnection,
  ): Promise<void> {
    // Handle text content
    if (message.content && typeof message.content === "string") {
      const contentBlocks = langChainMessageToACP(message);
      await this.sendMessageChunk(session.id, conn, "agent", contentBlocks);
    }

    // Handle tool calls
    const toolCalls = extractToolCalls(message);

    for (const toolCall of toolCalls) {
      // Send tool call notification
      await this.sendToolCall(session.id, conn, toolCall);
      activeToolCalls.set(toolCall.id, toolCall);

      // Update to in_progress
      toolCall.status = "in_progress";
      await this.sendToolCallUpdate(session.id, conn, toolCall);
    }
  }

  /**
   * Send a message chunk update to the client
   */
  private async sendMessageChunk(
    sessionId: string,
    conn: AgentSideConnection,
    messageType: "agent" | "user" | "thought",
    content: ContentBlock[],
  ): Promise<void> {
    const sessionUpdate =
      messageType === "thought"
        ? "thought_message_chunk"
        : messageType === "user"
          ? "user_message_chunk"
          : "agent_message_chunk";

    await conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate,
        content: content[0], // ACP expects single content block per chunk
      },
    } as SessionNotification);
  }

  /**
   * Send a tool call notification to the client
   */
  private async sendToolCall(
    sessionId: string,
    conn: AgentSideConnection,
    toolCall: ToolCallInfo,
  ): Promise<void> {
    await conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: toolCall.id,
        title: formatToolCallTitle(toolCall.name, toolCall.args),
        kind: getToolCallKind(toolCall.name),
        status: toolCall.status,
      },
    } as SessionNotification);
  }

  /**
   * Send a tool call update to the client
   */
  private async sendToolCallUpdate(
    sessionId: string,
    conn: AgentSideConnection,
    toolCall: ToolCallInfo,
  ): Promise<void> {
    const update: Record<string, unknown> = {
      sessionUpdate: "tool_call_update",
      toolCallId: toolCall.id,
      status: toolCall.status,
    };

    // Add content if completed
    if (toolCall.status === "completed" && toolCall.result) {
      update.content = [
        {
          type: "content",
          content: {
            type: "text",
            text:
              typeof toolCall.result === "string"
                ? toolCall.result
                : JSON.stringify(toolCall.result, null, 2),
          },
        },
      ];
    }

    await conn.sessionUpdate({
      sessionId,
      update,
    } as SessionNotification);
  }

  /**
   * Send a plan update to the client
   */
  private async sendPlanUpdate(
    sessionId: string,
    conn: AgentSideConnection,
    entries: Array<{
      content: string;
      priority?: "high" | "medium" | "low";
      status: "pending" | "in_progress" | "completed" | "skipped";
    }>,
  ): Promise<void> {
    await conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "plan",
        entries,
      },
    } as SessionNotification);
  }

  /**
   * Create a DeepAgent instance for the given configuration
   */
  private createAgent(agentName: string): void {
    const config = this.agentConfigs.get(agentName);

    if (!config) {
      throw new Error(`Agent configuration not found: ${agentName}`);
    }

    // Create backend - prefer ACP filesystem if client supports it
    const backend = this.createBackend(config);

    const agent = createDeepAgent({
      model: config.model,
      tools: config.tools,
      systemPrompt: config.systemPrompt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      middleware: config.middleware as any,
      backend,
      skills: config.skills,
      memory: config.memory,
      checkpointer: this.checkpointer,
      name: config.name,
    });

    this.agents.set(agentName, agent);
    this.log("Created agent:", agentName);
  }

  /**
   * Create the appropriate backend for the agent
   */
  private createBackend(
    config: DeepAgentConfig,
  ): BackendProtocol | BackendFactory {
    // If a custom backend is provided, use it
    if (config.backend) {
      return config.backend;
    }

    // If client supports file operations, we could create an ACP-backed filesystem
    // For now, default to FilesystemBackend with workspace root
    if (
      this.clientCapabilities.fsReadTextFile &&
      this.clientCapabilities.fsWriteTextFile
    ) {
      // TODO: Implement ACPFilesystemBackend that proxies to client
      this.log("Client supports filesystem, using local backend");
    }

    return new FilesystemBackend({
      rootDir: this.workspaceRoot,
    });
  }

  /**
   * Read a file through the ACP client (if supported)
   */
  async readFileViaClient(path: string): Promise<string | null> {
    if (!this.connection || !this.clientCapabilities.fsReadTextFile) {
      return null;
    }

    try {
      const result = await this.connection.readTextFile({ path });
      return result.text;
    } catch {
      return null;
    }
  }

  /**
   * Write a file through the ACP client (if supported)
   */
  async writeFileViaClient(path: string, content: string): Promise<boolean> {
    if (!this.connection || !this.clientCapabilities.fsWriteTextFile) {
      return false;
    }

    try {
      await this.connection.writeTextFile({ path, text: content });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Log a debug message
   */
  private log(...args: unknown[]): void {
    if (this.debug) {
      console.error("[deepagents-server]", ...args);
    }
  }
}

/**
 * Create and start a DeepAgents ACP server
 *
 * Convenience function for quick server setup
 *
 * @example
 * ```typescript
 * import { startServer } from "deepagents-server";
 *
 * await startServer({
 *   agents: {
 *     name: "my-agent",
 *     description: "My coding assistant",
 *   },
 * });
 * ```
 */
export async function startServer(
  options: DeepAgentsServerOptions,
): Promise<DeepAgentsServer> {
  const server = new DeepAgentsServer(options);
  await server.start();
  return server;
}
